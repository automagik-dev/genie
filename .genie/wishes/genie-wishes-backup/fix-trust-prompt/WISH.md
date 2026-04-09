# Wish: Auto-Dismiss Claude Code Workspace Trust Prompt

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-trust-prompt` |
| **Date** | 2026-03-22 |
| **Design** | N/A — operational pain point |

## Summary

When genie spawns Claude Code in a new worktree (or any fresh directory), CC always shows the "Do you trust this folder?" interactive prompt. Since `--dangerously-skip-permissions` doesn't bypass it, agents get stuck until someone manually sends Enter. This wish adds automatic trust prompt dismissal to the genie spawn pipeline.

## Scope

### IN
- Auto-dismiss the trust prompt when launching CC via `genie team create` and `genie spawn`
- Pre-create `~/.claude/projects/<encoded-path>/` directory before launch (primary strategy)
- Add a timed fallback: auto-send Enter via tmux after a short delay (safety net)
- Cover both `team-auto-spawn.ts` (team create) and `provider-adapters.ts` / tmux launch paths

### OUT
- Changes to Claude Code itself (upstream CC fix)
- Modifying `~/.claude/settings.json` structure
- Any workaround that involves `--bare` mode (would lose plugins, hooks, CLAUDE.md)
- Changing the CC binary or patching it

## Decisions

| Decision | Rationale |
|----------|-----------|
| Pre-create project directory as primary fix | CC likely checks for `~/.claude/projects/<path>/` existence to determine if a workspace is known. Creating it preemptively costs nothing and is idempotent. |
| Auto-send Enter as fallback | If the project dir trick doesn't work, the Enter keystroke dismisses the prompt. 3-second delay is conservative enough to not interfere with CC startup. |
| Path encoding: replace `/` with `-`, strip leading `-` | This matches CC's existing convention (e.g., `/home/genie/agents/...` → `-home-genie-agents-...`) |
| Apply to both spawn pathways | `team-auto-spawn.ts` (team create) and `provider-adapters.ts`/tmux spawn (genie spawn) both launch CC in new directories |

## Success Criteria

- [ ] `genie team create` in a fresh worktree starts CC without showing trust prompt (or auto-dismisses it)
- [ ] `genie spawn` in a fresh directory starts CC without getting stuck
- [ ] Existing spawn behavior for already-trusted directories is unchanged
- [ ] No new dependencies introduced
- [ ] Tests pass

## Execution Strategy

### Wave 1 (sequential)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Implement pre-create project dir + auto-Enter fallback |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | reviewer | Review implementation for correctness and edge cases |

## Execution Groups

### Group 1: Implement Trust Prompt Auto-Dismiss

**Goal:** Add trust prompt handling to the genie spawn pipeline so agents never get stuck.

**Deliverables:**

1. **Utility function `ensureCCProjectDir(workingDir: string)`** — encodes the worktree path into CC's project key format and creates `~/.claude/projects/<key>/` if it doesn't exist. This goes in a shared utility (e.g., `src/lib/cc-trust.ts` or inline in existing modules).

   Path encoding logic (match CC's convention):
   ```
   /home/genie/.genie/worktrees/genie/v3-release
   → -home-genie-.genie-worktrees-genie-v3-release
   ```
   Rule: replace all `/` with `-`, then strip any leading `-` that results from the root `/`.

   Wait — check the actual convention by examining existing project dirs first. The convention appears to be: absolute path with `/` replaced by `-`.

2. **Call `ensureCCProjectDir(workingDir)` before launching CC** in:
   - `src/lib/team-auto-spawn.ts` — before the `send-keys` that launches the claude command
   - The tmux spawn path in session.ts / provider pipeline — wherever `genie spawn` launches CC

3. **Fallback: auto-send Enter 3s after launch** — in `team-auto-spawn.ts`, after sending the claude launch command, add:
   ```typescript
   // Auto-dismiss trust prompt if it appears (fallback)
   setTimeout(async () => {
     await tmux.executeTmux(`send-keys -t ${shellQuote(target)} Enter`);
   }, 3000);
   ```
   This is idempotent — sending Enter to an already-running CC session just creates a blank line in the prompt.

**Acceptance Criteria:**
- [ ] `ensureCCProjectDir` creates the directory with correct path encoding
- [ ] Function is called before CC launch in team-auto-spawn.ts
- [ ] Function is called before CC launch in the spawn path
- [ ] Fallback Enter is sent after 3s delay
- [ ] No regression in normal (non-worktree) spawn paths
- [ ] Build passes

**Validation:**
```bash
bun run build
bun run test
# Manual: genie team create test-trust --repo /tmp/test-repo
```

**depends-on:** none

---

### Group 2: Review

**Goal:** Verify the fix handles edge cases and doesn't introduce regressions.

**Acceptance Criteria:**
- [ ] Path encoding matches CC's actual convention (verified against `~/.claude/projects/`)
- [ ] No race conditions in the setTimeout fallback
- [ ] Idempotent — safe to run multiple times on same directory
- [ ] No security concerns (not creating dirs with wrong permissions)

**Validation:**
```bash
ls ~/.claude/projects/ | head -5  # Compare encoding convention
```

**depends-on:** Group 1

---

## QA Criteria

- [ ] Fresh worktree launch doesn't get stuck at trust prompt
- [ ] Existing directory launches still work normally
- [ ] `~/.claude/projects/<key>/` directory is created with correct encoding
- [ ] Build and tests pass

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| CC may use a different signal than dir existence for trust | Medium | Fallback Enter dismissal covers this case |
| 3s delay may be too short on slow machines | Low | Can be made configurable; 3s is conservative for typical hardware |
| Sending Enter to an already-running session | Low | Idempotent — just creates a blank prompt entry |
| CC changes its project dir encoding in a future version | Low | The encoding logic is simple; can adapt if convention changes |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/lib/cc-trust.ts              (NEW — ensureCCProjectDir utility)
src/lib/team-auto-spawn.ts       (call ensureCCProjectDir + auto-Enter fallback)
src/lib/session.ts               (call ensureCCProjectDir in spawn path, if applicable)
```
