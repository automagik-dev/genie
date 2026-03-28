# Wish: Fix tmux Session Explosion on Parallel Team Creation

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-tmux-session-explosion` |
| **Date** | 2026-03-18 |
| **Design** | N/A (trace-driven fix) |

## Summary

When multiple `genie team create` commands run in parallel, each creates a separate tmux session instead of adding windows to the orchestrating agent's existing session. This caused OS instability when 5+ teams were created simultaneously. The root cause is `resolveSpawnTeamWindow()` falling back to team name as session identifier when `process.env.TMUX` is not set in the calling context.

## Scope

### IN
- Fix `resolveSpawnTeamWindow` to resolve parent session without relying solely on `process.env.TMUX`
- Add `--session` option to `genie spawn` and `genie team create` to pin agents to a specific tmux session
- Store resolved tmux session name in team config during team creation
- Add fallback session discovery in `getCurrentSessionName` when TMUX env is not set
- Add `genie team cleanup` command to kill orphan sessions from completed/disbanded teams

### OUT
- Refactoring the native teams system (`claude-native-teams.ts`)
- Changes to `genie session` command behavior
- Changes to inline (non-tmux) spawn path
- Tmux layout or mosaic improvements

## Decisions

| Decision | Rationale |
|----------|-----------|
| Store tmux session name in team config | Allows workers spawned later (or from different contexts) to find the correct parent session without TMUX env |
| Add `--session` flag rather than auto-detect only | Explicit is better than implicit; auto-detect is fallback, not primary |
| Fallback to `tmux list-sessions` in `getCurrentSessionName` | Even without TMUX env, we can discover running sessions if tmux server is active |
| Single parent session per team | All agents in a team share one tmux session as windows/panes, preventing session sprawl |

## Success Criteria

- [ ] Running `genie team create` 5 times in parallel from a non-tmux context creates 5 windows in one session (not 5 sessions)
- [ ] Running `genie spawn` with `--session <name>` places the agent in the specified session
- [ ] Team config stores `tmuxSessionName` after team creation
- [ ] Workers spawned by team-lead find the correct parent session even without TMUX env
- [ ] `genie team cleanup` kills orphan tmux sessions from "done" or "disbanded" teams
- [ ] No regression: single `genie team create` from inside tmux still works correctly

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Add tmux session name to team config and resolve it in spawn |
| 2 | engineer | Add fallback session discovery to `getCurrentSessionName` |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Add `--session` flag to `genie spawn` and `genie team create` |
| 4 | engineer | Add `genie team cleanup` command |

### Wave 3 (after Wave 2)
| Group | Agent | Description |
|-------|-------|-------------|
| review | reviewer | Review all changes against acceptance criteria |

## Execution Groups

### Group 1: Store and resolve tmux session in team config
**Goal:** Ensure every team has a stored tmux session name that workers can use to find their parent session.

**Deliverables:**
1. Add `tmuxSessionName` field to team config interface and persistence (`src/lib/team-manager.ts`)
2. In `spawnLeaderWithWish` (`src/term-commands/team.ts:197-231`), resolve the current tmux session name BEFORE calling `handleWorkerSpawn` and store it in team config
3. In `resolveSpawnTeamWindow` (`src/term-commands/agents.ts:489-498`), read stored `tmuxSessionName` from team config as primary fallback when `getCurrentSessionName()` returns null
4. In `spawnWorkerFromTemplate` (`src/lib/protocol-router-spawn.ts:94`), use the same team config fallback

**Acceptance Criteria:**
- [ ] Team config JSON includes `tmuxSessionName` after team creation
- [ ] `resolveSpawnTeamWindow` uses team config session name when TMUX env is not set
- [ ] `spawnWorkerFromTemplate` uses team config session name when TMUX env is not set

**Validation:**
```bash
cd /home/genie/agents/namastexlabs/genie/repos/genie && bun test src/lib/team-manager.test.ts && bun test src/term-commands/agents.test.ts 2>/dev/null; echo "exit: $?"
```

**depends-on:** none

---

### Group 2: Fallback session discovery in getCurrentSessionName
**Goal:** Make `getCurrentSessionName` resilient to missing TMUX env by falling back to tmux server queries.

**Deliverables:**
1. In `getCurrentSessionName` (`src/lib/tmux.ts:42-49`), add fallback: when `process.env.TMUX` is not set, try `tmux list-sessions -F '#{session_name}'` and return the first session (or a session matching a hint pattern)
2. Add optional `hint` parameter to `getCurrentSessionName(hint?: string)` that prefers a session matching the hint (e.g., team name prefix)
3. Ensure the fallback is non-blocking and fails gracefully (returns null if tmux server is not running)

**Acceptance Criteria:**
- [ ] `getCurrentSessionName()` returns a session name even when `process.env.TMUX` is not set, if tmux server is running
- [ ] `getCurrentSessionName('totvs-pm')` prefers a session containing "totvs-pm" in its name
- [ ] Returns null gracefully when tmux server is not running

**Validation:**
```bash
cd /home/genie/agents/namastexlabs/genie/repos/genie && bun test src/lib/tmux.test.ts 2>/dev/null; echo "exit: $?"
```

**depends-on:** none

---

### Group 3: Add --session flag to spawn and team create
**Goal:** Allow explicit session pinning via CLI flag.

**Deliverables:**
1. Add `--session <name>` option to `genie spawn` command (`src/term-commands/agents.ts`)
2. Add `--session <name>` option to `genie team create` command (`src/term-commands/team.ts`)
3. Pass session name through `SpawnOptions` → `SpawnCtx` → `resolveSpawnTeamWindow`
4. When `--session` is provided, use it as the definitive session target (no fallback needed)

**Acceptance Criteria:**
- [ ] `genie spawn engineer --team myteam --session totvs-pm` creates pane in "totvs-pm" session
- [ ] `genie team create myteam --repo /path --session totvs-pm` stores and uses "totvs-pm" as parent session
- [ ] Flag is optional; omitting it preserves current behavior

**Validation:**
```bash
cd /home/genie/agents/namastexlabs/genie/repos/genie && bun build src/genie.ts --outdir /tmp/genie-build 2>&1 | tail -3; echo "exit: $?"
```

**depends-on:** Group 1, Group 2

---

### Group 4: Add genie team cleanup command
**Goal:** Provide a command to kill orphan tmux sessions from completed or disbanded teams.

**Deliverables:**
1. Add `genie team cleanup` command (`src/term-commands/team.ts`) that:
   - Lists all teams with status "done" or "disbanded"
   - For each, checks if a tmux session with the team name exists
   - Kills orphan sessions (sessions with only idle bash panes, no running agents)
   - Prints summary of cleaned sessions
2. Optionally run cleanup automatically when `genie team disband` is called

**Acceptance Criteria:**
- [ ] `genie team cleanup` kills tmux sessions for "done" teams that have only idle bash panes
- [ ] Does NOT kill sessions with running Claude Code or other active processes
- [ ] Prints list of cleaned sessions
- [ ] `genie team disband` kills the team's tmux session as part of cleanup

**Validation:**
```bash
cd /home/genie/agents/namastexlabs/genie/repos/genie && bun build src/genie.ts --outdir /tmp/genie-build 2>&1 | tail -3; echo "exit: $?"
```

**depends-on:** none

---

## QA Criteria

- [ ] Create 5 teams in parallel from a non-tmux Bash context; verify only 1 session created with 5 windows
- [ ] Create 1 team from inside tmux; verify window added to current session (regression check)
- [ ] Run `genie team cleanup` with "done" teams; verify orphan sessions killed
- [ ] Spawn agent with `--session` flag; verify it lands in correct session
- [ ] Team config includes `tmuxSessionName` after creation

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `tmux list-sessions` fallback picks wrong session when multiple exist | Medium | Use hint parameter to prefer matching session; store explicit session in team config |
| Stored session name becomes stale if session is killed externally | Low | Fallback chain: explicit flag → team config → TMUX env → list-sessions discovery |
| Cleanup command kills sessions that user wants to keep | Low | Only kill sessions matching "done"/"disbanded" teams with idle-only panes |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/lib/tmux.ts                       — getCurrentSessionName fallback
src/lib/team-manager.ts               — tmuxSessionName field in team config
src/term-commands/agents.ts            — resolveSpawnTeamWindow fallback + --session flag
src/term-commands/team.ts              — spawnLeaderWithWish session resolution + --session flag + cleanup command
src/lib/protocol-router-spawn.ts       — team config session fallback
src/lib/team-auto-spawn.ts            — ensureSession team config fallback
```
