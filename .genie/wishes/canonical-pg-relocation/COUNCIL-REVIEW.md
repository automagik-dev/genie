# Council Review — canonical-pg-relocation

| Field | Value |
|-------|-------|
| **Date** | 2026-05-15 |
| **Members** | architect, sentinel, operator, questioner |
| **Rounds** | 2 (initial + Socratic) |
| **Verdict** | Advisory — **SPLIT THE WISH**. Near-total convergence. |

## Executive Summary

Four members, two rounds, near-unanimous convergence: the wish conflates **two independent goals** and only one needs a migration engine. **Goal A** = access identity (dedicated least-privilege role + GRANTs on the *existing* `postgres`-DB genie objects + rebind the connection identity) — zero byte movement, no dump, no proof gate, no cutover window, no advisory lock, near-zero blast radius. **Goal B** = physical byte relocation into `app__automagik_genie_<fp>` — the entire 6-file/4-group/3-wave engine, with the weakest justification and an un-closable data-loss gap at the chosen layer. Recommendation: **ship Goal A now as its own wish; defer Goal B behind concrete gates.**

## Consensus (all 4 members)

1. **SPLIT.** Goal A is mandatory *and sufficient* to fix the real steady-state defect (wrong DB + superuser). Goal B is optional, unproven in necessity, and cosmetic until out-of-scope pg_hba hardening lands.
2. **Load-bearing bug — cutover targets the wrong code path.** `resolveTransport()` direct-postmaster branch (db.ts:1238-1259) hard-sets `database=postgres, username=postgres` and explicitly *skips* fingerprint routing whenever `admin.json` exists (the normal case). The WISH frames cutover as "accept-hook auto-resolve" — the exact mechanism this path bypasses. An implementer following the WISH fixes the router path and ships a **no-op that re-forks the dataset on boot #2**, hidden forever by the FS sentinel reporting green. Must be the #1 acceptance criterion. **Applies to Goal A too.**
3. **Cutover-window write-loss is real (3 independent derivations).** The advisory lock serializes *relocators*, not the already-connected live daemon (audit: PID 3693224) + agent pools. `pg_dump`'s MVCC snapshot orphans every commit after the snapshot → silent loss at cutover. "Source immutable until proven" is fiction while the daemon writes through it.
4. **Fix: REVOKE write before the dump snapshot.** `REVOKE INSERT/UPDATE/DELETE` on source genie tables *before* `pg_dump`, not after proof. Converts silent orphaning → loud retryable write-error; makes proof-reality == post-fence reality; converts the "rollback anchor" from a divergent live fork into a frozen read-only artifact (kills split-brain in one mechanism).
5. **reltuples proof violates the zero-loss claim.** The WISH proves the riskiest table (`genie_runtime_events_*`, 250K rows, partitioned) with an ANALYZE estimate. Must be exact `COUNT(*)` per partition — sub-second next to a multi-second dump; no cost defense.
6. **"Writable rollback anchor" must die.** A writable stale source + a global "migrated" sentinel *is* the split-brain; it does not prevent it. REVOKE-at-cutover keeps it readable (true rollback) but not writable (no fork).
7. **The "random password" is fiction.** pgserve `provision` = `CREATE ROLE WITH LOGIN` (no password, trust-auth); `autopg_meta` has no password column. The wish's "(LOGIN, random password)" + "byte-equivalent to autopg provision" is internally contradictory. Decide explicitly: passwordless-trust (delete every confidentiality claim) OR real password (0600 store + doctor check, *not* byte-equivalent).
8. **Honest value reframing.** This wish delivers **no confidentiality** (`--auth-local=trust` + passwordless `postgres` superuser are both out of scope). Goal A's real, attainable value is **least-privilege integrity containment**: a genie bug/compromise can no longer `DROP` omni, exhaust the shared cluster, or corrupt shared WAL. Stop selling "safe from external reading"; sell "a genie failure can't take down the shared cluster or its neighbors."

## Additional findings

- **Global FS sentinel mis-keyed** (architect): one `~/.genie/.canonical-relocation-v1.json` vs per-fingerprint target DB → multi-checkout users stranded on `postgres` forever while the fast-path says ALREADY_MIGRATED. Key the sentinel by fingerprint.
- **Observability chicken-egg** (operator): relocation events written into the very table being moved. Need an out-of-band sink (stderr structured JSON + a file under `~/.genie/`) independent of any DB; plus a paging signal, not just greppable logs.
- **No canary** (operator): do not flip default-on fleet-wide in the same wish. Classifier default-on first (observe buckets a full release), mover default-off, percentage gate before default-on.
- **pg_dump scope** (sentinel): dumping the whole `public` schema of the shared `postgres` DB ingests any foreign data. Enumerate the genie tables / `_genie_migrations`-anchored set explicitly.
- **Shared-cluster ENOSPC = CRITICAL not Medium** (sentinel): one postmaster, genie 340MB + omni 1GB + shared WAL/disk. pg_dump+restore peaks ~2.5–3× dataset; filling the shared volume takes omni down too. Pre-flight free-space gate (≥3× dataset, else SKIP) + nice/ionice + off-peak.
- **Phantom scale, n=1** (questioner): every size/timeout/progress assumption derives from the team's own ops box. Produce a fleet `pg_database_size` histogram before sizing any crash/timeout engineering.
- **If Goal B ever runs**: daemon-coordinated drain — only the long-lived daemon has authority to quiesce its own pool. NOT the connection-bootstrap layer (a per-process hook has zero authority over already-open pools). `pg_try_advisory_lock` (never blocking); CLI/hook paths classify SKIP.

## Dissent / resolved tensions

- **sentinel vs questioner on source cleanup.** Sentinel proposed the canonical binary auto-`DROP` the source after a hard 14-day soak ("exposures deferred to unwritten wishes become permanent"). Questioner rejected: same-binary auto-DROP arms the downgrade landmine — relocate → 14 days → roll back a bad release (normal ops) → source already dropped → **total data loss, strictly worse than split-brain**. Council resolved toward architect's **REVOKE-at-cutover** (readable, not writable) which satisfies sentinel's "no permanent deferred exposure" (frozen, bounded, trivially GC-able) without arming questioner's landmine.
- **questioner vs sentinel on Goal A's value.** Questioner: Goal A is "essentially all the isolation/hygiene value." Sentinel refined: Goal A delivers integrity containment, NOT confidentiality (trust unchanged). Both still endorse the split — the disagreement is purely how to *pitch* Goal A, not whether to ship it.

## Position evolution

| Member | Round 1 → Round 2 |
|--------|-------------------|
| architect | Found the wrong-path bug → **explicitly endorses split**; verdict: cutover-window loss is *unclosable at the connection-bootstrap layer by construction* — Goal B, if ever, must be a daemon-coordinated drain. |
| operator | "Sound skeleton, sharp edges" → **backs split**; the wrong-path bug + unanimous write-loss + zero confidentiality changes the operator calculus to "high risk for unproven value." |
| sentinel | "Net security gain zero" → sharpened to **split + gate Goal B behind pg_hba landing + one write-fence mechanism that closes 3 gaps**. |
| questioner | Split thesis → **strengthened**: architect's code finding proves identity-cutover is the *load-bearing* change, not deferrable polish. |

## Recommended decision

1. **Carve Goal A into its own wish** (`genie-dedicated-role-cutover` or similar): provision a non-superuser role + scoped GRANTs on the *existing* `postgres`-DB genie objects; rebind the **direct-postmaster path** identity (`resolveTransport`/`buildPgClientOptions`, db.ts:1238-1259) — explicitly NOT the accept-hook router; fix the FS-sentinel keying. Zero byte movement. Ship now. Pitch as integrity/blast-radius containment, not confidentiality.
2. **Hold Goal B (byte relocation)** behind: (a) fleet `pg_database_size` histogram, (b) the pg_hba/trust hardening actually landing (so the destination is a real auth boundary), (c) a daemon-coordinated-drain redesign off the connection-bootstrap layer, (d) REVOKE-write-fence-before-snapshot, (e) exact-per-partition count proof, (f) pre-flight ≥3× free-space gate, (g) out-of-band event sink. If Goal A lands cleanly, Goal B's urgency largely evaporates — which is the point.
3. **Drop the "random password" language** wherever it appears; pick passwordless-trust (and delete confidentiality claims) or a real password (and add 0600 storage + a `genie doctor` secret-presence check + a no-secrets-in-logs test).
