# Wish: `genie stats` — Self-Service Metrics Dashboard

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-stats-command` |
| **Date** | 2026-03-24 |

## Summary

Add a `genie stats` CLI command that queries the local PG database and git history to give agents (and humans) a self-service view of what happened. Agents shouldn't need raw SQL to know their own throughput. The metrics agent should consume `genie stats --json` instead of bespoke scripts.

## Scope

### IN
- `genie stats` command with `--period`, `--json`, `--repo` flags
- Query tasks, messages, conversations, stage transitions from PG
- Query git log for commits, LoC, PRs from GitHub API
- Filter test data by default (`repo_path NOT LIKE '/tmp/%'`, `sender_id NOT LIKE 'test%'`)
- `--json` output for machine consumption (metrics agent)
- Register as a term-command in the genie CLI

### OUT
- Real-time dashboard or TUI (just a CLI print)
- Collecting new data (heartbeats, audit events — that's #765)
- Web UI or API endpoint
- Historical trend charts

## Decisions

| Decision | Rationale |
|----------|-----------|
| PG queries + git log combined | Single command gives the full picture — orchestration data (PG) + code velocity (git) |
| Filter test data by default | DB is 95% test pollution; real stats require filtering. `--include-test` flag to override |
| `--json` as first-class | The metrics agent is the primary consumer; human-readable is secondary |
| Same PG connection as db.ts | Reuse `getConnection()` from `src/lib/db.ts` — no new connection config |

## Success Criteria

- [ ] `genie stats` prints a human-readable summary of last 24h activity
- [ ] `genie stats --period 7d` shows last 7 days
- [ ] `genie stats --all` shows all time
- [ ] `genie stats --json` outputs machine-readable JSON
- [ ] Test data excluded by default
- [ ] Includes: tasks created/completed, messages, conversations, commits, LoC, PRs
- [ ] Command registered in genie CLI help
- [ ] Tests pass

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Implement `genie stats` term-command with PG queries |
| 2 | engineer | Add git/GitHub metrics (commits, LoC, PRs) to stats output |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | reviewer | Review: verify output, test data filtering, --json format |

## Execution Groups

### Group 1: PG Stats Command

**Goal:** Create `src/term-commands/stats.ts` that queries the genie PG for orchestration metrics.

**Deliverables:**
1. New file `src/term-commands/stats.ts`:
   - Parse flags: `--period <duration>` (default 24h), `--all`, `--json`, `--include-test`
   - Query tasks table: created count, done count, in_progress count, by period
   - Query messages table: total sent, by period
   - Query conversations table: active count
   - Query task_stage_log: transitions count
   - Filter: `repo_path NOT LIKE '/tmp/%'` and `sender_id NOT LIKE 'test%'` by default
   - Human-readable output with aligned columns
   - JSON output with `--json`

2. Register command in `src/term-commands/index.ts` or wherever commands are registered

3. Unit test: `src/term-commands/stats.test.ts`

**Acceptance Criteria:**
- [ ] `genie stats` prints tasks/messages/conversations for last 24h
- [ ] `genie stats --period 7d` changes the time window
- [ ] `genie stats --json` outputs valid JSON
- [ ] Test data excluded by default
- [ ] `bun test stats` passes

**Validation:**
```bash
genie stats
genie stats --json | jq .
genie stats --period 7d
bun test src/term-commands/stats.test.ts
```

**depends-on:** none

---

### Group 2: Git + GitHub Metrics

**Goal:** Add code velocity metrics to `genie stats` output — commits, LoC changed, PRs.

**Deliverables:**
1. Extend `stats.ts` to also compute:
   - Commits in period: `git log --since="<period>" --oneline | wc -l`
   - LoC changed in period: `git log --since="<period>" --stat --format="" | awk`
   - PRs merged in period: `gh api` query
2. Include these in both human-readable and JSON output
3. Handle errors gracefully (no git repo, no gh auth)

**Acceptance Criteria:**
- [ ] Stats output includes commits, LoC, PRs
- [ ] Works when not in a git repo (skip git metrics, show PG only)
- [ ] Works when gh is not authenticated (skip PR count)

**Validation:**
```bash
genie stats --json | jq '{commits, loc_changed, prs}'
```

**depends-on:** 1

---

### Group 3: Review

**Goal:** Verify the command works, output is clean, tests pass.

**Deliverables:**
1. Run `genie stats` and verify output matches real DB data
2. Run `genie stats --json` and verify schema
3. Run `bun test` — all tests pass
4. Verify test data filtering works

**depends-on:** 1, 2

---

## Files to Create/Modify

```
src/term-commands/stats.ts          (new — main command)
src/term-commands/stats.test.ts     (new — tests)
src/term-commands/index.ts          (modify — register command)
```
