# Wish: Fix tmux Session Explosion — Default to Repo Agent Session

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `fix-tmux-session-explosion` |
| **Date** | 2026-03-18 |
| **Updated** | 2026-03-30 — rewritten per Felipe's design direction |

## Summary

`genie team create` currently creates a **new tmux session per team**, causing session explosion (20+ orphan sessions after a dream session). The correct behavior is the opposite:

- **Default (no flag):** team windows go INSIDE the repo agent's existing tmux session (e.g., teams for `/workspace/repos/genie` land in the `genie` session)
- **`--session <name>`:** explicitly redirect to a different session (e.g., `--session sofia` puts the team window in Sofia's session for monitoring)

The repo-to-session mapping comes from the agent workspace structure: `/workspace/repos/genie` → session `genie`, `/workspace/repos/genie-os` → session `genie-os`.

## Problem

Today's behavior:
```bash
genie team create my-team --repo /workspace/repos/genie --wish some-wish
# Creates: tmux session "my-team" with 1 window ← WRONG
# 5 parallel creates = 5 new sessions ← session explosion
```

Correct behavior:
```bash
genie team create my-team --repo /workspace/repos/genie --wish some-wish
# Creates: new WINDOW "my-team" inside existing "genie" tmux session ← RIGHT

genie team create my-team --repo /workspace/repos/genie --wish some-wish --session sofia
# Creates: new WINDOW "my-team" inside "sofia" tmux session ← EXPLICIT OVERRIDE
```

## Scope

### IN
- Resolve the repo's owning agent session as the default tmux target
- `genie team create` adds a window to the resolved session, not a new session
- `genie spawn` follows the same logic — workers land in their team's session
- `--session <name>` flag overrides the default (attach to a different session, or create a new one if it doesn't exist)
- Rename flag from `--session` to `--tmux-session` to avoid confusion with Claude Code sessions
- `genie team cleanup` command to kill windows/sessions from "done" teams
- Store resolved session name in team config for workers spawned later

### OUT
- Changes to native teams system (`claude-native-teams.ts`)
- Changes to inline (non-tmux) spawn path
- Tmux layout or mosaic improvements

## Session Resolution Order

When `genie team create --repo <path>` is called:

1. **`--tmux-session <name>`** → use that session (create if missing)
2. **Repo path mapping** → derive session name from repo path:
   - `/workspace/repos/genie` → `genie`
   - `/workspace/repos/genie-os` → `genie-os`
   - `/workspace/repos/omni` → `omni`
   - Logic: `basename(repoPath)` or match against known agent sessions
3. **`process.env.TMUX`** → use current session (caller is inside tmux)
4. **Fallback** → `tmux list-sessions` + best match by repo name
5. **Last resort** → create new session with team name (current behavior, but now it's the fallback, not the default)

## Decisions

| Decision | Rationale |
|----------|-----------|
| Default = repo agent session | Teams belong to their repo's agent. The agent session is the natural home. Prevents session explosion. |
| `--tmux-session` not `--session` | `--session` is overloaded (Claude Code sessions exist). `--tmux-session` is unambiguous. |
| Derive session from repo path | `basename(repoPath)` maps naturally to existing sessions (`genie`, `genie-os`, `omni`, `totvs`). |
| Override creates session if missing | `--tmux-session sofia` should work even if Sofia's session doesn't exist yet. |
| Store session name in team config | Workers spawned later need to find the right session without TMUX env. |

## Success Criteria

- [ ] `genie team create X --repo /workspace/repos/genie` creates a window in the existing `genie` tmux session
- [ ] `genie team create X --repo /workspace/repos/genie-os` creates a window in the existing `genie-os` tmux session
- [ ] Running 5 parallel `genie team create` for the same repo creates 5 windows in 1 session (not 5 sessions)
- [ ] `genie team create X --repo /workspace/repos/genie --tmux-session sofia` creates the window in `sofia` session
- [ ] Workers spawned by team-lead land in the same session as their team
- [ ] `genie team cleanup` removes windows for "done" teams
- [ ] Team config stores `tmuxSessionName` after creation
- [ ] No regression: `genie team create` from inside tmux without `--repo` still works

## Files to Modify

```
src/lib/tmux.ts                       — session resolution logic (resolveRepoSession)
src/lib/team-manager.ts               — tmuxSessionName field in team config
src/term-commands/agents.ts            — resolveSpawnTeamWindow uses repo session
src/term-commands/team.ts              — --tmux-session flag, spawnLeaderWithWish, cleanup command
src/lib/protocol-router-spawn.ts       — team config session fallback
```

## Execution Strategy

### Wave 1 (parallel)
| Group | Description |
|-------|-------------|
| 1 | Add `resolveRepoSession(repoPath)` to `tmux.ts` — derives session name from repo path |
| 2 | Store `tmuxSessionName` in team config, read it in spawn resolution |

### Wave 2 (after Wave 1)
| Group | Description |
|-------|-------------|
| 3 | Wire `resolveRepoSession` into `genie team create` + `genie spawn` as default |
| 4 | Add `--tmux-session` flag (override), rename from `--session` |

### Wave 3 (after Wave 2)
| Group | Description |
|-------|-------------|
| 5 | `genie team cleanup` command — kill windows for done teams |
| review | Review all changes |
