# Trace: `bun test` PG Deadlock Flakiness

## Observed

`bun test` fails with 1–10 flaky failures per run, all in `src/term-commands/team.test.ts` > `pg` block:

```
PostgresError: deadlock detected
  detail: "Process X waits for AccessExclusiveLock on relation Y of database genie;
           blocked by process Z.
           Process Z waits for AccessShareLock on relation W of database genie;
           blocked by process X."
```

Number of failures is non-deterministic (1, 3, 5, 7, 10 across successive runs). Pre-push hook `(bun test || bun test)` runs tests twice; both attempts fail with different flaky counts, so the hook rejects the push.

## Architecture Today

Evidence from `src/lib/db.ts` and `src/lib/test-db.ts`:

1. A single `pgserve` process listens on port **19642** with data at `~/.genie/data/pgserve` (persistent disk).
2. `genie serve --headless` owns this pgserve. The daemon uses it for agents, tasks, events, wishes, executors — continuous writes while active.
3. Tests call `ensurePgserve()` → same port. Each of 103 test files runs `CREATE SCHEMA test_<pid>_<ts>` → `runMigrations(search_path=schema)` → `DROP SCHEMA CASCADE` in `beforeAll`/`afterAll`.
4. Schema isolation from the parent wish `test-schema-isolation` (SHIPPED 2026-03-24) solved **data leakage** but does not touch lock scope: `CREATE SCHEMA`, `DROP SCHEMA CASCADE`, `CREATE TABLE` inside a schema, and `_genie_migrations` upserts all take **database-level** locks on shared catalog relations (`pg_namespace`, `pg_class`, `pg_depend`, `pg_attribute`).

## Why The Deadlock Fires

Under concurrent load the lock graph becomes asymmetric:

- **Writer A: tests** — 103 files concurrently `CREATE SCHEMA` + `runMigrations` + `DROP SCHEMA CASCADE`. Each takes `AccessExclusiveLock` on new/dropped objects and `AccessShareLock` on catalogs while reading `_genie_migrations`.
- **Writer B: the daemon** — continuously inserts events, updates agent registry rows, writes task state. Takes `RowExclusiveLock` on `public.agents`, `public.events`, etc., plus `AccessShareLock` on catalogs to resolve those relations.
- **Lock ordering divergence** — Writer A grabs catalog locks then object locks; Writer B grabs row locks then catalog locks for stats/plan cache invalidation. When their paths cross on `pg_class` / `pg_depend`, the deadlock detector picks a victim and aborts.

This is **not** a test code bug. Tests cleanly CREATE/DROP within their own schema. The bug is that a second, asymmetric writer (the daemon) exists on the same database at the same time.

## Reproduction

```bash
# Terminal 1: keep the daemon busy
genie serve start --headless
while true; do genie agent list >/dev/null; sleep 0.1; done

# Terminal 2: run the test suite
bun test
# Expect: 1-10 failures in team.test.ts > pg > *
```

Running `bun test src/term-commands/team.test.ts` in isolation → 0 failures. Running it under the full 103-file load with daemon active → flaky failures. This matches the Writer A + Writer B model.

## Why `pgserve --ram` on a Separate Port Fixes It

1. **One writer only** — a dedicated pgserve for tests has no daemon, no agents, no cross-process DML. Tests remain symmetric actors on the catalog, and symmetric actors do not deadlock.
2. **RAM I/O via `/dev/shm`** (252 GB free on this host, confirmed Linux) — eliminates fsync serialization that currently piles pressure onto the shared writer.
3. **Different port (20642)** — invisible to `genie serve`, `genie agent`, and any running daemon. Zero lockfile/port-file collision.
4. **Ephemeral** — process dies → `/dev/shm` segments freed by kernel → zero test artifacts, zero `~/.genie/data/pgserve` pollution.

## What This Trace Rules Out

- ❌ Test code bug — tests pass individually, fail only under concurrent daemon load.
- ❌ Migration ordering — `_genie_migrations` writes are per-schema, not the root cause.
- ❌ Schema isolation gap — schemas are correctly isolated for data; the gap is **database-level catalog lock scope**.
- ❌ PostgreSQL tuning — no amount of `deadlock_timeout` or `max_locks_per_transaction` tuning removes the fundamental cross-writer asymmetry.

## One-Sentence Conclusion

Tests and the live daemon share one physical PostgreSQL database, and their asymmetric lock orderings cause PostgreSQL's deadlock detector to abort one of them under load; the only clean fix is to give tests a dedicated pgserve.
