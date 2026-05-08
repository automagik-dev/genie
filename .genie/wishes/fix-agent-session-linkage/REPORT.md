# Wish Report — fix-agent-session-linkage

## Baseline (Group 1)

Captured 2026-05-01 from worktree `/home/genie/.genie/worktrees/dev-pin/fix-agent-session-linkage` on branch `fix-agent-session-linkage` before any production code changed.

### Local DB — pgserve auto-discovered

Linkable orphan sessions (the wish's primary signature):

```text
$ genie --no-tui db query "select count(*) from sessions s join executors e on s.id = e.claude_session_id where s.executor_id is null"
[pgserve] connected to postgres
count
-----
6
(1 row)
```

Sessions table breakdown:

```text
$ genie --no-tui db query "select count(*) as total_sessions, count(*) filter (where executor_id is null) as null_executor, count(*) filter (where status = 'orphaned') as status_orphaned, count(*) filter (where team = '') as empty_team, count(*) filter (where wish_slug = '') as empty_wish, count(*) filter (where role = '') as empty_role from sessions"
total_sessions | null_executor | status_orphaned | empty_team | empty_wish | empty_role
---------------+---------------+-----------------+------------+------------+-----------
1857           | 1855          | 1848            | 0          | 0          | 0
(1 row)
```

Sample of the 6 linkable orphans (executor + agent already known, session row left orphaned):

```text
$ genie --no-tui db query "select s.id as session_id, e.id as executor_id, e.agent_id, s.status, s.team, s.wish_slug from sessions s join executors e on s.id = e.claude_session_id where s.executor_id is null limit 10"
session_id                           | executor_id                          | agent_id                             | status   | team | wish_slug
-------------------------------------+--------------------------------------+--------------------------------------+----------+------+----------
510349ac-1ed1-4711-9848-e3fcf20e97bf | dcb65000-9b96-4a80-86d7-34c68e9231f3 | 3a177ff1-74bb-4afc-a5a1-515632b5244b | orphaned | NULL | NULL
9fa74a42-8906-4b60-b3ca-7f12e45308ac | 5eca1579-122f-4cd4-9c3f-4ebb75454e69 | 6dc4f849-d00c-402e-b458-f76ce13e9d0c | orphaned | NULL | NULL
8ef8af95-c81c-4005-9de3-c79955e3d56f | 43c1de18-7a1f-4ad6-9414-cee60e46f3f7 | 0a1ee6d2-0c21-4e4f-a6e1-22d246f36c46 | orphaned | NULL | NULL
1df7eb0f-69b7-4f2e-a760-cc3528827e81 | 44d0bf5b-a320-4b97-baa4-96f8d608dbeb | 7aceb6fd-d27b-4c91-8866-d1f10b8c0a64 | orphaned | NULL | NULL
36a3a605-65a9-4764-b4b8-e3088a7b2180 | 8ec2ef6d-e5bb-4155-bf11-2bf8bb0434db | dd88f205-ea8a-4e7b-a553-1ce33c9c9fd5 | orphaned | NULL | NULL
908c62d7-d1a2-470a-9cd1-388b1bbb80dd | b9a56d84-11b1-48b7-b5ad-ea3a97132bac | c4b74dc0-34cd-48e8-a79b-2cae7292755e | orphaned | NULL | NULL
(6 rows)
```

`tool_events` attribution baseline (the empty-string vs NULL bug from wish decision #4):

```text
$ genie --no-tui db query "SELECT count(*) FILTER (WHERE agent_id IS NULL OR agent_id = '') AS missing_agent, count(*) FILTER (WHERE wish_slug IS NULL OR wish_slug = '') AS missing_wish, count(*) FILTER (WHERE agent_id = '') AS empty_agent_str, count(*) FILTER (WHERE wish_slug = '') AS empty_wish_str, count(*) AS total FROM tool_events"
missing_agent | missing_wish | empty_agent_str | empty_wish_str | total
--------------+--------------+-----------------+----------------+------
70735         | 71052        | 70735           | 71052          | 71052
(1 row)
```

Read: 70 735 of 71 052 tool_events have empty-string `agent_id` (and `team`); 71 052 — i.e. **every** row — has empty-string `wish_slug` and `task_id`. None of these are NULL — the bug is exactly the empty-string write the wish flagged.

### Remote DB (`ssh felipe`) — BLOCKED

The wish's validation block contains:

```bash
ssh felipe 'export PATH=…; cd /home/genie/workspace/repos/genie && genie --no-tui db query "select count(*) from sessions s join executors e on s.id = e.claude_session_id where s.executor_id is null"'
```

Three resolution attempts from this worktree:

```text
$ ssh felipe 'echo ok'
ssh: Could not resolve hostname felipe: Name or service not known

$ ssh -o StrictHostKeyChecking=accept-new felipe-personal 'echo ok'   # tailscale alias
genie@felipe-personal: Permission denied (publickey,password).

$ ssh -i ~/.ssh/id_ed25519 felipe 'echo ok'
ssh: Could not resolve hostname felipe: Name or service not known
```

`tailscale status | grep felipe` shows reachable hosts (`felipe-personal`, `hapvida-genie-1`, etc.) but none of them accept this worker's keypair as `genie@…`. The pre-existing reference numbers from the wish (1854 sessions, 1852 with NULL `executor_id`) stand as the remote baseline until a key is provisioned. Group 4 (cross-instance verification) will need this resolved before it can run.

### Failing test reproduction (acceptance criterion #1)

```text
$ bun test src/lib/session-capture.test.ts src/services/executors/__tests__/sdk-session-capture.test.ts
…
src/lib/session-capture.test.ts:
…
399 |     expect(row.executor_id).toBe(executorId);
                                  ^
error: expect(received).toBe(expected)
Expected: "exec-orphan-upgrade"
Received: null
(fail) ingestion upgrades existing orphan sessions when executor context appears later > orphan session matching executors.claude_session_id is linked after ingestion

src/services/executors/__tests__/sdk-session-capture.test.ts:
…
144 |       expect(sql).toContain('ON CONFLICT (id) DO UPDATE');
                        ^
error: expect(received).toContain(expected)
Expected to contain: "ON CONFLICT (id) DO UPDATE"
Received: "INSERT INTO sessions (id, agent_id, executor_id, team, role, wish_slug, status, jsonl_path, project_path)
          VALUES (?, ?, ?, ?, ?, ?, 'active', '', '')
          ON CONFLICT (id) DO NOTHING
          RETURNING id"
(fail) sdk-session-capture > startSession > uses ON CONFLICT DO UPDATE so existing orphan rows get linkage filled in

 30 pass
 2 fail
 116 expect() calls
Ran 32 tests across 2 files.
```

The two failures pin the two distinct symptoms Group 2 must repair:

1. **Tmux JSONL ingestion path** — `ensureSession()` in `src/lib/session-capture.ts:333-364` early-returns when the session row already exists, so a row inserted as `orphaned` before the executor was known is never upgraded.
2. **SDK capture path** — `startSession()` in `src/services/executors/sdk-session-capture.ts:38-44` uses `ON CONFLICT (id) DO NOTHING`, so when ingestion has already created the orphan row, the SDK insert silently drops the linkage.

### Diagnostic helper

`src/lib/session-link-repair.ts` exposes:

- `diagnoseSessionLinks(sql)` — counts (linkable orphans, NULL `executor_id`, status='orphaned', tool-event missing-attribution, empty-string vs NULL split for both `sessions` and `tool_events`).
- `sampleLinkableOrphanSessions(sql, limit)` — preview of rows a future repair would touch.
- `findAmbiguousExecutorSessions(sql)` — surfaces duplicate `claude_session_id` claims so Group 3 can refuse `--apply` on ambiguity (per the Risk register).

All three are pure SELECTs. No `INSERT/UPDATE/DELETE`. They are wired up to be the engine behind the future `genie sessions repair-links --dry-run` (Group 3).

### Acceptance — Group 1

- [x] Test fails on current code because the session remains orphaned.
- [x] Diagnostic query reports affected counts without mutating data.
- [x] Baseline includes local `genie db query` evidence; **remote (`ssh felipe`) blocked** — see above.

## Group 2 — Ingestion Fix

### Code changes

- `src/lib/session-capture.ts` (`ensureSession`):
  - Replaced the early-return-on-existing-row path with a COALESCE-style upgrade.
  - SELECT now reads `executor_id, role, status` in addition to the previous five columns so we can detect when an orphan can be linked.
  - When `workerMap.get(sessionId)` returns context AND the existing row has any of `executor_id / agent_id / team / wish_slug / task_id / role` set to NULL (or `status = 'orphaned'`), we run `UPDATE … SET <field> = COALESCE(<field>, $worker_value), …, status = CASE WHEN status = 'orphaned' AND $agent IS NOT NULL THEN 'active' ELSE status END … RETURNING …` and return the upgraded row.
  - Fully-linked rows are detected by `needsUpgrade === false` and skip the UPDATE entirely (zero churn for already-correct sessions). `completed` / `crashed` statuses are untouched.
- `src/lib/session-capture.ts` (`batchInsertToolEvents`):
  - `agent_id`, `team`, `wish_slug`, `task_id` array fallbacks changed from `?? ''` to `?? null`. The `::text[]` cast on the unnest still works — postgres.js passes JS `null` through as SQL `NULL`. The other fields (`sub_tool`, `tool_use_id`, `input_raw`, `output_raw`, `error_message`, `duration_ms`) are out of scope per the wish.
- `src/services/executors/sdk-session-capture.ts` (`startSession`):
  - `ON CONFLICT (id) DO NOTHING` → `ON CONFLICT (id) DO UPDATE SET agent_id = COALESCE(sessions.agent_id, EXCLUDED.agent_id), … status = CASE … END, updated_at = now()`.
  - Same COALESCE protection: a previously-linked session never gets downgraded.
  - Same status flip: `orphaned` → `active` only when the SDK call brings a non-null agent.

### Acceptance — Group 2

- [x] Both Group 1 failing tests now pass (orphan upgrade + SDK `ON CONFLICT DO UPDATE`).
- [x] Pre-existing linked sessions are not downgraded — covered by the regression test added in Group 1 (`ingestion does NOT downgrade an existing fully-linked session (stays linked)`), now passing alongside the new bug fix.
- [x] New tool_events store NULL for missing optional fields, not empty strings — covered by the Group 1 regression test on the SDK side (`does not write empty strings for missing observability fields`) plus the `?? null` change to `batchInsertToolEvents`.

### Validation

```text
$ bun test src/lib/session-capture.test.ts src/services/executors/__tests__/sdk-session-capture.test.ts
bun test v1.3.11 (af24e281)

src/lib/session-capture.test.ts:
[test-setup] reusing pgserve on port 20900 (pid 2140350)

 32 pass
 0 fail
 122 expect() calls
Ran 32 tests across 2 files. [534.00ms]
```

```text
$ bun run typecheck
$ tsc --noEmit
(clean — no errors)
```

Tree-wide regression check (informational, not in the wish's validation block):

```text
$ bun test src/lib/ src/services/
 2824 pass
 0 fail
 6997 expect() calls
Ran 2824 tests across 125 files.
```

No fix downgrades any existing context — confirmed by both the unit-level `… does NOT downgrade an existing fully-linked session …` regression test and the broader 2824-test run staying green.

## Group 3 — Repair Command

### Code added

- `src/term-commands/sessions.ts` — new `genie sessions repair-links` subcommand:
  - `--dry-run` (default) — calls `diagnoseSessionLinks` / `sampleLinkableOrphanSessions` / `findAmbiguousExecutorSessions` from `src/lib/session-link-repair.ts`. Prints counts and a 10-row preview. Mutates nothing.
  - `--apply` — runs the repair inside a single `sql.begin(...)` transaction:
    1. Re-counts candidates inside the transaction; aborts with a non-zero exit if the count drifted from the pre-transaction preview AND `--force` was not passed.
    2. `UPDATE sessions … FROM executors e LEFT JOIN agents a … WHERE s.id = e.claude_session_id AND s.executor_id IS NULL` with COALESCE for every nullable field. `status = CASE WHEN s.status = 'orphaned' THEN 'active' ELSE s.status END` so completed/crashed never get clobbered.
    3. `UPDATE tool_events te … FROM sessions s WHERE s.id = te.session_id AND s.executor_id IS NOT NULL AND ((te.X IS DISTINCT FROM COALESCE(NULLIF(te.X, ''), s.X)) OR …)` — `IS DISTINCT FROM` filters out no-op updates so the transaction count is the *effective* repair count, not the broad "anything missing" count. `NULLIF(field, '')` lets the legacy empty-string writes inherit linked-session attribution.
    4. Audit row written via `tx.json(...)` (not `JSON.stringify`, which silently stores a JSONB string-of-string instead of a real object — verified the existing repo idiom in `src/lib/audit.ts:35`). `details` carries `sessions_linked`, `tool_events_backfilled`, `preview_count`, `recount`, `forced` — totals only, never raw session content.
  - `--force` overrides both the candidate-count drift gate AND the ambiguity gate (`findAmbiguousExecutorSessions` returns multi-executor matches).
  - `--json` output for both modes.
- `src/lib/audit-events.ts` — added `'sessions.repair_links'` to the `AuditEventType` union.

### Acceptance — Group 3

- [x] `--dry-run` mutates zero rows — verified by row-count snapshot before/after the dry-run (sessions: 1861 → 1861, tool_events: 71397 → 71397, last `sessions.repair_links` audit timestamp identical).
- [x] `--apply` links sessions by `executors.claude_session_id` — first apply on local DB linked 10 sessions, post-apply linkable-orphan count = 0.
- [x] `--apply` backfills tool_events attribution from linked sessions — first apply backfilled 688 rows.
- [x] Idempotent — successive applies converge to `sessions linked: 0, tool_events backfilled: 0` (intermediate runs may show small non-zero counts due to concurrent ingestion landing new rows; once ingestion is quiet the count is 0).

### Local repair transcript (canonical run)

Pre-apply snapshot:

```text
$ ./dist/genie.js --no-tui db query "select (select count(*) from sessions) as total_sessions, (select count(*) from sessions s join executors e on s.id = e.claude_session_id where s.executor_id is null) as linkable_orphans, (select count(*) from sessions where status = 'orphaned') as status_orphaned, (select count(*) from tool_events) as total_te, (select count(*) from tool_events where agent_id = '') as te_empty_agent"
total_sessions | linkable_orphans | status_orphaned | total_te | te_empty_agent
---------------+------------------+-----------------+----------+---------------
1861           | 10               | 1852            | 71374    | 71005
```

Dry-run (excerpt):

```text
$ ./dist/genie.js --no-tui sessions repair-links --dry-run
repair-links --dry-run (no rows mutated)
-----------------------------------------
Sessions:
  total: 1861
  linkable orphans (sessions.id = executors.claude_session_id ∧ executor_id IS NULL): 10
  status='orphaned': 1852
  NULL executor_id: 1859
Tool events:
  total: 71373
  ...
  linkable (session has executor_id, event missing attribution): 160

Linkable orphan sample (up to 10):
  11d32a40-…  executor=9e8ebbac-c33  agent=e322c2a5-ca0  status=orphaned
  ac889140-…  executor=b2b6319d-828  agent=52a3d02c-97c  status=orphaned
  …
Run with --apply to repair 10 session(s) and up to 160 tool_event(s).
```

Apply:

```text
$ ./dist/genie.js --no-tui sessions repair-links --apply
repair-links --apply complete
  sessions linked:        10
  tool_events backfilled: 688
```

Post-apply verification (the wish's headline query):

```text
$ ./dist/genie.js --no-tui db query "select count(*) from sessions s join executors e on s.id = e.claude_session_id where s.executor_id is null"
count
-----
0
(1 row)
```

Idempotent re-apply (after concurrent ingestion settled):

```text
$ ./dist/genie.js --no-tui sessions repair-links --apply
repair-links --apply complete
  sessions linked:        0
  tool_events backfilled: 1
$ ./dist/genie.js --no-tui sessions repair-links --apply
repair-links --apply complete
  sessions linked:        0
  tool_events backfilled: 0
```

Audit row landed correctly (JSONB outer type = `object`, keys extract):

```text
$ ./dist/genie.js --no-tui db query "select jsonb_typeof(details) as outer_type, details->>'sessions_linked' as linked, details->>'tool_events_backfilled' as te, details->>'forced' as forced from audit_events where event_type = 'sessions.repair_links' order by created_at desc limit 1"
outer_type | linked | te | forced
-----------+--------+----+-------
object     | 0      | 12 | false
```

### Group 4 — DEFERRED

Group 4 (cross-instance verification on `ssh felipe`) remains blocked on operator key provisioning for the `felipe-personal` tailscale alias (see Group 1 baseline). When that lands, the Group 4 plan is:

```bash
ssh felipe 'export PATH=…; cd /home/genie/workspace/repos/genie && genie --no-tui sessions repair-links --dry-run'
ssh felipe 'export PATH=…; cd /home/genie/workspace/repos/genie && genie --no-tui sessions repair-links --apply'
ssh felipe 'export PATH=…; cd /home/genie/workspace/repos/genie && genie --no-tui db query "select count(*) from sessions s join executors e on s.id = e.claude_session_id where s.executor_id is null"'
```

The wish's reference numbers (1854 sessions, 1852 NULL `executor_id` on the felipe instance) suggest the apply will link a few thousand sessions; tool_events backfill will be similarly large.

## QA Results

Captured 2026-05-01 by `qa` agent on local DB after Groups 1-3 landed. Group 4 (`ssh felipe`) remains BLOCKED on operator key provisioning — out of QA scope. All checks executed via `./dist/genie.js` (worktree dist 4.260501.4).

### Wish QA Criteria

| # | Criterion | Method | Evidence | Status |
|---|-----------|--------|----------|--------|
| 1 | `genie sessions list` shows linked agent/executor ownership | `./dist/genie.js --no-tui sessions list` | Repaired sessions render with non-empty Agent + Team columns (e.g. `1df7eb0f-69b → engineer → fix-agent-session-linkage`, `8ef8af95-c81 → genie-pgserve → genie`, `b8075629-c63 → genie → genie`). All 14 executor-linked sessions show `status=active`. Pre-existing standalone orphans (no matching executor) correctly remain `(orphaned)`. | PASS |
| 2 | `genie log <agent>` includes session/tool history from repaired rows | `./dist/genie.js --no-tui log engineer` | Returned 32 events for the `engineer` agent on the previously-orphaned session `1df7eb0f`. Cross-check `select count(*) from tool_events te join sessions s on s.id=te.session_id where s.id='1df7eb0f-…' and te.agent_id is not null and te.agent_id != ''` → **153** attributed events on that one repaired session. | PASS |
| 3 | Re-running `--apply` is idempotent | Engineer transcript at REPORT.md:264-273 shows successive applies converge to `(0,0)`. Re-execution of `--apply` blocked per operator instructions ("DO NOT run `--apply` again"). Code path confirmed at `src/term-commands/sessions.ts:517-525` (`noWork` short-circuit returns before the transaction). | First post-fix apply linked 10 / 688; second `(0,1)`; third `(0,0)`. New audit row at 18:39:05 also shows `linked=0, te=20, preview_count=0` — same idempotent shape on a follow-up run. | PASS |
| 4 | Safe on a DB with zero affected rows | `./dist/genie.js --no-tui sessions repair-links --dry-run` on current DB | First dry-run: `linkable orphans: 0`, dry-run reports `Run with --apply to repair 0 session(s) and up to 765 tool_event(s)`. The 765 are pre-existing tool_events with empty-string attribution that `--apply` would still backfill — the command is *safe* (zero session writes when count is 0) but not yet at the (0,0) terminal state because legacy empty-string tool_events keep accumulating from the OLD global daemon. See INFO #1 below. | PASS |

### Additional Structured Checks

**1. Audit event integrity** — `select created_at, jsonb_typeof(details), details::text from audit_events where event_type = 'sessions.repair_links' order by created_at desc limit 5`

```
created_at  | outer_type | details
18:39:05    | object     | {"forced": false, "recount": 0, "preview_count": 0, "sessions_linked": 0, "tool_events_backfilled": 20}
18:30:15    | object     | {"forced": false, "recount": 0, "preview_count": 0, "sessions_linked": 0, "tool_events_backfilled": 0}
18:30:14    | object     | {"forced": false, "recount": 0, "preview_count": 0, "sessions_linked": 0, "tool_events_backfilled": 1}
18:29:52    | object     | {"forced": false, "recount": 0, "preview_count": 0, "sessions_linked": 0, "tool_events_backfilled": 12}
18:27:28    | string     | "{\"sessions_linked\":0,\"tool_events_backfilled\":0,\"preview_count\":0,\"recount\":0,\"forced\":false}"
```

- All 4 latest rows are JSONB `object` type with the 5 required keys (`sessions_linked`, `tool_events_backfilled`, `preview_count`, `recount`, `forced`). PASS.
- Zero raw session content / paths / agent identifiers stored — `details` is totals-only as the wish required. PASS.
- 5 of 9 historical `sessions.repair_links` rows have `outer_type = 'string'` — pre-fix artifacts from the engineer's earlier iteration before adopting `tx.json(...)`. Inert legacy data, not a regression. **WARN**: see INFO #2.

**2. Empty-string regression (new tool_events should write NULL not '')** — `select count filter (where agent_id = '') / (where agent_id is null) ... from tool_events where timestamp > now() - interval '10 minutes'`

```
empty_agent | null_agent | empty_team | null_team | empty_wish | null_wish | empty_task | null_task | total
4           | 0          | 4          | 0         | 63         | 5         | 63         | 5         | 68
```

- Source code at `src/lib/session-capture.ts:714-717` correctly uses `?? null` for all four observability fields (verified by direct read). PASS at code level.
- Unit tests confirm: `bun test src/lib/session-capture.test.ts src/services/executors/__tests__/sdk-session-capture.test.ts` → 32 pass / 0 fail. PASS.
- Live DB still shows empty-string writes from concurrent ingestion. Cause: the running daemons execute the OLD globally-installed binary (`/home/genie/.bun/.../genie.js` v4.260501.5, zero `repair-links` matches in compiled source) — this branch's fix is in `./dist/genie.js` (5 `repair-links` matches) but not yet promoted globally. Production fix lands on merge + reinstall. **INFO**: see INFO #1.

**3. JSON mode** — `./dist/genie.js --no-tui sessions repair-links --json | jq '. | keys, .diagnostics.linkableOrphanSessions, .sample | length'`

```
3            ← 3 top-level keys: diagnostics, sample, ambiguous
2            ← linkableOrphanSessions
2            ← sample length
```

JSON parses cleanly through `jq`. Shape matches expectation: `{ diagnostics, sample, ambiguous }` with `diagnostics` carrying all the count fields. PASS.

**4. --force gating code path** — drift gate at `src/term-commands/sessions.ts:375-380`:

```ts
if (recount.n !== previewCount && !force) {
  result.driftDetected = true;
  throw new Error(`repair-links: candidate count drifted between preview (${previewCount}) and apply (${recount.n}). Re-run --dry-run or pass --force to override.`);
}
```

Ambiguity gate at `src/term-commands/sessions.ts:510-515`:

```ts
if (ambiguous.length > 0 && !options.force) {
  console.error(`repair-links: ${ambiguous.length} ambiguous claude_session_id value(s) found. ... refusing --apply.`);
  process.exit(2);
}
```

Both gates present and correctly check `!force`. PASS at code level. **WARN**: zero automated test coverage — `grep -rln "applyRepairTransaction\|findAmbiguousExecutorSessions\|diagnoseSessionLinks" src --include='*.test.ts'` returns no matches. The gates are exercised only by manual operator runs. Not blocking but flagged for follow-up tightening (see INFO #3).

**5. Build/install discipline** — global `genie` binary lags this branch:

```
$ which genie               → /home/genie/.local/bin/genie → /home/genie/.bun/bin/genie → .../node_modules/@automagik/genie/dist/genie.js
$ genie --version           → 4.260501.5
$ ./dist/genie.js --version → 4.260501.4
$ grep -c repair-links /home/genie/.bun/install/global/.../genie.js  → 0
$ grep -c repair-links dist/genie.js                                  → 5
```

The new `genie sessions repair-links` subcommand is **not** discoverable via the global binary. All operator-facing commands during QA had to be invoked as `./dist/genie.js`. PASS — this is the expected feature-branch state pre-merge — but **WARN**: post-merge, the global install must be rebuilt and re-published before operators can run the canonical `genie sessions repair-links --dry-run` from any cwd. See INFO #1.

### Anomalies

| Severity | ID | Description |
|----------|----|-------------|
| INFO | 1 | Global `genie` (4.260501.5) does not contain the Group 1-3 fix; running daemons still write empty-string attribution. Code-level fix is correct (`?? null` at `src/lib/session-capture.ts:714-717`); live remediation requires merge + global rebuild. Pre-merge expected; not a regression. |
| WARN | 2 | 5 of 9 `audit_events.sessions.repair_links` rows have `details` stored as JSONB string (not object) — pre-fix artifacts from before the engineer switched to `tx.json(...)`. Inert legacy data. Optional cleanup: `UPDATE audit_events SET details = (details #>> '{}')::jsonb WHERE event_type = 'sessions.repair_links' AND jsonb_typeof(details) = 'string'`. Not blocking. |
| WARN | 3 | The `applyRepairTransaction` drift gate, the `findAmbiguousExecutorSessions` ambiguity gate, and `diagnoseSessionLinks` have zero automated test coverage. Functionality verified manually; future regressions would land silently. Recommend a `src/term-commands/sessions.test.ts` companion with table-driven tests over the gates. |

### Test suite

```
$ bun test src/lib/session-capture.test.ts src/services/executors/__tests__/sdk-session-capture.test.ts
32 pass / 0 fail / 122 expect() calls
```

Wish-scoped unit tests stay green. Engineer's tree-wide run (REPORT.md:182-184) showed 2824 pass / 0 fail across `src/lib/` + `src/services/`.

### Verdict

**PASS**

All four wish QA criteria verified with evidence. All four additional structured checks pass at code level with three INFO/WARN observations, none of which block ship. The Group 1-3 deliverables are functionally and structurally correct on the local DB; Group 4 (`ssh felipe` cross-instance) remains operator-blocked and is appropriately deferred.

---

## Review Results

**Verdict: SHIP**

Reviewed commits `595060f8`, `2e94b06c`, `b25d1ef3` against `WISH.md` Groups 1–3. Group 4 explicitly out of scope (operator key blocker).

### Phase 1 — Spec Compliance (independently verified — read each cited line, did not just trust REPORT)

**Group 2 acceptance — all PASS:**
- [x] Existing orphan upgrade: `src/lib/session-capture.ts:333-412` — SELECT broadened to read `executor_id, role, status`; `needsUpgrade` flips on any-NULL-or-orphaned; UPDATE uses `COALESCE(field, $worker)` per column. Test `src/lib/session-capture.test.ts:361` exercises end-to-end.
- [x] SDK conflict path fills missing linkage: `src/services/executors/sdk-session-capture.ts:48-62` — `ON CONFLICT (id) DO UPDATE SET <field> = COALESCE(sessions.<field>, EXCLUDED.<field>)` for all five linkage columns plus `orphaned → active` status flip. Test `__tests__/sdk-session-capture.test.ts:139` pins.
- [x] Tool events store NULL not '': `session-capture.ts:714-717` — `?? null` for `agent_id`, `team`, `wish_slug`, `task_id`. Test `__tests__/sdk-session-capture.test.ts:148` (`expect(...).not.toContain('')`).
- [x] No downgrade: COALESCE guards both ingestion and SDK paths. Regression test `session-capture.test.ts:411` (`does NOT downgrade an existing fully-linked session`) is green.

**Group 3 acceptance — all PASS:**
- [x] Dry-run mutates zero rows: `src/term-commands/sessions.ts:502-507` returns before any UPDATE; `src/lib/session-link-repair.ts` is pure SELECT (read-verified, zero `INSERT/UPDATE/DELETE`). Live re-run during this review on local DB confirmed: 3 candidates printed, count unchanged.
- [x] Apply links by `executors.claude_session_id`: `sessions.ts:382-396` — exact `WHERE s.id = e.claude_session_id AND s.executor_id IS NULL`. Risk 1 mitigated as wish demanded.
- [x] Apply backfills tool_events: `sessions.ts:408-423` — `COALESCE(NULLIF(te.<field>, ''), s.<field>)` treats legacy empty-string writes as missing while preserving any non-empty existing value. Risk 2 mitigated.
- [x] Idempotent: `IS DISTINCT FROM` filter at `sessions.ts:417-422` skips no-op rows. REPORT transcript shows convergence to (0,0). Confirmed.

**Risk register — all addressed in code:**
- Risk 1 (genuine non-executor orphans): exact-id join — confirmed.
- Risk 2 (overwrite better history): `COALESCE(NULLIF(...), …)` — confirmed.
- Risk 3 (ambiguous executors): `findAmbiguousExecutorSessions` wired at `sessions.ts:500`; gate at `sessions.ts:510-515` exits with code 2 unless `--force` — confirmed.

**Drift gate (Group 3 deliverable #4):** `sessions.ts:368-380` re-counts inside the transaction, throws on drift unless `--force`. Acknowledged TOCTOU window between dry-run and apply is documented in code comment.

**Audit event:** `'sessions.repair_links'` added to `src/lib/audit-events.ts:30`; `sessions.ts:429-444` writes via `tx.json({ totals })` matching the existing `src/lib/audit.ts:35` (`sql.json`) idiom. Payload is totals-only — verified, no raw session content.

**Files-to-Modify drift:** Wish lists 7 files; engineer touched all 7 plus a single-line type union addition to `src/lib/audit-events.ts` (necessary for Group 3 deliverable #3 — not scope creep). Version bumps in `package.json`/`marketplace.json` belong to prior auto-version commit `d0b834f2`, not the engineer's three commits.

**Validation re-run during this review:**
- `bun test src/lib/session-capture.test.ts src/services/executors/__tests__/sdk-session-capture.test.ts` → 32/32 pass
- `bun run typecheck` → clean
- `./dist/genie.js --no-tui sessions repair-links --dry-run` → 3 linkable orphans, 867 backfillable tool_events, zero mutations

### Phase 2 — Code Quality

Zero CRITICAL, zero HIGH findings. Code is well-commented (explains *why* COALESCE, *why* NULLIF, *why* IS DISTINCT FROM, *why* tx.json). Single-transaction apply, parameterized queries throughout, proper exit codes on gates.

**Optional follow-on (advisory only — do not block ship):**

- **[LOW] sessions.ts:519-523** — JSON output for the no-work apply path is `{ sessionsLinked, toolEventsBackfilled, idempotent }`, a different shape from the regular `RepairLinksApplyResult` (which carries `ambiguousCount`, `forced`, `driftDetected` too). Consider returning a unified shape so JSON consumers see one schema.
- **[LOW] sessions.ts:325** — `empty-string wish_slug:70865` is missing the space after the colon that other lines have. Cosmetic.
- **[LOW] No automated coverage on the `applyRepairTransaction` drift / ambiguity gates** (already flagged by QA WARN #3). Recommend a `src/term-commands/sessions.test.ts` companion with table-driven gate tests as a follow-up.

None of these block ship. The core repair surface — transaction boundaries, COALESCE-with-NULLIF semantics, gate logic, audit shape — is correct and production-ready.

**Verdict: SHIP** — all Group 1–3 acceptance bullets met, all wish risks mitigated in code, dry-run-by-default verified non-mutating, applies idempotent. Group 4 deferral is appropriate and documented.

## Tightening Pass

After review converged on three LOW findings (two from reviewer, one from qa) — all advisory — the following tightening commit landed before pushing.

### Code changes

- **`src/term-commands/sessions.ts`**
  - Extracted `evaluateAmbiguityGate(ambiguousCount, force)` and `buildNoWorkResultIfApplicable(diag, ambiguousCount, force)` as exported pure functions so the gate decisions are unit-testable without `process.exit` / live DB.
  - Promoted `applyRepairTransaction(sql, previewCount, force)` from internal to `export`ed for the same reason.
  - Wired the new helpers into `sessionsRepairLinksCommand` — single source of truth, command stays thin.
  - **Closes [LOW] sessions.ts:519-523** — no-work apply path now returns a full `RepairLinksApplyResult` shape (`sessionsLinked / toolEventsBackfilled / ambiguousCount / forced / driftDetected`) instead of the ad-hoc `{ sessionsLinked, toolEventsBackfilled, idempotent }`. JSON consumers see one schema regardless of whether work happened.
  - **Closes [LOW] sessions.ts:325** — `empty-string wish_slug:` now has a space before its value, matching the other diagnostic lines.

- **`src/term-commands/sessions.test.ts`** (NEW, 10 tests)
  - **Drift gate** (3 tests): in-tx recount mismatch + no `--force` throws with the documented message and skips both UPDATEs; same scenario with `--force` proceeds and runs both UPDATEs + audit insert; matching recount runs cleanly without `--force`.
  - **Ambiguity gate** (3 tests): `ambiguousCount > 0` + no `--force` blocks with the documented message; `--force` lifts the block; zero ambiguous sessions never blocks.
  - **No-work short-circuit** (4 tests): zero linkable orphans + zero linkable tool_events returns the unified zero-valued `RepairLinksApplyResult` shape; `ambiguousCount` and `forced` are threaded through transparently; non-zero linkable orphans returns `null` (work pending); non-zero linkable tool_events returns `null` (work pending).
  - Tests use a stubbed postgres.js `Sql` client (tagged-template + `.begin(cb)` + `.json(...)`) — no live DB required.

### Validation

```text
$ bun test src/term-commands/sessions.test.ts
 10 pass
 0 fail
 25 expect() calls

$ bun test src/lib/session-capture.test.ts src/services/executors/__tests__/sdk-session-capture.test.ts
 32 pass
 0 fail
 122 expect() calls

$ bun run typecheck
$ tsc --noEmit
(clean)

$ bunx biome check src/term-commands/sessions.ts src/term-commands/sessions.test.ts
Found 5 warnings.   # pre-existing complexity warnings only — zero errors
```

Two of the three reviewer LOWs are now closed in code (`525-Inconsistent-JSON-shape`, `325-cosmetic-spacing`); the third (`No automated coverage on gates`) is closed by the new test file. QA WARN #3 (same finding) is also closed.

