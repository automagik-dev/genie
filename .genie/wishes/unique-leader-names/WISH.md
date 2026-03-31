# Wish: Automatic Context Resolution — Identity, Routing, and Wish Discovery

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `unique-leader-names` |
| **Date** | 2026-03-30 |
| **Updated** | 2026-03-31 — rewritten: naming → full context resolution architecture |
| **Design** | Trace of Claude Code source (`cli.js` Z7K/lC8/MG functions) |

## Summary

Today, `genie team create` and `genie work` require manual `--repo`, `--session`, and `--wish` flags. The spawned leader is always named `"team-lead"`, causing ambiguity when multiple teams run in parallel. Permission requests get stuck because the leader can't be found.

The fix: make the system resolve everything automatically from two inputs — **who is calling** and **which wish** (namespaced as `repo/slug`). The filesystem is the source of truth (WISH.md files in repos). PG is the harness (indexes, queries, relationships). Leaders get unique names. Workers know who to report to.

## Problem

```bash
# Today: Sofia wants to execute a wish for the genie repo
genie team create tmux-fix --repo /workspace/repos/genie --wish fix-tmux-session-explosion --session genie
# 4 manual flags. Sofia has to know the repo path, session name, everything.

# And the leader is named "team-lead" — same as every other team's leader
# → "Worker 'team-lead' is ambiguous. Found 3 live matches."
# → Permission requests stuck: no active team-lead to approve
# → Workers can't report back: don't know who spawned them
```

```bash
# Target: one command, zero manual flags
genie work genie/fix-tmux-session-explosion
# System resolves: repo, session, leader name, orchestrator — all automatic
```

## Scope

### IN

**1. Namespaced wish resolution**
- `genie work genie/fix-tmux-session-explosion` → resolves to `/workspace/repos/genie/.genie/wishes/fix-tmux-session-explosion/WISH.md`
- Convention: `{repo-basename}/{wish-slug}` — filesystem is the source of truth
- On-demand resolution: check if path exists, no pre-scan required
- PG wish index: sync discovered wishes for querying (`wishes` table with slug, repo, project, status)

**2. Unique leader identity**
- Leader name = wish slug (e.g., `fix-tmux-session-explosion`) or team name for ad-hoc teams
- `leadAgentId` in CC native teams uses the real name, not `"team-lead"`
- All 94 hardcoded `"team-lead"` references updated to use dynamic resolution
- `"team-lead"` becomes a backward-compat alias (resolves via team config)

**3. Automatic orchestrator tracking**
- `genie work` / `genie team create` captures `GENIE_AGENT_NAME` of the caller as `spawner`
- Team config stores `spawner` field
- Kickoff prompt includes: `"Report completion to: {spawner}"`
- Workers can `genie send "done" --to {spawner}` — no hardcoded target

**4. Automatic repo/session resolution**
- `genie work genie/slug` → repo from namespace, session from repo mapping
- `genie team create foo` (no `--repo`) → resolves from cwd or `GENIE_TEAM` context
- Session resolution: namespace → repo → `basename(repo)` → tmux session (already mapped by agent-sync)

**5. Team without wish (ad-hoc)**
- `genie team create hotfix-auth --repo genie` → no wish, free-form work
- `wish_slug` is nullable in team config
- Leader name = team name (`hotfix-auth`)
- Without wish: no lifecycle management (no waves, no review gates)
- With wish: full lifecycle via `genie work`

### OUT
- New CLI commands for wish creation — writing WISH.md to the repo IS creating the wish
- Changes to Claude Code native teams protocol — we work within it
- Multi-leader teams — one leader per team
- Agent personality system — this is identity/routing only
- Renaming workers (engineer, reviewer, qa, fix) — separate concern

## Decisions

| Decision | Rationale |
|----------|-----------|
| Filesystem = source of truth | WISH.md in a repo IS the wish. No `genie wish create` needed. |
| PG = harness/index | Sync wishes from filesystem to PG for querying. Like agent-sync for agents. |
| Namespace = repo basename | `genie/slug` maps to `/workspace/repos/genie`. Convention over configuration. |
| Leader name = wish slug or team name | The team IS the leader. `fix-tmux-session-explosion` is both the team and the agent. No separate naming. |
| `spawner` in team config | The system knows who created the team. Workers know who to report to. No env var — it's in the prompt. |
| `wish_slug` nullable | Teams can exist without wishes. Wish = structured lifecycle. No wish = ad-hoc. |
| `"team-lead"` as alias | Backward compat. Old teams keep working. Alias resolves via team config. |

## Success Criteria

- [ ] `genie work genie/fix-tmux-session-explosion` resolves repo, session, leader — zero manual flags
- [ ] Leader agent is named `fix-tmux-session-explosion`, not `team-lead`
- [ ] CC permission requests route to `fix-tmux-session-explosion` (verified via native team config)
- [ ] Workers' prompts contain `"Report completion to: sofia"` (spawner tracked)
- [ ] `genie work genie/nonexistent` → clear error: "Wish not found in repo genie"
- [ ] `genie team create hotfix --repo genie` works without wish (ad-hoc team, leader = `hotfix`)
- [ ] 3 parallel teams → no ambiguous leader errors
- [ ] PG `wishes` table synced from filesystem (slug, repo, status, updated_at)
- [ ] Existing teams with `team-lead` name continue to work
- [ ] All 1575+ tests pass

## Files to Modify

```
# Resolution layer (new)
src/lib/wish-resolve.ts                — resolveWish(namespace/slug) → { repo, wishPath, session }
src/lib/wish-sync.ts                   — sync .genie/wishes/ to PG wishes table

# Leader identity (94 refs to update)
src/lib/claude-native-teams.ts         — dynamic leadAgentId + inbox
src/lib/team-auto-spawn.ts             — spawn with real leader name
src/lib/agent-registry.ts              — parameterized role queries

# Spawn path
src/term-commands/team.ts              — capture spawner, use wish slug as leader name
src/term-commands/dispatch.ts          — genie work accepts namespace/slug
src/genie-commands/session.ts          — session creation with real leader name

# Messaging (route to real leader)
src/term-commands/msg.ts               — resolve "team-lead" alias, dynamic routing
src/term-commands/state.ts             — genie done notifies real leader + spawner
src/term-commands/agents.ts            — inbox path, status checks
src/lib/protocol-router-spawn.ts       — inbox target
src/lib/inbox-watcher.ts               — auto-spawn with real name
src/lib/event-router.ts                — event routing

# DB migration
src/lib/db.ts                          — wishes table schema
```

## Execution Strategy

### Wave 1 (parallel — foundation)
| Group | Description |
|-------|-------------|
| 1 | `wish-resolve.ts` — namespace parsing + repo/session resolution |
| 2 | Leader name in team config + `resolveLeaderName()` + spawner tracking |

### Wave 2 (after Wave 1 — wiring)
| Group | Description |
|-------|-------------|
| 3 | `genie work` accepts `namespace/slug`, calls wish-resolve, creates team automatically |
| 4 | `claude-native-teams.ts` + `team-auto-spawn.ts` — dynamic leadAgentId |

### Wave 3 (after Wave 2 — messaging)
| Group | Description |
|-------|-------------|
| 5 | All messaging: msg.ts, state.ts, dispatch.ts, agents.ts — route to real leader + spawner |
| 6 | wish-sync: filesystem → PG index, DB migration for wishes table |

### Wave 4 (after Wave 3 — compat + cleanup)
| Group | Description |
|-------|-------------|
| 7 | Backward compat alias, remaining refs, inbox-watcher, event-router |
| review | Full review against all criteria |

## Execution Groups

### Group 1: Wish resolution from namespace
**Goal:** `genie work genie/fix-tmux-session-explosion` resolves to a concrete wish path, repo, and session.

**Deliverables:**
1. Create `src/lib/wish-resolve.ts` with `resolveWish(ref: string): { repo, wishPath, session, slug }`
2. Parse `namespace/slug` format — namespace maps to repo via `/workspace/repos/{namespace}`
3. Verify WISH.md exists at resolved path
4. Resolve tmux session from repo basename
5. Handle edge cases: wish not found, repo not found, ambiguous namespace

**Acceptance Criteria:**
- [ ] `resolveWish("genie/fix-tmux-session-explosion")` returns correct repo path, wish path, and session
- [ ] `resolveWish("nonexistent/slug")` throws clear error
- [ ] `resolveWish("fix-tmux-session-explosion")` without namespace → searches all known repos or errors

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/lib/wish-resolve.test.ts 2>/dev/null; echo "exit: $?"
```

**depends-on:** none

---

### Group 2: Leader identity + spawner tracking
**Goal:** Team config stores unique leader name and who created the team.

**Deliverables:**
1. Add `leaderName: string` to team config (default: wish slug or team name)
2. Add `spawner: string` to team config (from `GENIE_AGENT_NAME` or `"cli"`)
3. `resolveLeaderName(teamName)` helper — reads from config, falls back to `"team-lead"` for legacy
4. `genie team create` stores both fields automatically

**Acceptance Criteria:**
- [ ] New team config has `leaderName` and `spawner` fields
- [ ] `resolveLeaderName("foo")` returns `"foo"` for new teams
- [ ] Legacy teams without `leaderName` fall back to `"team-lead"`

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/lib/team-manager.test.ts 2>/dev/null; echo "exit: $?"
```

**depends-on:** none

---

### Group 3: Wire `genie work` to wish-resolve
**Goal:** `genie work genie/slug` creates team + spawns leader automatically.

**Deliverables:**
1. `genie work` command accepts `namespace/slug` format
2. Calls `resolveWish()` to get repo, session, wish path
3. Calls `handleTeamCreate()` internally — team name = wish slug
4. Leader agent named as wish slug, spawned in resolved session
5. Kickoff prompt includes: `"Report completion to: {spawner} (via genie send --to {spawner})"`
6. `genie team create foo --repo genie` still works for ad-hoc (no wish)

**Acceptance Criteria:**
- [ ] `genie work genie/fix-tmux-session-explosion` creates team, resolves everything, spawns leader
- [ ] Leader is named `fix-tmux-session-explosion`, not `team-lead`
- [ ] Kickoff prompt contains spawner name
- [ ] `genie team create hotfix --repo genie` works without wish

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun build src/genie.ts --outdir /tmp/genie-build 2>&1 | tail -3; echo "exit: $?"
```

**depends-on:** Group 1, Group 2

---

### Group 4: Native teams — dynamic leadAgentId
**Goal:** Claude Code native teams use the real leader name for permission routing.

**Deliverables:**
1. `ensureNativeTeam()` accepts `leaderName` parameter
2. `leadAgentId` = `{leaderName}@{sanitizedTeam}`
3. Member registration uses real leader name
4. Inbox created at `inboxes/{leaderName}.json`

**Acceptance Criteria:**
- [ ] Native team config: `leadAgentId: "fix-tmux-session-explosion@fix-tmux-session-explosion"`
- [ ] CC routes permission requests to the correct leader
- [ ] Inbox file at correct path

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/lib/claude-native-teams.test.ts 2>/dev/null; echo "exit: $?"
```

**depends-on:** Group 2

---

### Group 5: Messaging — dynamic routing
**Goal:** All message routing uses real leader name + spawner.

**Deliverables:**
1. `genie send --to team-lead` resolves to actual leader via team config
2. `genie done slug#N` notifies resolved leader AND spawner
3. `dispatch.ts` work/review prompts use `--to {leaderName}`
4. `msg.ts` sender resolution handles dynamic names
5. `agents.ts` inbox path uses resolved leader name

**Acceptance Criteria:**
- [ ] `genie send "done" --to team-lead` resolves correctly within team context
- [ ] `genie done slug#1` notifies both leader and spawner
- [ ] No "Worker 'team-lead' is ambiguous" errors

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/term-commands/msg.test.ts 2>/dev/null; echo "exit: $?"
```

**depends-on:** Group 2, Group 3

---

### Group 6: Wish sync — filesystem → PG
**Goal:** PG indexes wishes from filesystem for querying.

**Deliverables:**
1. DB migration: `wishes` table (slug, repo, namespace, status, file_path, created_at, updated_at)
2. `wish-sync.ts`: scan all repos' `.genie/wishes/*/WISH.md`, parse status from frontmatter, upsert to PG
3. Called on `genie work`, `genie status`, and optionally on daemon startup
4. `genie wish list` queries PG (not filesystem) — fast, cross-repo

**Acceptance Criteria:**
- [ ] `wishes` table populated after sync
- [ ] `genie wish list` shows wishes across all repos with status
- [ ] Sync is idempotent — multiple runs don't create duplicates

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test src/lib/wish-sync.test.ts 2>/dev/null; echo "exit: $?"
```

**depends-on:** Group 1

---

### Group 7: Backward compat + cleanup
**Goal:** Existing teams continue to work. All hardcoded refs cleaned up.

**Deliverables:**
1. `"team-lead"` alias in messaging — resolves to actual leader via team config
2. Legacy team configs (no `leaderName`) fall back to `"team-lead"`
3. Remaining hardcoded refs in inbox-watcher, event-router, qa-runner, hooks
4. `grep -r '"team-lead"' src/ --include='*.ts' | grep -v test` returns only alias handling code

**Acceptance Criteria:**
- [ ] Old team configs work without migration
- [ ] All 1575+ tests pass
- [ ] No hardcoded `"team-lead"` outside alias resolution

**Validation:**
```bash
cd /home/genie/workspace/repos/genie && bun test 2>/dev/null | tail -5; echo "exit: $?"
```

**depends-on:** Group 4, Group 5, Group 6

---

## QA Criteria

- [ ] `genie work genie/some-wish` → full lifecycle: resolve, create team, spawn leader, execute
- [ ] `genie team create adhoc --repo genie` → ad-hoc team without wish
- [ ] 3 parallel `genie work` → 3 unique leaders, no ambiguity
- [ ] Permission request from worker → routes to correct leader
- [ ] Worker completes → spawner (sofia) receives notification
- [ ] `genie wish list` → shows wishes across all repos from PG index
- [ ] Legacy teams with `team-lead` → still functional
- [ ] All 1575+ existing tests pass

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude Code changes permission routing | Medium | Traced against v2.1.88. Uses `leadAgentId` resolution which is stable API. |
| Namespace collision (two repos with same basename) | Low | Error on ambiguity. Accept full path as fallback: `--repo /path`. |
| 94-ref migration breaks something | Medium | 7 groups, each independently testable. Alias preserves backward compat. |
| Wish slug contains characters invalid for agent names | Low | Sanitize slug same way team names are sanitized today. |

---

## Review Results

_Populated by `/review` after execution completes._
