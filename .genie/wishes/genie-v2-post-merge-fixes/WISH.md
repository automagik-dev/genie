# Wish: Genie v2 — Post-Merge Fixes

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `genie-v2-post-merge-fixes` |
| **Date** | 2026-03-14 |
| **Parent** | [genie-v2-framework-redesign](../genie-v2-framework-redesign/WISH.md) |
| **Issues** | [#540](https://github.com/automagik-dev/genie/issues/540), [#541](https://github.com/automagik-dev/genie/issues/541) |
| **Design** | [DRAFT.md](../../brainstorms/agent-directory/DRAFT.md) — Command Tree v2 section |

## Summary

Fix critical regressions from the v2 framework redesign merge. The `genie` default entry point (session-per-folder) was accidentally removed when `session.ts` was gutted during the `_open` cleanup. The README CLI Reference is massively outdated. Three tmux helper functions (`getWindowEnv`, `setWindowEnv`, `killSession`) were removed from `tmux.ts` but are required by the session flow. The genie orchestration plugin rules (`~/.claude/rules/genie-orchestration.md`) still reference `genie agent spawn` which no longer exists.

## Scope

### IN

- Restore `genie` (no args) default session-per-folder behavior
- Restore 3 removed tmux functions: `getWindowEnv`, `setWindowEnv`, `killSession`
- Restore session management functions: `sessionCommand`, `createSession`, `focusTeamWindow`, `resolveWindowName`, `attachToWindow`, `handleReset`, `deriveWindowName`, `findLastSessionId`, `ensureNativeTeamForLeader`
- Wire default command in `genie.ts` so `genie` (no args) launches session
- Rewrite README CLI Reference to match v2 command tree from DRAFT.md
- Replace "Worker Profiles" config section with "Agent Directory" in README

### OUT

- New features beyond what the v2 WISH defines
- Changes to the session-per-folder architecture itself (restore it as-was)
- Updating `~/.claude/rules/genie-orchestration.md` (plugin-managed file, agents cannot modify per agent-bible rule 3)
- Changes to docs/CO-ORCHESTRATION-GUIDE.md (separate effort)
- Fixing `genie spawn` to allow multiple instances of same role (separate wish)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Cherry-pick session functions from `ffb486ca~1` | The commit `ffb486ca` removed them. The parent commit has the correct, tested code. |
| Restore tmux helpers from same commit | `getWindowEnv`, `setWindowEnv`, `killSession` were removed in the same cleanup wave. Session flow requires all three. |
| Use `program.action()` for default command | Commander.js supports a default action when no subcommand matches. This doesn't conflict with `--session` pre-parse because the pre-parse intercepts before `program.parse()`. |
| README source of truth = DRAFT.md Command Tree v2 | The brainstorm DRAFT.md has the definitive command tree that was approved. Use that, not `genie --help` alone (help may have bugs). |

## Success Criteria

- [ ] `genie` (no args) from any folder creates/attaches a tmux session with Claude Code running as team-lead
- [ ] `genie` from a folder with AGENTS.md injects the system prompt
- [ ] `genie` from a folder already running attaches to the existing window
- [ ] `genie --reset` kills and recreates the session
- [ ] `genie --session mywork` still works (start new / resume existing)
- [ ] README CLI Reference matches DRAFT.md Command Tree v2 — zero stale commands
- [ ] README has no references to: daemon, task, profiles, blueprints, dashboard, approve, events, close, ship, suspend, `genie agent`
- [ ] README has Agent Directory config section (replaces Worker Profiles)
- [ ] `bun run check` passes
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: Restore Session Entry Point

**Goal:** `genie` (no args) starts/attaches a tmux session with Claude Code as team-lead.

**Deliverables:**

1. **Restore 3 tmux functions to `src/lib/tmux.ts`**
   - Recover from git: `git show ffb486ca~1:src/lib/tmux.ts`
   - Restore `getWindowEnv(target, varName)` — reads tmux env var from a window
   - Restore `setWindowEnv(target, varName, value)` — sets tmux env var on a window
   - Restore `killSession(sessionId)` — kills a tmux session
   - These are required by session.ts for window disambiguation and reset

2. **Restore session management functions to `src/genie-commands/session.ts`**
   - Recover from git: `git show ffb486ca~1:src/genie-commands/session.ts`
   - Functions to restore (keeping existing v2 helpers `getAgentsSystemPrompt`, `buildClaudeCommand`, `sanitizeWindowName` as-is):
     - `shortPathHash(p)` — 4-char MD5 hash for disambiguation
     - `resolveWindowName(sessionName, cwd)` — uses `sanitizeWindowName`, `findWindowByName`, `getWindowEnv`
     - `findLastSessionId(teamName, agentName, workspaceDir)` — scans Claude Code logs for session resume
     - `ensureNativeTeamForLeader(teamName, cwd)` — bootstraps native team dir for CC native teams
     - `createSession(sessionName, windowName, workspaceDir, systemPrompt)` — creates tmux session + launches Claude
     - `focusTeamWindow(sessionName, windowName, workingDir, systemPrompt)` — creates/focuses window in existing session
     - `deriveWindowName(sessionName, workspaceDir, team?)` — derives window name from context
     - `handleReset(sessionName, windowName)` — kills session and native team
     - `attachToWindow(sessionName, windowName)` — attaches to tmux session
     - `sessionCommand(options: SessionOptions)` — main entry point
     - `SessionOptions` interface: `{ reset?, name?, dir?, team? }`
   - Required imports to add back:
     - `import { spawnSync } from 'node:child_process'`
     - `import { createHash } from 'node:crypto'`
     - `import { readdirSync, statSync } from 'node:fs'` (add to existing import)
     - `import { homedir } from 'node:os'`
     - `import { basename } from 'node:path'` (add to existing import)
     - `import { deleteNativeTeam, ensureNativeTeam, registerNativeMember, sanitizeTeamName } from '../lib/claude-native-teams.js'`
     - `import { shellQuote } from '../lib/team-lead-command.js'` (add to existing import)
     - `import * as tmux from '../lib/tmux.js'`

3. **Wire default command in `src/genie.ts`**
   - Import `sessionCommand` from session.ts
   - Add default action before `program.parse()`:
     ```typescript
     // Default command: genie (no args) → session
     if (args.length === 0 || (args.length === 1 && args[0] === '--reset')) {
       const { sessionCommand } = await import('./genie-commands/session.js');
       await sessionCommand({ reset: args.includes('--reset') });
     } else {
       program.parse();
     }
     ```
   - Or use commander's `program.action()` — whichever doesn't conflict with the `--session` pre-parse block already at lines 232-249

4. **Adapt restored code to v2 changes**
   - `buildClaudeCommand` already exists in session.ts — the restored functions call it, so no conflict
   - `sanitizeWindowName` already exists — restored `resolveWindowName` calls it, compatible
   - Check if `shellQuote` is still exported from `team-lead-command.ts` (it is — verified)

**Acceptance criteria:**
- `genie` from any folder creates a tmux session and launches Claude Code
- `genie` from a folder with AGENTS.md injects the system prompt
- `genie` from an already-running folder attaches to existing window
- `genie --reset` kills and recreates the session
- `genie --session mywork` still works independently
- `bun run typecheck` passes

**Validation:**
```bash
bun run typecheck
bun test src/genie-commands/__tests__/session.test.ts
```

**depends-on:** none

---

### Group 2: Rewrite README CLI Reference

**Goal:** README CLI Reference matches the DRAFT.md Command Tree v2.

**Deliverables:**

1. **Rewrite CLI Reference section** in `README.md`
   - Replace the entire `<details id="cli-reference">` block
   - Use the Command Tree v2 from `.genie/brainstorms/agent-directory/DRAFT.md` as source of truth
   - Organize into sections matching the DRAFT:

   **Entry Point:**
   | Command | Description |
   |---------|-------------|
   | `genie` | Persistent session in current dir |
   | `genie --session <name>` | Named/resumed leader session |

   **Dispatch (lifecycle):**
   | Command | Description |
   |---------|-------------|
   | `genie brainstorm <agent> <slug>` | Spawn + inject brainstorm context |
   | `genie wish <agent> <slug>` | Spawn + inject design for wish creation |
   | `genie work <agent> <slug>#<group>` | Check deps, set in_progress, spawn with context |
   | `genie review <agent> <slug>#<group>` | Spawn + inject review scope |
   | `genie done <slug>#<group>` | Mark group done, unblock dependents |
   | `genie status <slug>` | Show wish group states |

   **Agent Lifecycle (top-level):**
   | Command | Description |
   |---------|-------------|
   | `genie spawn <name>` | Spawn registered agent or built-in role |
   | `genie kill <name>` | Force kill agent |
   | `genie stop <name>` | Stop current run, keep pane alive |
   | `genie ls` | List agents, teams, state |
   | `genie history <name>` | Compressed session timeline |
   | `genie read <name>` | Tail agent pane output |
   | `genie answer <name> <choice>` | Answer agent prompt |

   **Messaging (flat routing by name):**
   | Command | Description |
   |---------|-------------|
   | `genie send '<msg>' --to <name>` | Direct message (scoped to own team) |
   | `genie broadcast '<msg>'` | Leader to all members (one-way) |
   | `genie chat '<msg>'` | Team group channel |
   | `genie chat read` | Read team channel history |
   | `genie inbox [<name>]` | View inbox |

   **Directory (agent registry):**
   | Command | Description |
   |---------|-------------|
   | `genie dir add <name> --dir <path>` | Register agent |
   | `genie dir rm <name>` | Remove from directory |
   | `genie dir ls [<name>]` | List or show entry |
   | `genie dir edit <name>` | Update entry fields |

   **Team (dynamic collaboration):**
   | Command | Description |
   |---------|-------------|
   | `genie team create <name> --repo <path>` | Form team + worktree |
   | `genie team hire <agent>` | Add agent to team |
   | `genie team hire council` | Hire all 10 council members |
   | `genie team fire <agent>` | Remove agent from team |
   | `genie team ls [<name>]` | List teams or members |
   | `genie team disband <name>` | Kill members, cleanup worktree |

   **Infrastructure:**
   | Command | Description |
   |---------|-------------|
   | `genie setup` | Configure settings |
   | `genie doctor` | Diagnostics |
   | `genie update` | Update to latest |
   | `genie shortcuts` | tmux keyboard shortcuts |

2. **Replace "Worker Profiles" configuration section** with:
   ```markdown
   ### Agent Directory

   Register agents with a directory path, prompt mode, and optional model.

   ```bash
   genie dir add my-agent --dir /path/to/agent --prompt-mode append
   genie dir ls                          # List all registered agents
   genie dir edit my-agent --model opus  # Update config
   genie dir rm my-agent                 # Remove registration
   ```
   ```

3. **Remove ALL stale references** throughout the entire README:
   - `genie daemon`, `genie task *`, `genie profiles *`, `genie team blueprints`
   - `genie dashboard`, `genie approve`, `genie events`, `genie close`, `genie ship`, `genie suspend`
   - Any `genie agent *` namespace references
   - `genie council` (old CLI command — now `/council` skill)
   - `genie work <id>` (old task-based — now `genie work <agent> <slug>#<group>`)

**Acceptance criteria:**
- README CLI Reference matches DRAFT.md Command Tree v2 section structure
- `grep -n "genie daemon\|genie task\|genie profiles\|genie team delete\|genie team blueprints\|genie dashboard\|genie approve\|genie events\|genie close\|genie ship\|genie suspend\|genie agent\|genie council" README.md` returns nothing
- Agent Directory section replaces Worker Profiles

**Validation:**
```bash
grep -n "genie daemon\|genie task\|genie profiles\|genie team blueprints\|genie dashboard\|genie approve\|genie events\|genie close\|genie ship\|genie suspend" README.md && echo "FAIL" || echo "PASS"
```

**depends-on:** none

---

### Group 3: Final Validation

**Goal:** All fixes integrated, quality gates pass, PR created.

**Deliverables:**

1. Run `bun run check`
2. Run `bun run build`
3. Test `genie` (no args) launches session (manual or script)
4. Verify README matches DRAFT.md command tree
5. Create PR: `fix/post-merge-fixes` → `dev`

**Acceptance criteria:**
- `bun run check` exits 0
- `bun run build` succeeds
- All success criteria verified
- PR created targeting dev

**Validation:**
```bash
bun run check
bun run build
```

**depends-on:** Group 1, Group 2

---

## Dependency Graph

```
Group 1 (Session Restore)    Group 2 (README)
         │                        │
         └────────────────────────┘
                    │
             Group 3 (Validation)
```

Groups 1-2 are independent — can execute in parallel.
Group 3 waits for both.

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Restored tmux functions may have type conflicts with current tmux.ts | Medium | The functions are simple wrappers around `tmux` commands. Types haven't changed. |
| `findLastSessionId` scans Claude Code log directory structure | Medium | If the log format changed, degrade gracefully — skip resume, start fresh session. |
| `ensureNativeTeamForLeader` calls `ensureNativeTeam` + `registerNativeMember` | Low | Both functions verified as still exported from claude-native-teams.ts. |
| Default command wiring may conflict with `--session` pre-parse | Low | Pre-parse runs before `program.parse()`. Default action only fires if no subcommand matched. No conflict. |
| `shortPathHash` uses `createHash('md5')` — Bun supports this | Low | Verified: Bun supports node:crypto md5. |
