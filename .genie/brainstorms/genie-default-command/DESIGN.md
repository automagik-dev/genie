# Design: genie default command + tui rename + --team cleanup + onboarding hotfix

| Field | Value |
|-------|-------|
| **Slug** | `genie-default-command` |
| **Date** | 2026-03-10 |
| **Status** | Ready for /wish |

## Problem

Four related issues in the genie CLI:

1. **Hotfix (P0):** `/onboarding` skill crashes because `!` + backtick on line 499 of `skills/onboarding/SKILL.md` triggers Claude SDK's executable interpolation regex, passing markdown table content to bash.

2. **Naming debt:** Internal code uses `tui` naming across 14+ files (59 occurrences) despite the user-facing command being just `genie`.

3. **Session-per-folder:** Running `genie` from any directory should auto-create a tmux window named after the folder within a single `"genie"` session, or attach if one exists.

4. **`--team` global shortcut:** The `genie --team <name>` global routing in `team-shortcut.ts` is dead code. Remove the global shortcut while keeping `--team` on subcommands that need it (`agent spawn`, `send`).

## Architecture

### tmux Session Model

```
tmux session: "genie"              <- single persistent session
  |-- Window 0: "myapp"            <- genie run from ~/projects/myapp
  |    |-- Pane 0: team-lead
  |    |-- Pane 1: agent (spawned)
  |    +-- Pane 2: agent (spawned)
  |
  |-- Window 1: "api-server-c7b1"  <- genie run from ~/work/api-server (disambiguated)
  |    +-- Pane 0: team-lead
  |
  +-- Window 2: "myapp2"           <- genie run from ~/projects/myapp2
       +-- Pane 0: team-lead
```

- **One session** called `"genie"` (configurable via `--name`)
- **Each folder** gets its own window (tab), named `basename(cwd)`
- **Collision handling:** if a window with the same basename exists but points to a different path, append a short hash (first 4 chars of path hash): `myapp-a3f2`
- **Same folder re-run:** attaches to the existing window
- **Agents** spawn as panes within the folder's window (unchanged)

### Session Name Resolution

```
1. Get cwd = process.cwd()
2. windowName = basename(cwd)
3. Check if window `windowName` exists in "genie" session
   a. If exists AND same cwd -> attach
   b. If exists AND different cwd -> windowName = `${basename}-${hash(cwd).slice(0,4)}`
   c. If not exists -> create window with windowName, set cwd
4. Store cwd association (tmux pane env var GENIE_CWD)
```

## Scope

### IN

#### 1. Hotfix: onboarding SKILL.md
- Edit `skills/onboarding/SKILL.md` line 499: change `` `prefix + !` `` to `` `prefix` + `!` `` to break the executable interpolation trigger

#### 2. Rename: tui -> session (full hit list)

**File renames:**
- `src/genie-commands/tui.ts` -> `src/genie-commands/session.ts`
- `src/genie-commands/__tests__/tui.test.ts` -> `src/genie-commands/__tests__/session.test.ts`

**Symbol renames in source:**
| File | Old | New |
|------|-----|-----|
| `src/genie-commands/session.ts` (was tui.ts) | `TuiOptions` | `SessionOptions` |
| `src/genie-commands/session.ts` | `tuiCommand()` | `sessionCommand()` |
| `src/genie-commands/session.ts` | `createTuiSession()` | `createSession()` |
| `src/genie-commands/session.ts` | comment "Genie TUI Command" | "Genie Session Command" |
| `src/genie.ts` line 28 | `import { type TuiOptions, tuiCommand } from './genie-commands/tui.js'` | `import { type SessionOptions, sessionCommand } from './genie-commands/session.js'` |
| `src/genie.ts` line 78 | `options: TuiOptions` | `options: SessionOptions` |
| `src/genie.ts` line 80 | `tuiCommand(options)` | `sessionCommand(options)` |
| `src/genie.ts` line 220 | comment `genie tui <team>` | `genie <team>` |
| `src/lib/team-lead-command.ts` line 4 | comment `tui.ts` | `session.ts` |
| `src/genie-commands/setup.ts` line 343 | `genie tui` | `genie` |
| `src/term-commands/agents.ts` line 738 | `genie tui session` | `genie session` |
| `src/lib/claude-native-teams.ts` line 385 | comment `genie tui` | `genie` |

**Test file updates:**
| File | Change |
|------|--------|
| `src/genie-commands/__tests__/session.test.ts` (was tui.test.ts) | Update comment, import path, test dir name |
| `src/term-commands/msg.test.ts` lines 154-159 | Update comments and import path from `tui.js` to `session.js` |

**Documentation updates:**
| File | Lines | Change |
|------|-------|--------|
| `README.md` | 54, 93, 114, 157 | `genie tui` -> `genie` |
| `skills/onboarding/SKILL.md` | 10, 18, 267 | `genie tui` -> `genie` |

**Already-planned docs (informational, update references):**
| File | Note |
|------|------|
| `.genie/wishes/fix-onboarding-prod-bugs/WISH.md` | References `tui.ts` — superseded wish, update for consistency |
| `.genie/wishes/unify-install-kill-fragmentation/WISH.md` | References `tui.ts` — update for consistency |
| `.genie/brainstorms/prompt-loading-arch/DESIGN.md` | References `tui.ts` — update for consistency |

**Git cleanup:**
- Delete stale branch `fix/tui-tmux-base-index` if merged

#### 3. Remove `--team` global shortcut

**Files to modify:**
| File | Change |
|------|--------|
| `src/lib/team-shortcut.ts` lines 45-63 | Remove `--team` flag handling from `resolveTeamShortcut()` |
| `src/lib/team-shortcut.ts` line 75 | Remove `--team` from error message showing valid syntax |
| `src/lib/team-shortcut.test.ts` lines 103-123, 176-185 | Remove 6 `--team` test cases |

**Keep unchanged:**
- `src/term-commands/agents.ts` line 1136 — `--team` option on `genie agent spawn` (needed)
- `src/term-commands/msg.ts` line 108 — `--team` option on `genie send` (needed)
- `src/hooks/handlers/auto-spawn.ts` line 55 — internal `--team` usage (needed)

#### 4. Session-per-folder
- Change window naming: `basename(cwd)` instead of hardcoded `"genie"`
- Add path disambiguation on collision (short hash suffix)
- Store cwd->window mapping (via tmux pane env var `GENIE_CWD`)
- Window lookup: check existing windows by name, verify cwd match
- `genie` with no args -> creates/attaches window for current folder
- Remove `DEFAULT_TEAM = 'main'` constant from `team-shortcut.ts` (no longer needed)

### OUT
- No changes to agent spawn/pane logic
- No changes to `genie team ensure/list/delete` commands
- No changes to build pipeline
- No new CLI flags
- No changes to Claude Code integration (system prompt, resume, etc.)
- `--team` on subcommands (`agent spawn`, `send`) stays as-is

## Decisions

| Decision | Rationale |
|----------|-----------|
| Rename to `session.ts` / `sessionCommand` | Reflects the actual responsibility — managing tmux sessions and windows |
| Single "genie" session, folder = window | One session is simpler to manage; windows are the natural unit for folder isolation |
| Disambiguate with path hash on collision | Prevents silent cross-folder interference; keeps names readable |
| Store cwd via tmux pane env var `GENIE_CWD` | No extra filesystem state needed; tmux env survives window lifetime |
| Fix SKILL.md content, not SDK | SDK behavior is by design (executable interpolation); content must avoid the pattern |
| Remove `--team` global shortcut only | Subcommands still need team context; global shortcut is dead weight now that sessions are folder-based |

## Risks

| Risk | Mitigation |
|------|------------|
| Existing sessions from old behavior won't match new naming | Graceful fallback — if "genie" session exists with old structure, attach normally |
| Path hash collision (4 chars = 65k possibilities) | Extremely unlikely for realistic use; can increase to 6 chars if needed |
| Renaming `tui` may break external references or user scripts | `_open` hidden command name stays the same; only internal naming changes |
| Other SKILL.md files may have similar executable interpolation triggers | Scan confirmed: only onboarding SKILL.md is affected |
| Removing `--team` global shortcut breaks muscle memory | Feature was undocumented; `genie <folder>` routing still works |

## Success Criteria

- [ ] `/onboarding` skill loads without crashing
- [ ] No file or function named `tui` remains in `src/`
- [ ] All docs/skills reference `genie` not `genie tui`
- [ ] `genie --team <name>` no longer routes to `_open` (removed from team-shortcut.ts)
- [ ] `genie agent spawn --team X` still works (unchanged)
- [ ] `genie` from ~/projects/myapp creates window "myapp" in session "genie"
- [ ] `genie` again from ~/projects/myapp attaches to existing "myapp" window
- [ ] `genie` from ~/projects/myapp2 creates separate "myapp2" window
- [ ] Same-basename different-path folders get disambiguated window names
- [ ] Agents spawn as panes within the folder's window
- [ ] `bun run check` passes
- [ ] `bun run build` succeeds
