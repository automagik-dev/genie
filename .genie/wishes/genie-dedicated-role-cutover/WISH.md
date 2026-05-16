# Wish: Genie Dedicated-Role Cutover — Stop Running as `postgres` Superuser

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-dedicated-role-cutover` |
| **Date** | 2026-05-15 |
| **Design** | Council review of `canonical-pg-relocation` (4 members, 2 rounds, 2026-05-15) — "Goal A", the carved-off safe half. See `.genie/wishes/canonical-pg-relocation/COUNCIL-REVIEW.md`. |

## Summary

Genie connects to the shared pgserve postmaster as `postgres`/`postgres` — the cluster **superuser** — and the audited live host proves this is not an accident but the deterministic steady state: `resolveTransport()`'s direct-postmaster branch (`src/lib/db.ts:1238-1259`) explicitly *skips* fingerprint routing whenever `admin.json` exists (the normal case), and `buildPgClientOptions` then hard-sets `database=postgres, username=postgres`. On that same single postmaster sits omni's 1 GB production database, sharing WAL and disk. A genie bug, a bad migration, or a compromised genie process today has superuser authority to `DROP DATABASE omni`, exhaust the shared cluster, create/alter arbitrary roles, or corrupt shared WAL — genie's blast radius is the entire machine's Postgres, not genie's own data. This wish removes that blast radius **without moving a single byte**: provision a dedicated, non-superuser role with privileges scoped to genie's own objects, and rebind genie's connection identity (on the load-bearing direct-postmaster path) to that role. Data stays exactly where it is, in the `postgres` database; only *who genie logs in as* changes. There is no dump, no copy, no proof gate, no cutover window, no advisory-locked migrator, no crash-recovery surface — and therefore no data-loss surface at all. This is the council's unanimous "ship now" recommendation; physical relocation of the bytes into a fingerprinted database is the separate, deferred `canonical-pg-relocation` wish (Goal B), explicitly gated and out of scope here. **Honest framing (council-mandated):** this is a *least-privilege integrity-containment* win — "a genie failure can no longer take down the shared cluster or its neighbors" — **not** a confidentiality win. `--auth-local=trust` and the still-passwordless `postgres` superuser are unchanged (producer-side pgserve v3.x, out of scope); anyone on the socket is still superuser. We do not claim "safe from external reading" anywhere.

## Scope

### IN

- **Dedicated role provisioning.** At boot, idempotently ensure a role exists with: `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION`, `NOBYPASSRLS`. Role name follows the `deriveProvisionedNames` convention (forward-compatible with Goal B) but the **database stays `postgres`** — the role is GRANTed onto the existing genie objects there, not given a new database. Passwordless (relies on the existing `--auth-local=trust`, byte-equivalent to pgserve `provision`'s `CREATE ROLE … WITH LOGIN`). The "random password" language from the original wish is **deleted** (council finding: it was fiction — `autopg_meta` has no password column and `provision` sets none).
- **Scoped GRANTs sized to keep genie fully functional in its own DB while removing neighbor blast radius.** `GRANT CONNECT ON DATABASE postgres`; `GRANT USAGE, CREATE ON SCHEMA public` (genie's `runMigrations` issues DDL — the role must own its schema evolution); `GRANT SELECT, INSERT, UPDATE, DELETE` on all existing genie tables + sequences; `ALTER DEFAULT PRIVILEGES` so future migration-created objects are reachable. Explicitly **withheld**: superuser, CREATEDB, CREATEROLE, and any privilege on the `omni` database or other tenants. The integrity boundary is "cannot touch anything outside the `postgres` DB's genie objects," verified by an assertion that the role `rolsuper = false`.
- **The #1 fix — rebind the direct-postmaster path.** `resolveTransport()` / `buildPgClientOptions` (`src/lib/db.ts:1238-1259`) and `resolveDatabaseName()` must resolve `username` to the provisioned role on the **direct-postmaster path** (the branch taken when `admin.json` exists). This is the load-bearing acceptance criterion (council: an implementer who "fixes the accept-hook router path" ships a no-op — the direct path is the one that runs). Applies consistently to **both** the daemon long-lived pool and the short-lived CLI/hook path (`GENIE_SKIP_DB_BOOT`).
- **Safe fallback.** If the role does not yet exist, the GRANT/lookup query fails, or pgserve is mid-upgrade, silently fall back to today's `postgres`/`postgres` behavior. Genie boot MUST NOT hard-fail on this path (Postel's Law / asymmetric cohort).
- **Fingerprint-keyed fast-path sentinel.** A per-fingerprint marker (`~/.genie/.role-cutover-<fp>.json`, **not** a single global file — council finding: a global sentinel strands multi-checkout users) caches "role provisioned + grants verified" so steady-state boots cost one `stat`, not a role/grant introspection query. DB state (`pg_roles` + `information_schema.role_table_grants`) is source-of-truth; the FS file is a validated cache that self-heals if the role is missing.
- **Idempotent + concurrency-safe provisioning.** Provisioning runs under `pg_try_advisory_lock(hashtext('genie:role-cutover-v1'))` (non-blocking — council/operator: never a blocking lock on the boot path; late arrivals skip provisioning and just connect). Re-runnable; `CREATE ROLE` guarded by `pg_roles` existence check; GRANTs are set-style and converge.
- **Doctor surface.** `genie doctor --connection-identity` (read-only) prints: resolved role, `rolsuper` (must be false post-cutover), database, grant summary, fallback-active flag, sentinel state. Support-grade output for verifying the cutover on any host.
- **Structured events** (out-of-band sink — council/operator: not into the DB tables genie writes): `role-cutover.provisioned`, `role-cutover.cutover`, `role-cutover.fallback.<reason>`, `role-cutover.skip.<reason>` to stderr structured JSON + a file under `~/.genie/`, independent of the DB.

### OUT

- **Byte relocation** into `app__automagik_genie_<fp>` — that is the deferred `canonical-pg-relocation` wish (Goal B). Nothing in this wish moves, copies, dumps, or drops data. The `postgres` DB remains genie's data home.
- **pg_hba / `--auth-local=trust` hardening / scram-on-TCP / locking the `postgres` superuser** — producer-side, pgserve v3.x, tracked in the pgserve roadmap. This wish changes *who genie logs in as*, not *what the postmaster permits*.
- **Confidentiality claims.** Explicitly not in scope and not asserted. Trust-auth is unchanged; this wish does not make genie data "safe from external reading."
- **Schema changes.** Pure access-identity change; `runMigrations` continues to own schema evolution, now executed as the scoped role.
- **Non-pgserve backends.** `DATABASE_URL` / `GENIE_TEST_PG_PORT` / `GENIE_PG_FORCE_TCP` / external Postgres → classified skip, untouched, boots exactly as before.

## Dependencies & Prerequisites

- **Stable fingerprint (PR #2426, merged).** The role name derives from `resolveGeniePackageDir()`; must be on the stable-fingerprint binary so the role name is deterministic. If the fingerprint is unstable (pre-#2426 path), skip cutover (`role-cutover.skip.fingerprint-unstable`) and stay on `postgres`/`postgres`.
- **Migrations must run as the scoped role.** Because `runMigrations` issues DDL, the role needs `CREATE ON SCHEMA public` + `ALTER DEFAULT PRIVILEGES`. Verify the full existing migration set replays clean as the scoped (non-superuser) role against a fixture restored from the live `postgres`-DB shape — this is the primary functional risk and gates the wish.
- **Boot-path placement.** Provisioning + identity resolution happens in `buildAndOpenConnection` before `runPostConnectSetup`, on the bootstrap connection, so the first `runMigrations` already runs as the scoped role.

## Decisions

| Decision | Rationale |
|----------|-----------|
| No byte movement | Council unanimous: the entire data-loss surface of the original wish existed only because Goal B moves bytes. Remove the move, the surface disappears. Goal A fixes the actual steady-state defect (wrong identity) at near-zero blast radius. |
| Rebind the direct-postmaster path, not the accept-hook | Council load-bearing finding: `resolveTransport()` direct-path hard-codes `database/username=postgres` and is the path that actually runs. Fixing the router/accept-hook path is a no-op. |
| Passwordless trust role; delete "random password" | Council/sentinel: `provision` is `CREATE ROLE WITH LOGIN` with no password and `autopg_meta` has no password column. A password would be non-byte-equivalent and unstorable. Confidentiality is explicitly not this wish's goal. |
| Grant CREATE on schema (not just DML) | `runMigrations` does DDL. Withholding superuser/CREATEDB/CREATEROLE removes the neighbor blast radius (the real win) while keeping genie able to evolve its own schema. |
| Per-fingerprint sentinel | Council/architect: a single global FS sentinel makes a multi-checkout host's second fingerprint believe it migrated and never cut over. Key by fingerprint. |
| `pg_try_advisory_lock`, non-blocking | Council/operator+sentinel: a blocking lock on the boot path is a wedge/DoS vector. Late arrivals skip provisioning and just connect as the (already-provisioned) role. |
| Fallback to `postgres`/`postgres` never hard-fails boot | A missing role / pgserve mid-upgrade must degrade to today's working behavior; cutover re-attempts next boot. |
| Honest value framing | Council/sentinel+architect: this is integrity containment ("a genie failure can't take down the cluster/neighbors"), NOT confidentiality. Docs/PR/events must not claim "safe from external reading." |

## Success Criteria

1. Post-cutover, `genie doctor --connection-identity` shows genie connected as the dedicated role with `rolsuper = false`, against `database=postgres`, on the Unix socket.
2. The dedicated role **cannot** `DROP DATABASE omni`, create roles, create databases, or act as superuser — proven by negative tests asserting each is denied.
3. Genie remains fully functional as the scoped role: full existing migration set replays clean; sessions/tasks/wishes/events read+write succeed; daemon long-lived pool and short-lived CLI path both use the role.
4. The direct-postmaster path (`resolveTransport`/`buildPgClientOptions`, the `admin.json`-present branch) resolves the role+database — verified by a test that asserts the bypass path, not the accept-hook path, carries the new identity. Boot #2 does not silently revert to `postgres`/`postgres`.
5. Missing role / failed grant query / pgserve unreachable ⇒ silent fallback to `postgres`/`postgres`, genie boots normally, `role-cutover.fallback.*` emitted out-of-band.
6. Multi-checkout host (two fingerprints, one home dir) cuts over each fingerprint independently — the per-fingerprint sentinel does not strand the second.
7. Concurrent boots (N=8, daemon + CLI + agents) provision the role exactly once via the non-blocking lock; none block; all end connected as the role.
8. Test mode / external Postgres untouched; boots identically to today.
9. Zero data movement — the `postgres` DB byte size + row counts are identical before and after cutover (asserted in the test).

## Execution Strategy

### Wave 1 (foundation — Group 1 alone)
Provisioning + scoped GRANTs + `rolsuper=false` assertion + negative privilege tests + doctor surface, behind `GENIE_ROLE_CUTOVER=1` (default off). No identity rebind yet — provable in isolation that the role exists with exactly the right privileges and none of the dangerous ones.

### Wave 2 (depends on Wave 1 — Groups 2 + 3)
- Group 2: identity rebind on the direct-postmaster path (daemon pool + CLI/hook), fallback, per-fingerprint sentinel.
- Group 3: migration-replay-as-scoped-role validation against a fixture restored from the live `postgres`-DB shape (the primary functional risk).

### Wave 3 (depends on Wave 2)
Group 4: flip `GENIE_ROLE_CUTOVER` default-on behind a documented kill-switch (`=0`), concurrency/fallback/multi-fingerprint test matrix, `genie doctor --connection-identity`, rollout note (classifier-style: observe `role-cutover.*` events a release before relying on it; this wish has no destructive step so no rollback runbook is needed — fallback IS the rollback).

## Execution Groups

### Group 1 — Role provisioning + privilege scoping (foundation)

**Files:** `src/lib/role-cutover.ts` (new — provision + grant + advisory lock + sentinel I/O + events), `src/lib/role-cutover.provision.test.ts` (new, incl. negative-privilege tests).

**Acceptance criteria:**
- Idempotent `ensureScopedRole()` creates the role with `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS LOGIN`; re-run is a no-op.
- GRANTs: `CONNECT ON DATABASE postgres`, `USAGE, CREATE ON SCHEMA public`, `SELECT/INSERT/UPDATE/DELETE` on all genie tables+sequences, matching `ALTER DEFAULT PRIVILEGES`.
- Assertion: provisioned role `rolsuper=false`; negative tests prove `DROP DATABASE omni`, `CREATE ROLE`, `CREATE DATABASE` are all denied to it.
- `pg_try_advisory_lock` non-blocking; concurrent callers don't double-provision and don't block.
- `bun run typecheck` clean; behind `GENIE_ROLE_CUTOVER=1` (default off this group).

### Group 2 — Identity rebind on the direct-postmaster path

**Files:** `src/lib/db.ts` (`resolveDatabaseName`/username binding on the `admin.json`-present branch + short-lived path), `src/lib/role-cutover.ts` (sentinel fast-path), `src/lib/db.role-cutover.test.ts` (new).

**Acceptance criteria:**
- The direct-postmaster branch resolves `username=<scoped role>`, `database=postgres`; test asserts the bypass path (not the accept-hook path) carries it.
- Daemon long-lived pool and `GENIE_SKIP_DB_BOOT` short-lived path both use the role consistently.
- Missing role / query failure ⇒ fallback to `postgres`/`postgres`, `role-cutover.fallback.*` out-of-band, no hard-fail.
- Per-fingerprint sentinel: O(1) `stat` fast-path; absent/stale ⇒ revalidate against `pg_roles` and self-heal; multi-fingerprint host not stranded.

### Group 3 — Migration-replay-as-scoped-role validation

**Files:** `src/lib/role-cutover.migration-replay.test.ts` (new), fixture loader from a `postgres`-DB-shape dump.

**Acceptance criteria:**
- Full existing migration set (`src/db/migrations/*`) replays clean executed as the scoped (non-superuser) role against the live-shape fixture.
- A migration that needs DDL genie legitimately performs succeeds; one that would need superuser (if any exists) is identified and either re-scoped or explicitly documented as a blocker before cutover default-on.

### Group 4 — Default-on + doctor + rollout hardening

**Files:** `src/lib/db.ts` (flip default), `src/genie-commands/doctor.ts` (`--connection-identity`), `src/lib/role-cutover.matrix.test.ts` (new), `docs/_internal/role-cutover-note.md` (new).

**Acceptance criteria:**
- `GENIE_ROLE_CUTOVER` defaults on; `=0` documented kill-switch ⇒ stays on `postgres`/`postgres`.
- `genie doctor --connection-identity` prints role, `rolsuper`, database, grants, fallback flag, sentinel — read-only.
- Matrix: N=8 concurrent boots ⇒ single provision, none block, all on role; fallback + multi-fingerprint + test-mode-skip all green.
- Doc note states the honest framing (integrity containment, not confidentiality), the kill-switch, and that fallback is the rollback (no destructive step exists).
- Full `bun test` green; `bun run typecheck` clean.

## QA Criteria

- Restore a fixture from the live `genie-pgserve` `postgres`-DB shape; provision the role; assert exact privilege set + `rolsuper=false` + every dangerous privilege denied.
- Migration replay as scoped role on that fixture — must be clean.
- Identity-rebind test asserts the **direct-postmaster** path (the bypass) carries the role, and boot #2 does not revert.
- Fallback matrix: drop the role mid-session, fail the grant query, stop pgserve — each ⇒ clean `postgres`/`postgres` fallback, no hard-fail.
- Multi-fingerprint + N=8 concurrency.
- Byte-invariance: `pg_database_size('postgres')` + per-table counts identical pre/post (nothing moved).

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| A migration needs a privilege the scoped role lacks (e.g. an extension, event trigger) | High | Group 3 replays the *full* set as the scoped role before default-on; any gap is re-scoped or documented as a hard blocker — default-on does not flip until replay is clean. |
| Existing objects owned by `postgres`; scoped role has GRANT but not OWNER → some `ALTER`/`DROP` in future migrations fail | Medium | Audit migration DDL patterns; where ownership is required, either `ALTER … OWNER TO <role>` the genie objects at provision time (still no byte move) or document the constraint. Decided in Group 3. |
| Object-ownership transfer touches many tables under load | Low | Ownership change is metadata-only (catalog), not a data rewrite; runs under the non-blocking advisory lock; idempotent. |
| Operator confusion: "we secured genie" misread as confidentiality | Medium | Council-mandated honest framing baked into PR, docs, events, and `doctor` output — explicitly states trust-auth unchanged. |
| pgserve mid-upgrade leaves role half-granted | Low | Idempotent re-provision next boot; fallback covers the gap; grants are set-style and converge. |

## Files to Create/Modify

- **Create:** `src/lib/role-cutover.ts`, `src/lib/role-cutover.provision.test.ts`, `src/lib/db.role-cutover.test.ts`, `src/lib/role-cutover.migration-replay.test.ts`, `src/lib/role-cutover.matrix.test.ts`, `docs/_internal/role-cutover-note.md`.
- **Modify:** `src/lib/db.ts` (`resolveDatabaseName` + username binding on the direct-postmaster branch + short-lived path; provisioning call in `buildAndOpenConnection` pre-`runPostConnectSetup`), `src/genie-commands/doctor.ts` (`--connection-identity`).

## Provenance

Carved from `canonical-pg-relocation` per the 2026-05-15 council (architect/sentinel/operator/questioner, near-unanimous). Full deliberation: `.genie/wishes/canonical-pg-relocation/COUNCIL-REVIEW.md`. The byte-relocation half (Goal B) remains in `canonical-pg-relocation`, scoped down to DEFERRED with explicit gates.
