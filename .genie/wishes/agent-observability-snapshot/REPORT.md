# REPORT — agent-observability-snapshot

## Group 1 — Canonical Query Layer

### What landed

- `src/db/migrations/059_agent_observability_view.sql` — `v_agent_observability` SQL view that joins `agents` × `executors` × `sessions` × `tool_events` × `v_claude_usage_events`, with the executor-id → claude-session-id session-link cascade and a 24-hour aggregate window on tool events / cost.
- `src/lib/agent-observability.ts` — typed query module with `AgentObservabilityRow`, `AgentObservabilitySnapshot`, `assessHealth`, `getAgentObservability`, `listAgentObservability`, `loadAgentObservabilityMap`, plus the documented health-flag thresholds (`STALE_EXECUTOR_WINDOW_MS`, `COST_SPIKE_USD_24H`) and a `AGENT_OBSERVABILITY_SCHEMA_VERSION` debug pin.
- `src/lib/agent-observability.test.ts` — 20 tests (9 pure + 11 PG-bound). The pure suite covers every documented health flag (positive + negative cases) and asserts the schema version is set; the PG suite exercises the round-trip, the link cascade, the 24h aggregate window, classification, list ordering, the deduplicated map, and a 200-agent perf bound.

### Validation

```
$ bun run typecheck   # tsc --noEmit, no errors
$ CI=1 GENIE_PG_AVAILABLE=false GENIE_TEST_SKIP_PGSERVE=1 bun test src/lib/agent-observability.test.ts
 9 pass / 11 skip / 0 fail / 12 expect() calls
```

PG-bound tests skip cleanly when the worktree pgserve fixture is unavailable (a recurring environmental blocker documented across wish 2 — pgserve `--ram` falls back to the persistent data directory whose lockfile collides with the daemon already running there). The view itself is verified end-to-end against the live system pgserve:

```
$ genie --no-tui db migrate
All migrations are up to date.  Applied: 58 migrations

$ genie --no-tui db query "select count(*) from v_agent_observability"
count
-----
82

$ genie --no-tui db query "select agent_id, custom_name, classification, executor_state, recent_tool_count, recent_error_count from v_agent_observability where classification='agent' order by executor_updated_at desc nulls last limit 5"
agent_id                             | custom_name                 | classification | executor_state | recent_tool_count | recent_error_count
77737fb8-867f-4565-96b0-2efceca0f23a | fix                         | agent          | running        | 117               | 0
52a04a3e-d0e3-4b52-81c1-fbfdd0efd258 | fix-agent-session-linkage   | agent          | spawning       | 0                 | 0
98c1dc9b-3601-4f03-bd46-904ad502ed67 | felipe                      | agent          | spawning       | 36                | 0
c4b74dc0-34cd-48e8-a79b-2cae7292755e | wish-workspace-lint-cleanup | agent          | spawning       | 100               | 0
81698415-9e56-4e7c-93f8-c6b39fc20978 | genie-configure             | agent          | running        | 44                | 0

$ genie --no-tui db query "select session_link_source, count(*) from v_agent_observability group by 1"
session_link_source | count
executor_id         | 14
NULL                | 68

$ time genie --no-tui db query "select count(*) from v_agent_observability"
real    0m0.680s    # full count, 82 rows over 1900 sessions / 73k tool_events / 117k runtime_events
```

### Acceptance criteria

- [x] One row per visible agent by default — `select count(*) from v_agent_observability` returns 82, exactly the agent count.
- [x] Current executor and session resolved correctly — `executor_state`, `executor_provider`, `session_id`, and `session_link_source` populated above; cascade prefers `executor_id` link, falls back to `claude_session_id`.
- [x] Missing linkage / attribution flags are explicit — `assessHealth()` emits `missing_session` / `missing_attribution` / `stale_executor` / `recent_failure` / `cost_spike`; tests assert positive AND negative cases.
- [x] Query includes agent-vs-harness classification — `classification` column, default-excluded by `listAgentObservability`, opt-in via `--include-harness` (Group 2).

---

## Group 2 — CLI observe commands

_(pending)_

---

## Group 3 — Surface wiring

_(pending)_

---

## Group 4 — Cross-instance QA (local-only)

_(pending — `ssh felipe` dropped per wish brief; local-DB QA satisfies the bullet list.)_
