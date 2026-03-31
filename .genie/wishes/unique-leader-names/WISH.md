# Wish: Unique Leader Names — Kill the Generic "team-lead"

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `unique-leader-names` |
| **Date** | 2026-03-30 |
| **Design** | Trace of Claude Code source (`cli.js` Z7K/lC8/MG functions) |

## Summary

Replace the hardcoded `"team-lead"` agent name with unique, per-team leader names. Claude Code's native teams system resolves the leader from `config.leadAgentId` → `members[].name`, only falling back to `"team-lead"` when the member isn't found. Our code hardcodes `"team-lead"` in 94 places, causing: (1) ambiguous messaging when multiple teams exist, (2) permission requests that can't be routed to the right leader, (3) no way for workers to report back to their orchestrator.

## Problem

```
# Today: 3 teams running, all leaders named "team-lead"
genie send "done" --to team-lead
# ⚠ Worker "team-lead" is ambiguous. Found 3 live matches.

# Permission request from genie-os agent:
"Permission request sent to team 'genie' leader"
# But the leader is dead/missing → stuck forever
```

## Scope

### IN
- Leader name derived from team name: `{team}-lead` (e.g., `tmux-fix-lead`, `ext-link-lead`)
- `genie team create --leader <name>` flag for custom leader names
- All 94 `"team-lead"` references updated to use dynamic name from team config
- `leadAgentId` in native team config uses the real leader name
- Inbox files use leader name: `inboxes/{leader-name}.json` instead of `inboxes/team-lead.json`
- `genie send --to team-lead` still works as alias → resolves to the team's actual leader
- Spawned workers know their leader's name (via kickoff prompt + team config)
- `genie done` notifications route to the actual leader name
- Backward compat: existing teams with `team-lead` continue to work

### OUT
- Renaming workers (engineer, reviewer, qa, fix) — separate concern
- Changing the Claude Code native teams protocol — we work within it
- Multi-leader teams — one leader per team
- Agent personality/identity system — this is naming only

## Claude Code Source Evidence

```javascript
// CC resolves leader name dynamically (cli.js decompiled):
async function getLeaderName(teamName) {
  let team = await loadTeamConfig(teamName);
  // Uses leadAgentId to find the member, gets their .name
  return team.members.find(m => m.agentId === team.leadAgentId)?.name || "team-lead";
}

// Permission requests go to the resolved leader name:
async function sendPermissionRequest(request) {
  let leaderName = await getLeaderName(request.teamName);
  await sendMessage(leaderName, { ...request });
}

// Leader check uses agentId, not name:
function isLeader(config) {
  return getMyAgentId() === config.leadAgentId;
}
```

**Key insight:** CC doesn't require "team-lead" — it uses `leadAgentId` for routing. We can set `leadAgentId: "tmux-fix-lead@tmux-fix"` and CC will route permissions to `"tmux-fix-lead"`.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Default name = `{team}-lead` | Unique per team, predictable, no collisions. `tmux-fix-lead`, `ext-link-lead`. |
| `--leader` flag for custom names | Sometimes you want `carlos` or `mika` instead of `ext-link-lead`. |
| Keep `"team-lead"` as messaging alias | Backward compat. `genie send --to team-lead` resolves to the team's actual leader when sender is in a team context (via `GENIE_TEAM` env). |
| Inbox file follows leader name | `inboxes/tmux-fix-lead.json` not `inboxes/team-lead.json`. CC reads from the member name. |
| Kickoff prompt includes orchestrator name | `"Report completion to: sofia (via genie send --to sofia)"` — no env var needed. |

## Success Criteria

- [ ] `genie team create foo --repo X` creates leader with name `foo-lead` and `leadAgentId: "foo-lead@foo"`
- [ ] `genie team create foo --repo X --leader carlos` creates leader named `carlos`
- [ ] Permission requests from workers route to `foo-lead` (not generic `team-lead`)
- [ ] `genie send "done" --to team-lead` resolves to the actual leader name when sent from within a team
- [ ] `genie done slug#1` notifies the actual leader name, not hardcoded `team-lead`
- [ ] Workers' dispatch prompts include `--to {leader-name}` instead of `--to team-lead`
- [ ] Existing teams with `team-lead` name continue to work (backward compat)
- [ ] No `"Worker 'team-lead' is ambiguous"` errors when multiple teams are running

## Files to Modify

```
# Core (leader identity)
src/lib/claude-native-teams.ts         — 12 refs: leadAgentId, member registration, inbox
src/lib/team-auto-spawn.ts             — 6 refs: agentName hardcoded to 'team-lead'
src/lib/agent-registry.ts              — 4 refs: PG queries filter role='team-lead'

# Spawn path
src/term-commands/team.ts              — 6 refs: standardTeam array, handleWorkerSpawn, sendMessage
src/lib/protocol-router-spawn.ts       — 1 ref: inbox write target
src/genie-commands/session.ts          — 10 refs: session creation, agent identity

# Messaging
src/term-commands/msg.ts               — 7 refs: routing, --to default, sender resolution
src/term-commands/state.ts             — 6 refs: genie done notifications
src/term-commands/dispatch.ts          — 2 refs: work/review prompt templates
src/term-commands/agents.ts            — 5 refs: inbox path, status, dead worker notify

# Support
src/lib/qa-runner.ts                   — 8 refs: QA team-lead spawn
src/lib/inbox-watcher.ts               — 5 refs: auto-spawn for inactive teams
src/lib/event-router.ts                — 2 refs: event routing to leader
src/hooks/handlers/auto-spawn.ts       — 1 ref: skip check
src/genie.ts                           — 2 refs: qa report command
```

## Execution Strategy

### Wave 1 (parallel — foundation)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Add `leaderName` to team config + `resolveLeaderName()` helper |
| 2 | engineer | Update `claude-native-teams.ts` — dynamic leadAgentId + inbox |

### Wave 2 (after Wave 1 — spawn path)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Update `team.ts` + `session.ts` — `--leader` flag, spawn with real name |
| 4 | engineer | Update `protocol-router-spawn.ts` + `team-auto-spawn.ts` — use config leader |

### Wave 3 (after Wave 2 — messaging)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Update `msg.ts` + `state.ts` + `dispatch.ts` — dynamic leader routing |
| 6 | engineer | Update `agents.ts` + `inbox-watcher.ts` + `event-router.ts` + remaining |

### Wave 4 (after Wave 3)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Backward compat: `team-lead` alias in messaging, migration for existing configs |
| review | reviewer | Full review of all changes |

## Execution Groups

### Group 1: Leader name in team config
**Goal:** Add `leaderName` field to team config and a resolver function.

**Deliverables:**
1. Add `leaderName: string` to `TeamConfig` interface in `team-manager.ts`
2. Add `resolveLeaderName(teamName: string): string` helper — reads from config, falls back to `"team-lead"`
3. `genie team create` stores `leaderName` in config (default: `{team}-lead`)
4. Add `--leader <name>` option to `genie team create`

**Acceptance Criteria:**
- [ ] Team config JSON includes `leaderName` after creation
- [ ] `resolveLeaderName("foo")` returns `"foo-lead"` for new teams
- [ ] `resolveLeaderName("old-team")` returns `"team-lead"` for legacy teams without the field

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/lib/team-manager.test.ts 2>/dev/null; echo "exit: $?"
```

**depends-on:** none

---

### Group 2: Dynamic leadAgentId in native teams
**Goal:** `claude-native-teams.ts` uses the real leader name from config.

**Deliverables:**
1. `ensureNativeTeam()` accepts `leaderName` parameter instead of hardcoding `"team-lead"`
2. `leadAgentId` becomes `{leaderName}@{sanitized}` instead of `team-lead@{sanitized}`
3. Member registration uses the real leader name
4. Inbox creation uses `inboxes/{leaderName}.json`
5. `listTeamsWithUnreadMessages()` checks leader inbox by resolved name

**Acceptance Criteria:**
- [ ] Native team config has `leadAgentId: "foo-lead@foo"` for team "foo"
- [ ] Inbox file created at `inboxes/foo-lead.json`
- [ ] CC routes permission requests to `"foo-lead"` (validated by reading config)

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/lib/claude-native-teams.test.ts 2>/dev/null; echo "exit: $?"
```

**depends-on:** Group 1

---

### Group 3: Spawn path — team create + session
**Goal:** `genie team create` and `genie session` spawn leaders with unique names.

**Deliverables:**
1. `spawnLeaderWithWish()` passes `leaderName` to `handleWorkerSpawn()` instead of `"team-lead"`
2. `handleWorkerSpawn()` uses leader name for `--agent-name` and `--agent-id`
3. `genie session` pre-creates native team with configured leader name
4. `standardTeam` array uses dynamic leader name: `[leaderName, 'engineer', 'reviewer', 'qa', 'fix']`
5. Kickoff prompt includes: `"Report completion to: {spawnerName} (via genie send --to {spawnerName})"`

**Acceptance Criteria:**
- [ ] `genie team create foo --repo X` spawns agent with `--agent-name foo-lead`
- [ ] `genie team create foo --repo X --leader carlos` spawns agent with `--agent-name carlos`
- [ ] Kickoff prompt contains orchestrator name for reporting

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun build src/genie.ts --outdir /tmp/genie-build 2>&1 | tail -3; echo "exit: $?"
```

**depends-on:** Group 1, Group 2

---

### Group 4: Auto-spawn + protocol router
**Goal:** `team-auto-spawn.ts` and `protocol-router-spawn.ts` use config leader name.

**Deliverables:**
1. `ensureTeamLeadAlive()` resolves leader name from team config
2. `spawnTeamLead()` uses resolved name for `agentName`
3. `protocol-router-spawn.ts` writes to leader inbox by resolved name

**Acceptance Criteria:**
- [ ] Auto-spawn creates leader with correct name from config
- [ ] Protocol router writes to `inboxes/{leaderName}.json`

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/lib/team-auto-spawn.test.ts 2>/dev/null; echo "exit: $?"
```

**depends-on:** Group 1, Group 2

---

### Group 5: Messaging — send, done, dispatch
**Goal:** All message routing uses the real leader name.

**Deliverables:**
1. `genie send --to team-lead` resolves to actual leader name via `GENIE_TEAM` env context
2. `genie done slug#N` notifies the resolved leader name in `notifyWaveCompletion()`
3. `dispatch.ts` work/review prompts use `--to {leaderName}` instead of `--to team-lead`
4. `msg.ts` sender resolution handles dynamic leader names

**Acceptance Criteria:**
- [ ] `genie send "hello" --to team-lead` resolves to `foo-lead` when `GENIE_TEAM=foo`
- [ ] `genie done slug#1` sends completion to `foo-lead`
- [ ] Dispatched work prompts contain `--to foo-lead`

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/term-commands/msg.test.ts 2>/dev/null; echo "exit: $?"
```

**depends-on:** Group 1, Group 3

---

### Group 6: Remaining references
**Goal:** Update all remaining hardcoded "team-lead" references.

**Deliverables:**
1. `agents.ts` inbox path + status checks + dead worker notifications
2. `inbox-watcher.ts` auto-spawn uses resolved leader name
3. `event-router.ts` routes to resolved leader
4. `agent-registry.ts` PG queries use parameterized role (not hardcoded `'team-lead'`)
5. `qa-runner.ts` spawns QA leader with team-specific name
6. `auto-spawn.ts` hook handler updated

**Acceptance Criteria:**
- [ ] `grep -r '"team-lead"' src/ --include='*.ts' | grep -v test | grep -v comment` returns 0 hardcoded refs (only alias handling)
- [ ] All existing tests pass

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test 2>/dev/null | tail -5; echo "exit: $?"
```

**depends-on:** Group 2, Group 4, Group 5

---

### Group 7: Backward compatibility + alias
**Goal:** Existing teams with `team-lead` continue to work. `"team-lead"` becomes a routing alias.

**Deliverables:**
1. `resolveLeaderName()` returns `"team-lead"` for configs without `leaderName` field
2. `genie send --to team-lead` always resolves: first check `GENIE_TEAM` config, then fall through
3. Migration: on team load, if `leaderName` is missing, set it to `"team-lead"` (no rename)
4. Document the new behavior in CLI help text

**Acceptance Criteria:**
- [ ] Old team configs (no `leaderName` field) still work
- [ ] `genie send --to team-lead` works in both old and new teams
- [ ] No breaking changes for running agents

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test 2>/dev/null | tail -5; echo "exit: $?"
```

**depends-on:** Group 5, Group 6

---

## QA Criteria

- [ ] Create 3 teams in parallel — each leader has a unique name, no ambiguity errors
- [ ] Worker in team "foo" can `genie send "done" --to foo-lead` successfully
- [ ] Worker in team "foo" can `genie send "done" --to team-lead` and it resolves to `foo-lead`
- [ ] Permission request from a worker routes to the correct leader
- [ ] Existing team with `team-lead` name continues to receive messages
- [ ] `genie team list` shows unique leader names per team
- [ ] All 1575+ existing tests pass

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude Code behavior changes in future versions | Medium | Our trace is against v2.1.88. Pin behavior to `leadAgentId` resolution which is stable. |
| Existing running agents break mid-session | Low | Only affects new teams. Old configs keep `"team-lead"` via fallback. |
| Worker prompts with `--to team-lead` from cached wishes | Low | Alias resolution handles this. Workers can use either name. |
| 94 references means large diff | Medium | Grouped into 7 execution groups. Each group is independently testable. |

---

## Review Results

_Populated by `/review` after execution completes._
