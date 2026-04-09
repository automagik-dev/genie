# Wish: Fix session continuation — fall back to new session when `--continue` fails

| Field | Value |
|-------|-------|
| **Status** | DONE |
| **Slug** | `fix-session-continue-fallback` |
| **Date** | 2026-03-18 |
| **Design** | N/A (bug fix — diagnostic below) |

## Summary

Running `genie` (bare command) fails with "No conversation found to continue" because the CLI unconditionally passes `--continue <name>` even when no prior Claude Code conversation exists. Two code paths in `session.ts` are broken: (1) inside-tmux always generates a random suffix guaranteeing `--continue` never matches, and (2) focusTeamWindow skips relaunching Claude Code when the tmux window exists but the process has exited.

## Scope

### IN
- Fix inside-tmux path to not pass `--continue` with a random-suffixed name
- Fix focusTeamWindow to detect dead panes and relaunch Claude Code
- Graceful fallback: try `--continue`, if conversation missing start fresh
- Test coverage for both fixed paths

### OUT
- Changes to `team-lead-command.ts` (command builder is correct, callers are wrong)
- Changes to Claude Code's `--continue` behavior itself
- Refactoring session.ts beyond the two bug fixes
- Changes to tmux.ts (use existing helpers only)

## Diagnostic

### Bug 1: Inside-tmux path (session.ts lines 285-294)

**Reproduction:** Run `genie` from inside an existing tmux session.

**Flow:**
1. Code generates random suffix: `Date.now().toString(36).slice(-4)` -> e.g. `cd4z`
2. Window name becomes `paperclip-pm-cd4z` (unique every time)
3. `continueName = sanitizeTeamName('paperclip-pm-cd4z')`
4. Command includes `--continue 'paperclip-pm-cd4z'`
5. Claude Code fails: "No conversation found to continue"

**Root cause:** `--continue` is passed with a name that has a fresh random suffix — no conversation can ever exist with that name.

**Error output:**
```
No conversation found to continue
Error: Command failed: CLAUDECODE=1 ... claude ... --continue 'paperclip-pm-cd4z' ...
```

### Bug 2: focusTeamWindow dead-pane reattach (session.ts lines 196-227)

**Reproduction:** Run `genie` outside tmux when tmux session+window exist but Claude Code has exited.

**Flow:**
1. `ensureTeamWindow()` returns `{ created: false }` (window already exists)
2. `if (teamWindow.created)` block is skipped entirely (lines 204-224)
3. Only `select-window` runs (line 225) — no Claude Code is launched
4. User attaches to a dead pane with just a shell prompt

**Root cause:** No `else` branch handles the case where the window exists but Claude Code is not running.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Remove `--continue` from inside-tmux path entirely | Random suffix makes it impossible to match — this is always a fresh session |
| Detect dead pane via `pane_current_command` | tmux provides `#{pane_current_command}` — if it shows `bash`/`zsh`/`sh` instead of `claude` or `node`, CC has exited |
| Try `--continue` first on relaunch, fall back to fresh | Preserves conversation history when possible; gracefully handles missing conversations |
| Use `execSync` try/catch for fallback | The inside-tmux path already uses `execSync` — same pattern, wrap in try/catch |

## Success Criteria

- [ ] `genie` from inside tmux starts a fresh CC session without "No conversation found" error
- [ ] `genie` outside tmux with dead pane relaunches CC (tries continue, falls back to fresh)
- [ ] `genie` outside tmux with live CC session reattaches without relaunching (no change)
- [ ] `genie` with no prior session creates a new session (no change — existing behavior)
- [ ] All existing tests in `session.test.ts` pass
- [ ] New tests cover: inside-tmux no-continue, dead-pane relaunch, relaunch-fallback

## Execution Strategy

### Wave 1 (sequential — both bugs in same file, tightly coupled)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Fix both bugs in session.ts + add tests |
| review | reviewer | Review the fix for correctness and edge cases |

## Execution Groups

### Group 1: Fix session continuation bugs

**Goal:** Make `genie` reliably start or resume Claude Code sessions across all entry paths.

**Deliverables:**

1. **Fix inside-tmux path (lines 285-294):** Remove `continueName` — pass `undefined` to `buildClaudeCommand` since the random suffix guarantees no prior conversation.

   Change:
   ```typescript
   const continueName = sanitizeTeamName(currentWindowName);
   const cmd = buildClaudeCommand(currentWindowName, systemPromptFile || undefined, continueName);
   ```
   To:
   ```typescript
   // Fresh session — random suffix means no prior conversation to continue
   const cmd = buildClaudeCommand(currentWindowName, systemPromptFile || undefined, undefined);
   ```
   Also clean up the now-unused `continueName` variable (delete line 291 entirely).

2. **Fix focusTeamWindow dead-pane relaunch (lines 196-227):** Add `else` branch after the `if (teamWindow.created)` block:

   ```typescript
   } else {
     // Window exists — check if Claude Code is still running
     const target = `${sessionName}:${windowName}`;
     const currentCmd = (await tmux.executeTmux(
       `display -t ${shellQuote(target)} -p '#{pane_current_command}'`
     )).trim();

     const isShell = ['bash', 'zsh', 'sh', 'fish'].includes(currentCmd);
     if (isShell) {
       // Claude Code has exited — relaunch
       console.log(`Claude Code not running in "${windowName}", relaunching...`);
       const continueName = sanitizeTeamName(windowName);
       await ensureNativeTeamForLeader(windowName, workingDir);

       const cdCmd = `cd ${shellQuote(workingDir)}`;
       await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);

       // Try --continue first (preserves conversation history)
       const continueCmd = buildClaudeCommand(windowName, systemPromptFile || undefined, continueName);
       const freshCmd = buildClaudeCommand(windowName, systemPromptFile || undefined, undefined);

       // Send continue command; if it fails CC prints error and returns to shell
       // We detect failure and retry fresh
       await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(continueCmd)} Enter`);

       // Wait briefly then check if CC is running or fell back to shell
       await new Promise(r => setTimeout(r, 3000));
       const afterCmd = (await tmux.executeTmux(
         `display -t ${shellQuote(target)} -p '#{pane_current_command}'`
       )).trim();

       if (['bash', 'zsh', 'sh', 'fish'].includes(afterCmd)) {
         // --continue failed, start fresh
         console.log(`No prior conversation found, starting fresh session...`);
         await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(freshCmd)} Enter`);
       }

       await registerSessionInRegistry(sessionName, windowName, workingDir);
     }
     // else: Claude Code is still running — just select the window (line 225 handles it)
   }
   ```

3. **Tests:** Add test cases in `session.test.ts`:
   - `buildClaudeCommand` with `undefined` continueName does NOT include `--continue`
   - Verify the inside-tmux path logic (unit test the command construction)

**Acceptance Criteria:**
- [ ] Inside-tmux `buildClaudeCommand` call passes `undefined` as continueName
- [ ] focusTeamWindow has an else branch that detects dead panes
- [ ] Dead pane relaunch tries `--continue` then falls back to fresh
- [ ] Existing tests still pass

**Validation:**
```bash
cd /home/genie/agents/namastexlabs/genie/repos/genie && npx vitest run src/genie-commands/__tests__/session.test.ts
```

**depends-on:** none

---

## QA Criteria

- [ ] `genie` from inside tmux starts CC without "No conversation found" error
- [ ] `genie` from outside tmux with dead pane relaunches CC successfully
- [ ] `genie` from outside tmux with live CC session reattaches without disruption
- [ ] `genie` with no prior tmux session creates new session as before
- [ ] `genie --reset` still works as before

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `pane_current_command` may vary across OS/tmux versions | Low | Check for common shells (`bash`, `zsh`, `sh`, `fish`) rather than checking for `claude`/`node` |
| 3-second wait for `--continue` failure detection may be fragile | Medium | Could be made configurable; 3s is conservative — CC fails fast on missing conversation |
| Race condition if user types in pane during relaunch | Low | Unlikely in practice — pane is managed by genie, not user-interactive during startup |

---

## Review Results

### Plan Review — 2026-03-18

**Verdict: SHIP**

All checklist items pass. One MEDIUM gap identified:

| # | Severity | Gap | Fix |
|---|----------|-----|-----|
| 1 | MEDIUM | `focusTeamWindow` `created = true` path (line 216-218) also passes `--continue` without fallback. First-time run for a new directory in an existing session fails if no prior conversation. | Apply the same continue-then-fallback pattern to BOTH the `created = true` AND the new `else` branch. Extract a helper like `launchWithContinueFallback()` to avoid duplicating retry logic. |
| 2 | LOW | 3-second sleep is acknowledged as fragile but acceptable — CC fails fast on missing conversations. | Keep 3s, add comment explaining timing assumption. |

---

## Files to Create/Modify

```
src/genie-commands/session.ts          — fix both bugs
src/genie-commands/__tests__/session.test.ts — add test coverage
```
