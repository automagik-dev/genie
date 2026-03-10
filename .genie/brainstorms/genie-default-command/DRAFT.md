# Brainstorm: genie default command + tui rename + onboarding hotfix

## Problem
Three related issues:
1. **Hotfix:** `/onboarding` skill crashes — `!` + backtick in SKILL.md triggers Claude SDK executable interpolation
2. **Rename:** `tui` terminology persists in source, but the user-facing command is just `genie`
3. **Session-per-folder:** Running `genie` from any directory should auto-create a tmux session named after the folder (or attach if it already exists)

## Current State
- `genie tui` is an internal hidden command (`_open`) — already routed via `resolveTeamShortcut()`
- `genie` with no args → `_open main` → single "genie" tmux session, always
- Session name is hardcoded to `options.name ?? "genie"` in `tui.ts`
- Multiple projects share the same session — no folder isolation

## Scope (draft)

### IN
- Fix onboarding SKILL.md line 499 (break `!` + backtick adjacency)
- Rename `tui.ts` → something else (e.g. `session.ts` or `open.ts`)
- Rename `tuiCommand` → `openCommand` or `sessionCommand`
- Rename `TuiOptions` → `OpenOptions` or `SessionOptions`
- Rename `createTuiSession` → `createSession`
- Update all imports and references
- Update docs, skills, README
- Change session naming: use `basename(cwd)` as session name
- Attach to existing session if one with that name exists (already works via `findSessionByName`)

### OUT
- TBD

## Decisions (draft)
- TBD: What to call the renamed file/function — `session.ts` vs `open.ts`?
- TBD: Session name collision — two folders with same basename?
- TBD: Should `genie <team>` create a team *window* in the folder-based session, or a separate session?

## Risks
- TBD

## Criteria
- TBD
