# Wish: Canonical PG Relocation — Seamless `postgres`/8432 → Fingerprinted Socket DB

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `canonical-pg-relocation` |
| **Date** | 2026-05-15 |
| **Design** | Direct wish from live-server audit (`genie-pgserve` agent, 2026-05-15). pgserve enterprise roadmap v1.2 (database-per-fingerprint enforcement) consumer side. |

## Summary

Every genie install today connects as `postgres`/`postgres` to the **`postgres` default database** of the shared pgserve cluster and writes its entire dataset there. Verified live on the `genie-pgserve` server: 340 MB / 52 tables (`genie_runtime_events_*` ~250K rows, `session_content` 16K, `sessions`, `tasks`, `wishes`, `agents`, `teams`, `_genie_migrations`) all in `postgres` DB; five empty `app__automagik_genie_<hex>` husks from the now-fixed unstable-fingerprint bug (PR #2426); `pgserve_meta`/`autopg_meta` never bootstrapped. This is the worst possible posture for isolation: `postgres` is the DB every admin tool, scanner, and bare `psql` connects to by default, under a passwordless shared superuser. The target end-state (pgserve roadmap v1.2) is genie owning a dedicated fingerprinted database `app__automagik_genie_<stablefp>` accessed via a dedicated non-superuser role over the Unix socket. The hard problem this wish solves is **the data**: relocating an existing user's live dataset from `postgres` DB into their provisioned DB must happen **automatically, exactly once, crash-safe, and invisibly** the first time they run a genie binary at-or-past the canonical version — with zero operator action, zero data loss, and a guaranteed rollback anchor — across every user-state permutation (fresh install, legacy-with-data, already-migrated, crashed-mid-migration, concurrent boots, external/custom Postgres, pgserve-down). Because the relocation moves data out of the very `postgres` DB that holds `_genie_migrations`, it **cannot** be a normal numbered migration (a `06x_*.sql` runs *inside* the database it would be abandoning); it must execute at the connection-bootstrap layer, before `runPostConnectSetup`/`runMigrations`, gated by a filesystem + DB version sentinel, serialized by a postmaster-global advisory lock, under the invariant **source data is immutable until the copy is proven row-for-row**.

## Scope

### IN

- **Canonical relocation bootstrap.** New module `src/lib/pg-relocation.ts` invoked from `buildAndOpenConnection` (`src/lib/db.ts:~1190`) *after* `SELECT 1` succeeds against the legacy connection but *before* `runPostConnectSetup`. One-shot, idempotent, advisory-locked.
- **State classifier.** Cheap pre-flight that buckets the current host into exactly one of: `FRESH` (no legacy genie tables anywhere), `LEGACY_NEEDS_MIGRATION` (`postgres` DB has `_genie_migrations` + genie tables, target absent/empty), `ALREADY_MIGRATED` (filesystem sentinel present OR target DB has the relocation sentinel row), `SKIP` (test mode / external Postgres / `GENIE_PG_FORCE_TCP` / pgserve unreachable). Filesystem sentinel (`~/.genie/.canonical-relocation-v1.json`) makes the steady-state check O(1) with no DB round-trip.
- **Provisioning.** When `LEGACY_NEEDS_MIGRATION` or `FRESH`: ensure `app__automagik_genie_<fp>` database + dedicated `app__automagik_genie_<fp>_role` (LOGIN, random password) + GRANTs + `autopg_meta` row exist. Reuse `autopg provision` if the autopg binary is on PATH; otherwise inline the canonical CREATE ROLE / CREATE DATABASE OWNER / GRANT sequence (mirrors pgserve `src/commands/provision.js:runCreateSequence`).
- **Relocation engine.** Server-local `pg_dump -Fc` of the `postgres` DB `public` schema → `pg_restore --no-owner --role=<provisioned-role>` into the target DB, using the postgres binaries already bundled with the pgserve install (same cluster, same host — no network). Partitioned `genie_runtime_events` parent+children and `_genie_migrations` come over in the custom-format dump intact.
- **Proof gate.** Per-table `COUNT(*)` (or `reltuples` for the large partitioned set, with exact count on the small core tables) compared source vs target. Any mismatch ⇒ abort, drop the partial target DB, **stay on legacy**, emit a loud structured error, retry next boot. Success ⇒ write the relocation sentinel row in the target DB (`_genie_relocation`: source_db, completed_at, table_rowcounts jsonb, canonical_version) and the filesystem sentinel.
- **Cutover.** After proof, the live process and all subsequent connections use the provisioned role + target DB (extend `resolveDatabaseName()` / the username binding in `src/lib/db.ts`; see Group 3). Connection identity resolves from `autopg_meta` by fingerprint with a safe fallback to the legacy `postgres`/`postgres` pair if the row is absent.
- **Rollback anchor.** Source genie tables in `postgres` DB are **left intact** by this wish. A separate, later, age-gated GC (out of scope here, noted in Decisions) wipes them only after a soak window and only if the sentinel proves a successful relocation.
- **Concurrency.** `pg_advisory_lock(hashtext('genie:canonical-relocation-v1'))` on the postmaster (acquired on the legacy `postgres` connection) so exactly one process relocates; late arrivals block, then observe `ALREADY_MIGRATED` and proceed normally.
- **Observability.** Structured events at each phase (`relocation.classified`, `relocation.provisioned`, `relocation.dump.started/.completed`, `relocation.verified`, `relocation.cutover`, `relocation.aborted.<reason>`) so a fleet rollout is greppable and a stuck/aborted host is diagnosable without shell access.
- **`genie doctor --relocation-status`.** Read-only subcommand printing the classifier bucket, sentinel contents, source vs target row deltas, and the exact manual rollback command — for support and for users who want to verify.

### OUT

- **Deleting / GC-ing the legacy `postgres` DB genie tables.** Deliberately deferred to a future age-gated wish (`canonical-relocation-source-gc`) so this wish is fully reversible. Also out: GC of the 5 empty `app__automagik_genie_<hex>` husk DBs + empty `genie` / `genie_archive_*` DBs (zero-data, can be cleaned independently any time).
- **pgserve-side `pg_hba` hardening / removing `--auth-local=trust` / scram-on-TCP.** That is producer-side (autopg v3.x), tracked separately in the pgserve roadmap. This wish makes genie *connect as a dedicated role to a dedicated DB*; it does not change what the postmaster *permits*.
- **Schema changes to genie's tables.** The relocation is a byte-faithful copy; no schema migration rides along. Normal `runMigrations` continues to own schema evolution *after* cutover, inside the new DB.
- **Multi-tenant / multi-fingerprint consolidation.** If a host somehow has data split across multiple `app__automagik_genie_*` DBs (only possible on pre-#2426 binaries), this wish migrates from `postgres` only; cross-husk merge is explicitly not attempted (the husks are empty in every observed case).
- **Non-pgserve Postgres backends.** `DATABASE_URL`/external PG/`GENIE_TEST_PG_PORT` users are classified `SKIP` and never touched.

## Dependencies & Prerequisites

- **HARD: stable fingerprint (PR #2426, merged).** The target DB name is `app__automagik_genie_<fp>` where `<fp>` derives from `resolveGeniePackageDir()`. Pre-#2426 binaries produced a *different* fingerprint per cwd/`import.meta.dir`, which is exactly what created the 5 empty husks. The relocation MUST only run on binaries that include #2426, otherwise it could target a different DB each boot. Gate: the canonical-relocation bootstrap refuses to run (classifies `SKIP`, logs `relocation.skip.fingerprint-unstable`) unless `resolveGeniePackageDir()` returns a value via the stable (package.json or execPath) path. Practically this wish ships in a genie version strictly newer than the one that merged #2426.
- **pgserve provisioning primitives.** `autopg provision` (pgserve `src/commands/provision.js`) is the reference implementation for the CREATE ROLE/DB/GRANT/`autopg_meta` upsert. If the autopg binary is unavailable at relocation time, the inline fallback must stay byte-equivalent to that sequence (db/role naming via the same `deriveProvisionedNames` convention: `app__<publisher-slug>_<fp12>` / `..._role`).
- **Bundled postgres client binaries.** `pg_dump` / `pg_restore` matching the postmaster's major version must be resolvable from the pgserve install (the same binaries the postmaster runs). The bootstrap probes for them; if absent ⇒ classify `SKIP` + loud structured warning (never attempt a version-mismatched dump).
- **`genie.persist: true`** (already set in genie `package.json:110-111`) — guarantees the target DB is not TTL-reaped after cutover.
- **Boot-path placement.** Must run inside `buildAndOpenConnection` after the forced `SELECT 1` and before `runPostConnectSetup` (`src/lib/db.ts`), on the legacy connection, so `_genie_migrations` is never advanced in `postgres` DB after a relocation has begun.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Bootstrap layer, **not** a numbered migration | The relocation abandons the DB that stores `_genie_migrations`. A `06x_*.sql` runs inside that DB and cannot atomically hand off. The connection layer is the only place that sees "legacy conn established, target not yet live". |
| Source immutable until proven | The single safety invariant. `postgres` DB is read-only to the relocation; only `pg_dump` (read) touches it. Restart is always safe because the source is never mutated. Cutover happens only after row-for-row proof. |
| Filesystem sentinel as fast-path | Steady state (99.99% of boots) must cost ~0. A `~/.genie/.canonical-relocation-v1.json` stat short-circuits before any DB classification query. DB sentinel row is the source of truth; FS sentinel is the cache. |
| Postmaster-global advisory lock | Daemon + CLI + concurrent agents can all boot simultaneously after an upgrade. Exactly one must migrate; the rest must *not* see a half-copied DB. `pg_advisory_lock` on the shared postmaster is the only lock all of them share. |
| Leave source data (rollback anchor) | Relocation of a 340 MB→GB live dataset with no undo is unacceptable. Keeping `postgres` DB intact until a separate age-gated GC makes every step of this wish reversible with one documented command. |
| `pg_dump -Fc` over `CREATE DATABASE … TEMPLATE` | `TEMPLATE postgres` is blocked while any session is connected to `postgres` (always true — it is the default DB). Custom-format dump+restore is the only same-cluster path that preserves partitioned tables, sequences, and `_genie_migrations`. |
| Connect-as-provisioned-role with legacy fallback | Postel's Law / asymmetric-cohort: a missing `autopg_meta` row (e.g. pgserve mid-upgrade) must degrade to today's working `postgres`/`postgres` behavior, never hard-fail genie boot. |
| Version-keyed canonical sentinel (`-v1`) | "Canonical migration" = tied to a specific genie version line. The sentinel name carries the version so a future v2 relocation (if ever needed) is a distinct, independently-gated event. Downgrades below the canonical version are documented-unsupported (old binary would re-attach to the still-present source — mitigated by the rollback anchor + docs, not by code in old binaries). |

## Success Criteria

1. A legacy host (data in `postgres` DB) running the canonical genie binary for the first time relocates fully, automatically, with no operator action, and every source row count is reproduced in the target DB.
2. The same host's second boot does zero relocation work and incurs no measurable boot latency (filesystem sentinel fast-path).
3. A fresh host (no legacy data) provisions an empty target DB and never attempts a copy.
4. Killing the process at any point during dump/restore and rebooting results in a clean retry (partial target dropped, source untouched) and eventual success — proven by an injected-crash test.
5. Two genie processes booting simultaneously on a freshly-upgraded legacy host produce exactly one relocation; neither observes a partial DB; both end up on the target DB.
6. Test mode / external Postgres / pgserve-unreachable hosts are classified `SKIP`, never touched, and genie boots exactly as before.
7. Row-count mismatch (simulated by injecting a row mid-dump) aborts cleanly, drops the partial target, keeps the host on legacy, emits `relocation.aborted.rowcount-mismatch`, and retries next boot.
8. After cutover, `psql` as the dedicated role into the target DB sees the full dataset; the legacy `postgres` DB still contains the untouched source (rollback anchor) and `genie doctor --relocation-status` prints the exact rollback command.
9. `genie doctor --relocation-status` correctly reports bucket + sentinel + deltas in every state above.

## Execution Strategy

### Wave 1 (foundation — Group 1 alone)
Group 1 ships the state classifier + filesystem/DB sentinel + structured events + the `SKIP` short-circuits. No data is moved yet; classifier is observable via `genie doctor --relocation-status`. This de-risks the dangerous waves by proving bucketing on real fleet hosts first.

### Wave 2 (parallel after Wave 1 — Groups 2 + 3)
- Group 2: provisioning + relocation engine + proof gate + advisory lock (the data mover), behind a default-off env flag `GENIE_CANONICAL_RELOCATION=1` for staged enablement.
- Group 3: connection cutover (resolve role+DB from `autopg_meta`, fallback to legacy) — independently testable against a hand-provisioned DB.

### Wave 3 (depends on Wave 2)
Group 4: flip `GENIE_CANONICAL_RELOCATION` to default-on, wire `genie doctor --relocation-status`, crash/concurrency/abort test matrix, fleet-rollout runbook + structured-event dashboard queries.

## Execution Groups

### Group 1 — State classifier + sentinel + observability (foundation)

**Files:** `src/lib/pg-relocation.ts` (new — classifier + sentinel I/O + events), `src/lib/db.ts` (call classifier in `buildAndOpenConnection`, log-only), `src/lib/pg-relocation.classifier.test.ts` (new).

**Acceptance criteria:**
- `classifyHost(legacyClient, transport)` returns exactly one of `FRESH | LEGACY_NEEDS_MIGRATION | ALREADY_MIGRATED | SKIP` with the decision inputs attached.
- FS sentinel read/write is atomic (temp+rename) and tolerates a malformed/absent file (treated as "not migrated").
- `SKIP` is returned for: `GENIE_TEST_PG_PORT`, `GENIE_PG_FORCE_TCP`, non-pgserve transport, pgserve postmaster unreachable, `pg_dump`/`pg_restore` not resolvable, or unstable fingerprint (pre-#2426 path).
- Classifier issues at most 2 lightweight queries on the cold path and **zero** on the FS-sentinel fast path.
- Every classification emits `relocation.classified` with the bucket + reasons; never throws into the boot path (any internal error ⇒ `SKIP` + `relocation.skip.classifier-error`).
- `bun run typecheck` clean; classifier unit tests cover all five buckets via fixture connections.

### Group 2 — Provisioning + relocation engine + proof gate (the data mover)

**Files:** `src/lib/pg-relocation.ts` (provision + dump/restore + verify + advisory lock), `src/lib/pg-relocation.engine.test.ts` (new, incl. injected-crash + rowcount-mismatch).

**Acceptance criteria:**
- Acquires `pg_advisory_lock(hashtext('genie:canonical-relocation-v1'))` before any provisioning; releases on all paths (success, abort, throw).
- Provisioning is idempotent and byte-equivalent to `autopg provision` (same db/role names via `deriveProvisionedNames` convention; reuses the autopg binary when present).
- Dump/restore uses version-matched bundled `pg_dump`/`pg_restore`; restore targets the provisioned role as owner; partitioned `genie_runtime_events` + `_genie_migrations` verified present post-restore.
- Proof gate: exact `COUNT(*)` on all core tables; abort on any mismatch with `relocation.aborted.rowcount-mismatch`, partial target `DROP DATABASE`d, source untouched, host stays legacy.
- Injected-crash test (kill between dump and restore, between restore and proof) ⇒ next run drops partial + succeeds; source row counts never change across the whole test.
- Behind `GENIE_CANONICAL_RELOCATION=1` (default off this group); no-op when unset.

### Group 3 — Connection cutover (resolve provisioned identity)

**Files:** `src/lib/db.ts` (`resolveDatabaseName`/username binding → consult `autopg_meta` by fingerprint, fallback to `postgres`/`postgres`), `src/lib/db.cutover.test.ts` (new).

**Acceptance criteria:**
- After a successful relocation (or on an already-provisioned host), genie connects as `app__automagik_genie_<fp>_role` to `app__automagik_genie_<fp>`.
- Absent `autopg_meta` row (or query failure) ⇒ silent fallback to legacy `postgres`/`postgres`; genie boot never hard-fails on this path.
- `GENIE_TEST_DB_NAME` / test mode still override as today.
- Cutover is consistent across the daemon long-lived pool and short-lived CLI (`GENIE_SKIP_DB_BOOT`) paths.

### Group 4 — Default-on + doctor + rollout hardening

**Files:** `src/lib/db.ts` (flip default), `src/genie-commands/doctor.ts` (`--relocation-status`), `src/lib/pg-relocation.matrix.test.ts` (new — concurrency/crash/skip matrix), `docs/_internal/canonical-relocation-runbook.md` (new).

**Acceptance criteria:**
- `GENIE_CANONICAL_RELOCATION` defaults on; `=0` is a documented kill-switch that classifies `SKIP`.
- `genie doctor --relocation-status` prints bucket + FS+DB sentinel + per-table source/target deltas + the verbatim rollback command, read-only.
- Concurrency test: N=8 simultaneous boots on a legacy fixture ⇒ exactly one relocation, all 8 end on target, zero partial observations.
- Runbook documents: structured-event grep queries for fleet monitoring, the kill-switch, the manual rollback, and the (separate, future) source-GC criteria.
- Full `bun test` green; `bun run typecheck` clean.

## QA Criteria

- Reproduce the live `genie-pgserve` topology in a fixture (data in `postgres` DB, empty husks present) and prove a clean end-to-end relocation + idempotent second boot.
- Crash-injection at every phase boundary; assert source immutability (row counts of `postgres` DB tables identical before/after every crashed attempt).
- Concurrency: 8 parallel boots, assert single relocation via advisory-lock contention logs.
- Skip matrix: `GENIE_TEST_PG_PORT`, `GENIE_PG_FORCE_TCP`, pgserve stopped, pg_dump removed, pre-#2426-style unstable fingerprint — each ⇒ `SKIP`, genie boots unchanged.
- Rowcount-mismatch injection ⇒ abort + partial drop + legacy retained + retry.
- Fresh-host: no copy attempted, empty target provisioned, normal `runMigrations` builds schema in the new DB.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Large dataset (GBs) makes the one-time dump slow, blocking first boot after upgrade | Medium | Advisory lock means only the first process pays it; emit progress events; generous timeout; document expected one-time delay; the daemon boot path can relocate while CLI calls block on the lock and then fast-path. |
| `pg_dump` major-version mismatch vs postmaster | High | Resolve binaries from the pgserve install (same cluster); if unresolvable/mismatched ⇒ `SKIP` + loud warning, never a best-effort dump. |
| Downgrade to a pre-canonical genie after relocation (old binary re-attaches to stale source in `postgres` DB) | Medium | Rollback anchor keeps source coherent; document downgrades past canonical version as unsupported; source-GC is deferred precisely so a downgrade still finds intact data. |
| FS sentinel present but target DB actually missing (e.g. user manually dropped it) | Medium | DB sentinel is source-of-truth; classifier revalidates target existence on the cold path and self-heals by reclassifying `LEGACY_NEEDS_MIGRATION`/`FRESH` if the target is gone. |
| Advisory lock held by a wedged process | Low | Lock is session-scoped on the legacy connection; a dead process's session ends and Postgres releases it automatically. |
| Partial `autopg_meta` / pgserve mid-upgrade during cutover | Low | Group 3 fallback to legacy `postgres`/`postgres`; relocation re-attempts cleanly next boot. |
| Disk full during restore | Medium | Restore failure ⇒ abort + drop partial + `relocation.aborted.restore-failed` + stay legacy + retry; source never at risk. |

## Files to Create/Modify

- **Create:** `src/lib/pg-relocation.ts`, `src/lib/pg-relocation.classifier.test.ts`, `src/lib/pg-relocation.engine.test.ts`, `src/lib/db.cutover.test.ts`, `src/lib/pg-relocation.matrix.test.ts`, `docs/_internal/canonical-relocation-runbook.md`.
- **Modify:** `src/lib/db.ts` (classifier+engine call in `buildAndOpenConnection` pre-`runPostConnectSetup`; `resolveDatabaseName`/username binding for cutover), `src/genie-commands/doctor.ts` (`--relocation-status`).

## Live Audit Reference

Empirical state captured 2026-05-15 on the `genie-pgserve` server (pgserve `pm2`, socket `/run/user/1000/pgserve`, port 8432):

- `postgres` DB: 340 MB, 52 public tables — full live genie dataset (`genie_runtime_events_*` ~250K rows partitioned, `session_content` 16309, `tool_events` 12377, `sessions` 256, `tasks` 791, `wishes` 270, `agents` 122, `teams` 129, `_genie_migrations` 61).
- `app__automagik_genie_038bd03201ac` / `_0a2e89b1b431` / `_e43f32dfaaae` / `_e97ab9e66d62` / `_f5a599e20b9d`: all 7710 kB, zero public tables (empty husks — pre-#2426 fingerprint fragmentation).
- `genie`, `genie_archive_20260430`: empty.
- `omni` DB: 1059 MB, 38 tables — omni is already correctly isolated (reference for the target end-state).
- `pgserve_meta` / `autopg_meta`: do not exist (provisioning never bootstrapped on this host).
- Genie daemon live: PID 3693224 `genie serve start --headless`.
