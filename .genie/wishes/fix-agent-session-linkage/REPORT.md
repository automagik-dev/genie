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
