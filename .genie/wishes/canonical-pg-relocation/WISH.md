# Wish: Canonical PG Relocation — Byte Movement into a Fingerprinted DB (Goal B)

| Field | Value |
|-------|-------|
| **Status** | **DEFERRED** — gated, not ready for `/work`. See Gates. |
| **Slug** | `canonical-pg-relocation` |
| **Date** | 2026-05-15 (scoped down post-council) |
| **Design** | Council review 2026-05-15 (architect/sentinel/operator/questioner, near-unanimous). Full deliberation: `./COUNCIL-REVIEW.md`. Goal A carved out → `genie-dedicated-role-cutover` (PR #2429). |

## Status note (read first)

The original draft conflated two independent goals. The council split them:

- **Goal A — access identity** (dedicated non-superuser role, scoped GRANTs, identity rebind on the existing `postgres` DB, **zero byte movement**): carved into `genie-dedicated-role-cutover` (PR #2429). That wish fixes the *actual* steady-state defect (genie runs as cluster superuser) and carries no data-loss surface. **It is the ship-now work.**
- **Goal B — physical byte relocation** (this wish): move genie's bytes out of the shared `postgres` DB into `app__automagik_genie_<fp>`. The council found this half has the weakest justification, an un-closable data-loss gap at the originally-chosen layer, and **no security value until out-of-scope pg_hba hardening lands**. **DEFERRED** behind the hard gates below. Do not `/work` this wish until every gate is satisfied.

## Why deferred (council findings)

1. **No confidentiality value until pg_hba hardening lands.** With `--auth-local=trust` and a passwordless `postgres` superuser (both producer-side pgserve v3.x, out of scope), moving bytes into a differently-named DB is a cosmetic rename — anyone on the socket is still superuser and reads everything regardless. Relocating bytes only buys confidentiality *after* the DB boundary is a real auth boundary.
2. **Cutover-window write-loss is un-closable at the connection-bootstrap layer (architect, by construction).** A per-process bootstrap hook has authority only over its own about-to-open connection — zero authority over the live daemon's already-open pool (audit: PID 3693224) and in-flight agent writers committing to `postgres` now. `pg_dump`'s MVCC snapshot orphans every post-snapshot commit at cutover. The only correct architecture is a **daemon-coordinated drain**, not a connection-layer side effect.
3. **Phantom scale.** Every size/timeout/crash assumption derived from n=1 (the team's own 340 MB ops box). A fleet `pg_database_size` histogram is required before that engineering is justified.
4. **Once Goal A ships, Goal B's urgency largely evaporates** — the superuser blast radius (the real, present danger) is closed by the dedicated role with zero data movement.

## Gates (ALL must be satisfied before this wish leaves DEFERRED)

- **G1 — Goal A shipped & soaked.** `genie-dedicated-role-cutover` merged, default-on, observed clean on the fleet ≥1 release. De-risks Goal B by proving direct-postmaster-path identity-rebind works.
- **G2 — pg_hba/trust hardening landed (pgserve v3.x).** Destination DB must be a real auth boundary, else Goal B has no security value (finding #1).
- **G3 — Fleet size histogram produced.** `pg_database_size` distribution across real installs, replacing every n=1 assumption.
- **G4 — Redesigned off the connection-bootstrap layer.** Re-specified as a **daemon-coordinated drain**: only the long-lived daemon (the single entity able to quiesce its own pool) performs provision → write-fence → dump → restore → rebind → unblock as one owned maintenance operation. CLI/hook paths classify SKIP. Non-blocking `pg_try_advisory_lock` only.
- **G5 — Write-fence-before-snapshot.** `REVOKE INSERT/UPDATE/DELETE` on source genie tables **before** the `pg_dump` snapshot (not after proof). Makes proof-reality == post-fence reality; silent orphaning → loud retryable write-error; rollback anchor becomes a frozen read-only artifact (kills split-brain). The writable rollback anchor from the original draft is **abandoned**.
- **G6 — Exact per-partition count proof.** `reltuples` abandoned. Exact `COUNT(*)` per `genie_runtime_events_*` partition (sub-second; the table most likely to drop rows must not be proven by an estimate).
- **G7 — Pre-flight free-space gate + neighbor protection.** Shared postmaster (genie + omni 1 GB + shared WAL/disk). Require ≥3× dataset free or SKIP; `nice`/`ionice`; off-peak. ENOSPC on the shared volume is a full-cluster outage (omni down too) — CRITICAL, not Medium.
- **G8 — Out-of-band event sink.** Relocation events must not write into the table being moved. stderr structured JSON + a `~/.genie/` file + a paging signal (not just greppable logs). Per-fingerprint sentinel, never a global file.
- **G9 — No same-binary auto-DROP of source.** Council-resolved tension: auto-DROP after a soak arms the downgrade landmine (roll back a bad release → source gone → total loss, worse than split-brain). Source GC is a separate, age-gated, owned wish; or rely on the G5 frozen artifact being trivially GC-able later.

## Original problem (retained for context)

Verified live on `genie-pgserve` 2026-05-15: 340 MB / 52 tables (`genie_runtime_events_*` ~250K rows partitioned, `session_content` 16K, `sessions`, `tasks`, `wishes`, `agents`, `teams`, `_genie_migrations`) all in the shared `postgres` DB; five empty `app__automagik_genie_<hex>` husks from the now-fixed unstable-fingerprint bug (PR #2426); `autopg_meta` never bootstrapped; omni correctly isolated in its own 1 GB `omni` DB. End-state target (pgserve roadmap v1.2) = genie owning a dedicated fingerprinted DB. Goal A delivers the identity/least-privilege portion now; Goal B (this wish) is the byte-movement portion, deferred until the gates make it both safe and worthwhile.

## When unblocked — design constraints (carry into the redesign)

- Bootstrap-layer-not-numbered-migration was correct *as a constraint* (a `06x_*.sql` can't hand off `_genie_migrations` from inside the DB it abandons) — but the executor must be the **daemon**, not an arbitrary process's connect path (G4).
- `pg_dump -Fc` over `CREATE DATABASE … TEMPLATE` was correctly reasoned (TEMPLATE is blocked while `postgres` has connections; it always does). Same-cluster `pg_dump -Fc | pg_restore` over the socket remains the only sane mechanism *if* bytes must move.
- Source-immutable becomes *real* only via G5 (REVOKE-before-snapshot); the original "immutable until proven" was fiction while the daemon wrote through it.
- SKIP for external/test PG, idempotent crash recovery, classifier-first observability remain sound and carry forward.

## Provenance

Scoped down from the original full-engine draft per the 2026-05-15 council. Goal A → `genie-dedicated-role-cutover` (PR #2429, ship-now). Full deliberation, dissent, position evolution: `./COUNCIL-REVIEW.md`.
