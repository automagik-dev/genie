# Wish: v4 Stability — Spawn Resilience + Leader Identity

| Field | Value |
|-------|-------|
| **Status** | SHIPPED — PR #958 + #994 (v4 Stability Sprint, 2026-04-02) |
| **Slug** | `v4-spawn-resilience` |
| **Date** | 2026-03-31 |
| **Design** | _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._, _Design not recovered — this wish pre-dates the brainstorm-commit convention (see #1132)._ |

## Summary
Fix two related problems: (1) agents getting permanently stuck in `spawning` state with no pane/session — caused by spawn failures that leave zombie DB rows with no recovery path, and (2) leader identity hardcoded as `'team-lead'` across 27 references in 13 files — causing permission requests to route to a nonexistent agent when the actual leader has a different name (khal-os, sofia, etc.). Both produce the same symptom: agents stuck, unable to interact.

## Scope
### IN
- Add spawn watchdog: if `state=spawning` with empty `pane_id` for >60s, auto-reset to `offline` (P0)
- Add TUI "retry" action on stuck agents — user can press Enter/R to force respawn (P0)
- Add dir entry validation — reject `REPO` values that aren't valid paths (P1)
- Add startup reconciliation: clean stale `spawning` rows on `genie` boot (P1)
- Replace all 27 hardcoded `'team-lead'` fallbacks with dynamic leader resolution (P0)
- Add config reconciliation: update existing `config.json` files with correct `leadAgentId` (P1)
- Fix `team-lead-command.ts` to use actual agent name in `--agent-id` and `--agent-name` (P0)

### OUT
- Changing the agent template/builtin named "team-lead" (it's a valid template name, the bug is using it as identity)
- Test file references to `'team-lead'` (tests should test both legacy and dynamic names)
- Comment/documentation references (only fix code paths)

## Decisions
| Decision | Rationale |
|----------|-----------|
| 60s spawn timeout | Long enough for slow CC startup, short enough to not leave agents stuck for minutes |
| Keep `'team-lead'` as template/role name, remove as identity fallback | The role "team-lead" is valid. The bug is falling back to it as an agent identity/name |
| Resolution order: team config DB → env var → session name | Most specific wins. Never fall back to a hardcoded string |
| Reconcile on startup, not migration | Configs are JSON files, not DB rows. Runtime reconciliation is simpler |

## Success Criteria
- [ ] Agent stuck in `spawning` for >60s is automatically reset
- [ ] TUI allows retrying stuck agents
- [ ] `genie dir add` rejects non-path REPO values
- [ ] No hardcoded `'team-lead'` identity fallbacks remain in production code
- [ ] `leadAgentId` in config.json reflects the actual leader name
- [ ] Claude Code `--agent-id` uses actual leader name, not `team-lead`
- [ ] Permission requests for team leader auto-approve (leader approves own actions)
- [ ] `bun test` passes (all existing tests updated for dynamic leader names)

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Spawn watchdog + TUI retry + dir validation + startup reconciliation |
| 2 | engineer | Replace all 27 hardcoded team-lead fallbacks with dynamic resolution |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Fix team-lead-command.ts + config reconciliation + update tests |
| review | reviewer | Review all groups |

## Execution Groups

### Group 1: Spawn Recovery
**Goal:** Prevent and recover from stuck spawn states.
**Deliverables:**
1. Add `reconcileStaleSpawns()` function in `src/lib/agent-registry.ts`: executes `UPDATE agents SET state = 'offline' WHERE state = 'spawning' AND (pane_id IS NULL OR pane_id = '') AND started_at < now() - interval '60 seconds' RETURNING id`. Logs each reset agent.
2. Call `reconcileStaleSpawns()` in `src/genie-commands/session.ts` during `createSession()` (before creating the new session — one-shot on CLI start). No periodic loop needed — runs once per `genie` invocation.
3. Add TUI handling in `src/tui/tmux.ts`: in the session selection handler, if selected agent has `state=spawning` and no pane, show `[stuck — press R to retry]` and on R key, call `reconcileStaleSpawns()` then re-trigger session creation for that agent.
4. Add validation in `src/term-commands/agent/dir.ts` (the `genie dir add` handler): REPO value must be an absolute path (`/`), home-relative (`~/`), or dot-relative (`./`, `../`). Reject bare words like `genie`.

**Acceptance Criteria:**
- [ ] Sofia-like stuck agent (spawning, no pane, >60s) is auto-reset on next `genie` invocation
- [ ] User can retry stuck agents from TUI with R key
- [ ] `genie dir add foo --repo genie` is rejected (not a valid path)

**Validation:**
```bash
bun test src/lib/agent-registry.test.ts
bun test src/genie-commands/__tests__/session.test.ts
```

**depends-on:** none

---

### Group 2: Dynamic Leader Identity
**Goal:** Replace all hardcoded `'team-lead'` identity fallbacks with a shared resolver.
**Deliverables:**

**Step 1 — Create shared helper** in `src/lib/team-manager.ts`:
```typescript
/**
 * Resolve the actual leader name for a team. Never returns 'team-lead'.
 * @throws if team has no leader configured and no fallback available.
 */
export async function resolveLeaderName(teamName: string): Promise<string> {
  const config = await getTeam(teamName);
  if (config?.leader && config.leader !== 'team-lead') return config.leader;
  // Fallback: use team name as leader name (the session/window is named after the team)
  return teamName;
}
```
Error behavior: if DB unreachable, catch and return `teamName` as fallback (never 'team-lead'). If team doesn't exist, return `teamName`.

**Step 2 — Replace ~41 hardcoded fallbacks** across these files (all import and use `resolveLeaderName()`):

| File | Lines | Change |
|------|-------|--------|
| `agents.ts` | 49, 51 | `return await resolveLeaderName(teamNameOrDefault)` |
| `session.ts` | 70 | `return await resolveLeaderName(windowName)` |
| `team-auto-spawn.ts` | 117 | `const leaderName = await resolveLeaderName(teamName)` |
| `claude-native-teams.ts` | 199, 394, 396, 573, 697 | Use `resolveLeaderName()` for all fallback paths |
| `team-manager.ts` | 640 | Already the owner — uses `resolveLeaderName()` |
| `state.ts` | 243, 249, 253 | `leader: await resolveLeaderName(teamName)` |
| `dispatch.ts` | 306, 311, 313 | `return await resolveLeaderName(teamName)` |
| `msg.ts` | 111, 122, 155, 190, 526 | Resolve through `resolveLeaderName()` |
| `agent/send.ts` | 22, 49 | Resolve default from `GENIE_TEAM` env + `resolveLeaderName()` |
| `protocol-router-spawn.ts` | 249 | `leaderInboxTarget = await resolveLeaderName(teamName)` |
| `agent-registry.ts` | 348, 363, 364 | Query by `resolveLeaderName()` result, keep `role = 'team-lead'` as secondary match for backwards compat |

**Acceptance Criteria:**
- [ ] `resolveLeaderName()` exists and never returns the literal string `'team-lead'`
- [ ] All 12 files use `resolveLeaderName()` instead of `|| 'team-lead'` or `?? 'team-lead'`
- [ ] Grep for `|| 'team-lead'` and `?? 'team-lead'` in production code returns 0 hits

**Validation:**
```bash
grep -rn "|| 'team-lead'\|?? 'team-lead'" src/lib/*.ts src/term-commands/*.ts src/genie-commands/*.ts src/hooks/handlers/*.ts \
  | grep -v '\.test\.' | grep -v '//' | wc -l  # target: 0
bun test src/lib/team-manager.test.ts
```

**depends-on:** none

---

### Group 3: Command Builder + Config Reconciliation
**Goal:** Fix the Claude Code launch command and existing configs.
**Deliverables:**
1. **Break circular dependency:** Add `leaderName` parameter to `buildTeamLeadCommand(teamName, opts)` — the CALLER passes the resolved leader name (from `resolveLeaderName()`), not the command builder. Update signature: `buildTeamLeadCommand(teamName: string, opts?: { leaderName?: string, ... })`. Use `opts.leaderName ?? teamName` for `--agent-id` and `--agent-name`. Callers: `session.ts` and `team-auto-spawn.ts` — both already resolve leader name before calling.
2. **Config reconciliation** in `src/genie-commands/session.ts` during `createSession()` (same startup path as spawn reconciliation in Group 1): scan `~/.claude/teams/*/config.json`. For each config where `leadAgentId` starts with `team-lead@`, replace with `<actualLeader>@<team>` using `resolveLeaderName(teamName)`. Run once per `genie session` invocation.
3. Update test fixtures in `team-lead-command.test.ts`: add test case that passes `leaderName: 'khal-os'` and verifies `--agent-id 'khal-os@team'`. Keep existing test for default behavior (uses teamName as fallback).

**Acceptance Criteria:**
- [ ] `buildTeamLeadCommand('genie', { leaderName: 'khal-os' })` outputs `--agent-id 'khal-os@genie'`
- [ ] Existing `config.json` with `team-lead@genie` is updated on next `genie session` startup
- [ ] All tests pass

**Validation:**
```bash
bun test src/lib/team-lead-command.test.ts
bun test src/lib/claude-native-teams.test.ts
```

**depends-on:** Group 2

---

## Files to Create/Modify

```
src/term-commands/agents.ts
src/genie-commands/session.ts
src/lib/team-auto-spawn.ts
src/lib/claude-native-teams.ts
src/lib/team-manager.ts
src/lib/agent-registry.ts
src/lib/protocol-router-spawn.ts
src/lib/team-lead-command.ts
src/term-commands/state.ts
src/term-commands/dispatch.ts
src/term-commands/msg.ts
src/term-commands/agent/send.ts
src/hooks/handlers/auto-spawn.ts
src/lib/team-lead-command.test.ts
src/lib/claude-native-teams.test.ts
```
