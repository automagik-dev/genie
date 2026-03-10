# Wish: Session-per-folder, tui rename, --team cleanup, onboarding hotfix

| Field | Value |
|-------|-------|
| **Status** | SHIPPED |
| **Slug** | `genie-default-command` |
| **Date** | 2026-03-10 |
| **Design** | [DESIGN.md](../../brainstorms/genie-default-command/DESIGN.md) |

## Summary

Running `genie` from any folder should create a tmux window named after that folder (or attach to the existing one) inside a single `"genie"` session. Internal `tui` naming (59 occurrences across 14+ files) must be renamed to `session`. The `genie --team <name>` global shortcut must be removed (keep `--team` on subcommands). The `/onboarding` skill crash must be hotfixed.

## Scope

### IN

- Fix onboarding SKILL.md line 499 (executable interpolation trigger)
- Rename `tui.ts` -> `session.ts`, all symbols, imports, comments, docs, skills
- Remove `--team` global shortcut from `team-shortcut.ts` + tests
- Session-per-folder: window naming by `basename(cwd)`, hash disambiguation, cwd tracking
- Update README.md, skills, wish docs, brainstorm docs for consistency

### OUT

- No changes to agent spawn/pane logic (agents still create panes in the current window)
- No changes to `genie team ensure/list/delete` commands
- No changes to build pipeline or bundler configuration
- No new CLI flags or user-facing options
- No changes to Claude Code integration (system prompt, resume, session ID)
- `--team` on subcommands (`agent spawn`, `send`) stays as-is
- No changes to hooks dispatch system

## Decisions

| Decision | Rationale |
|----------|-----------|
| Rename to `session.ts` / `sessionCommand` | Reflects the actual responsibility — managing tmux sessions and windows |
| Single "genie" session, folder = window | One session is simpler to manage; windows are the natural unit for folder isolation |
| Disambiguate with 4-char path hash on collision | Prevents silent cross-folder interference; keeps window names readable |
| Store cwd via tmux pane env var `GENIE_CWD` | No extra filesystem state; tmux env survives window lifetime |
| Fix SKILL.md content, not Claude SDK | SDK behavior is by design (executable interpolation); content must avoid the pattern |
| Remove `--team` global shortcut only | Subcommands still need team context; global shortcut is dead weight with folder-based sessions |

## Success Criteria

- [ ] `/onboarding` skill loads without crashing
- [ ] No file or function named `tui` remains in `src/`
- [ ] No doc or skill references `genie tui` (all say `genie`)
- [ ] `genie --team <name>` no longer routes to `_open`
- [ ] `genie agent spawn --team X` still works
- [ ] `genie` from ~/projects/myapp creates window "myapp" in session "genie"
- [ ] `genie` again from ~/projects/myapp attaches to existing "myapp" window
- [ ] `genie` from ~/projects/myapp2 creates separate "myapp2" window
- [ ] Two folders with same basename but different paths get disambiguated names
- [ ] Agents spawn as panes within the folder's window
- [ ] `bun run check` passes (typecheck + lint + dead-code + tests)
- [ ] `bun run build` succeeds

## Execution Groups

### Group 1: Hotfix — onboarding SKILL.md (P0)

**Goal:** Fix the `/onboarding` skill crash caused by Claude SDK executable interpolation.

**Deliverables:**
1. Edit `skills/onboarding/SKILL.md` line 499: change `` `prefix + !` `` to `` `prefix` + `!` ``

**Acceptance criteria:**
- The `!` character is no longer adjacent to a backtick with preceding whitespace on that line
- No other lines in any SKILL.md file contain the `!` + backtick pattern

**Validation:**
```bash
# Verify no executable interpolation triggers remain
grep -rn '!\`' skills/ && echo "FAIL: executable interpolation pattern found" || echo "PASS"
```

### Group 2: Rename tui -> session (source files)

**Goal:** Eliminate all `tui` naming from source code.

**Deliverables:**
1. Rename `src/genie-commands/tui.ts` -> `src/genie-commands/session.ts`
2. Rename `src/genie-commands/__tests__/tui.test.ts` -> `src/genie-commands/__tests__/session.test.ts`
3. In `session.ts` (was tui.ts):
   - `TuiOptions` -> `SessionOptions`
   - `tuiCommand()` -> `sessionCommand()`
   - `createTuiSession()` -> `createSession()`
   - Comment "Genie TUI Command" -> "Genie Session Command"
4. In `src/genie.ts` line 28:
   - Update import path and symbols: `import { type SessionOptions, sessionCommand } from './genie-commands/session.js'`
   - Update usage at lines 78, 80
   - Update comment at line 220
5. In `src/lib/team-lead-command.ts` line 4: comment `tui.ts` -> `session.ts`
6. In `src/genie-commands/setup.ts` line 343: `genie tui` -> `genie`
7. In `src/term-commands/agents.ts` line 738: `genie tui session` -> `genie session`
8. In `src/lib/claude-native-teams.ts` line 385: comment `genie tui` -> `genie`
9. In `src/term-commands/msg.test.ts` lines 154-159: update comments and import path

**Acceptance criteria:**
- `grep -rn 'tui' src/` returns zero results (excluding node_modules)
- All imports resolve correctly
- `bun run typecheck` passes

**Validation:**
```bash
grep -rn 'tui' src/ --include='*.ts' | grep -v node_modules | grep -v '.genie/' && echo "FAIL" || echo "PASS"
bun run typecheck
```

### Group 3: Rename tui -> genie (docs, skills, wishes)

**Goal:** Eliminate all `genie tui` references from documentation and planning files.

**Deliverables:**
1. `README.md` lines 54, 93, 114, 157: `genie tui` -> `genie`
2. `skills/onboarding/SKILL.md` lines 10, 18, 267: `genie tui` -> `genie`
3. `.genie/wishes/fix-onboarding-prod-bugs/WISH.md`: update `tui.ts` references to `session.ts`
4. `.genie/wishes/unify-install-kill-fragmentation/WISH.md`: update `tui.ts` references to `session.ts`
5. `.genie/brainstorms/prompt-loading-arch/DESIGN.md`: update `tui.ts` reference

**Acceptance criteria:**
- `grep -rn 'genie tui' .` returns zero results outside of git history
- `grep -rn 'tui\.ts' .` returns zero results outside of git history and node_modules

**Validation:**
```bash
grep -rn 'genie tui' README.md skills/ .genie/ && echo "FAIL" || echo "PASS"
grep -rn 'tui\.ts' README.md skills/ .genie/ src/ && echo "FAIL" || echo "PASS"
```

### Group 4: Remove --team global shortcut

**Goal:** Remove the `genie --team <name>` global routing. Keep `--team` on subcommands.

**Deliverables:**
1. In `src/lib/team-shortcut.ts`:
   - Remove lines 45-63 (`--team` flag handling in `resolveTeamShortcut()`)
   - Remove `--team` from the error message at line 75
2. In `src/lib/team-shortcut.test.ts`:
   - Remove test cases for `--team` routing (lines 103-123, 176-185)
3. Verify `--team` still works on `genie agent spawn` and `genie send`

**Acceptance criteria:**
- `genie --team foo` no longer routes to `_open foo`
- `genie agent spawn --role implementor --team myteam` still works
- `genie send "hello" --to agent1 --team myteam` still works
- All remaining tests pass

**Validation:**
```bash
grep -n '\-\-team' src/lib/team-shortcut.ts | wc -l  # should be 0 or minimal
bun test src/lib/team-shortcut.test.ts
bun test src/term-commands/msg.test.ts
```

### Group 5: Session-per-folder

**Goal:** Running `genie` from any folder creates/attaches a window named after that folder.

**Deliverables:**
1. In `session.ts` (was tui.ts), modify `sessionCommand()`:
   - Window name = `basename(process.cwd())` instead of hardcoded `"genie"`
   - On window lookup: check if existing window's `GENIE_CWD` matches current cwd
   - If basename collision with different cwd: append 4-char hash of full path
   - Store cwd as tmux pane environment variable: `tmux setenv -t <pane> GENIE_CWD <cwd>`
2. In `session.ts`, modify `createSession()`:
   - Session name stays `"genie"` (or `options.name`)
   - Window name = folder-derived name
   - Set `GENIE_CWD` env var on the pane
3. In `src/lib/team-shortcut.ts`:
   - Remove `DEFAULT_TEAM = 'main'` constant (no longer needed)
   - Update default routing: `genie` with no args -> `_open` with cwd-based naming
4. In `src/lib/tmux.ts` (if needed):
   - Add helper to read pane env var `GENIE_CWD`
   - Add helper to find window by name + verify cwd match

**Acceptance criteria:**
- `genie` from `/home/user/projects/myapp` creates window "myapp"
- `genie` again from same folder attaches to "myapp"
- `genie` from `/home/user/other/myapp` creates window "myapp-XXXX" (disambiguated)
- `genie` from `/home/user/projects/api` creates window "api"
- Session is always "genie" (single session for all folders)

**Validation:**
```bash
# Manual test sequence:
cd /tmp/test-folder-a && genie  # creates window "test-folder-a"
cd /tmp/test-folder-b && genie  # creates window "test-folder-b" in same session
cd /tmp/test-folder-a && genie  # attaches to existing "test-folder-a"
tmux list-windows -t genie      # should show both windows
```

### Group 6: Final validation

**Goal:** Full quality gates pass with all changes integrated.

**Deliverables:**
1. Run full check suite
2. Run build
3. Verify no stale references remain

**Acceptance criteria:**
- `bun run check` exits 0
- `bun run build` succeeds
- No `tui` references in source
- No `genie tui` references in docs
- No `--team` in team-shortcut.ts

**Validation:**
```bash
bun run check
bun run build
grep -rn 'tui' src/ --include='*.ts' | grep -v node_modules && echo "FAIL: tui in source" || echo "PASS"
grep -rn 'genie tui' README.md skills/ && echo "FAIL: genie tui in docs" || echo "PASS"
grep -n '\-\-team' src/lib/team-shortcut.ts && echo "FAIL: --team in shortcut" || echo "PASS"
```

## Assumptions / Risks

| Risk | Mitigation |
|------|------------|
| Existing "genie" sessions from old behavior have different window structure | Graceful fallback — if session exists with old structure, attach normally |
| Path hash collision (4 chars = 65k namespace) | Extremely unlikely for realistic use; can increase to 6 chars if needed |
| Renaming `tui` may break user scripts referencing internal functions | `_open` hidden command name stays the same; only internal naming changes |
| `DEFAULT_TEAM = 'main'` removal may break code that imports it | Search for all imports before removing; replace with inline defaults if needed |
| Removing `--team` global shortcut breaks existing workflows | Feature was never prominently documented; folder-based routing replaces it |
