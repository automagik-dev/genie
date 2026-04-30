# Wish: PG CI Speedup — Leverage pgserve v2 Socket Model

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `pg-ci-v2-socket-leverage` |
| **Date** | 2026-04-30 |
| **Author** | cezar@namastex.ai |
| **Appetite** | medium |
| **Branch** | `wish/pg-ci-v2-socket-leverage` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | _No brainstorm — direct wish_ |

## Summary

`pgserve@2.0.8` ships a fundamentally different runtime model than the v1 era the test harness was written against — singleton control-socket daemon, database-per-fingerprint auto-provisioning, native `/dev/shm` `--ram` mode, and a proper supervision/recovery contract. Genie's `pg-tests` CI job today still bootstraps pgserve in the v1-style "boot per shard, lock file, drop/create database per test" pattern. This wish reshapes the harness around v2's actual primitives: one daemon for the whole job, RAM-backed storage, fingerprint-scoped DB isolation in place of explicit drop/create, and removal of the retry-once wrapper now that v2's recovery code makes it redundant.

## Scope

### IN

- **Group 1**: Pre-warm a single pgserve v2 daemon at the start of the `pg-tests` job (before `bun test`), using `--ram` (pgserve's documented "use /dev/shm internally" mode) on Linux Blacksmith runners. Tests connect via the libpq Unix socket exposed under a CI-scoped `XDG_RUNTIME_DIR`; no per-test bootstrap.
- **Group 2**: Keep `createTestDatabase` / `dropTestDatabase` as the per-test isolation primitive (no fingerprint-rotation — pgserve has no per-connect fingerprint override), but make the slow path fast: reuse a single admin connection across all setup/teardown calls, skip the migration replay on subsequent tests via a `genie_template` cached template DB (clone via `CREATE DATABASE ... TEMPLATE`, microseconds vs full migration replay), and drop redundant DDL roundtrips. Net effect: same isolation model, materially faster.
- **Group 3**: Drop the `bun test || bun test --timeout 15000` retry-once wrapper in `ci.yml`. The flake reasons it covered (NOTIFY delivery gaps, post-INSERT read visibility) are now caught by 2.0.5+ recovery code; if a test still flakes, surface it as a real failure, don't mask it.
- **Group 4**: Remove `test-pgserve.lock` userland file mechanism. v2's singleton enforces one daemon per host via `pgserve.pid` (kernel-checked liveness, automatic stale cleanup) — the userland lockfile is now redundant and a documented footgun (CI hangs if a prior run left it dangling).
- **Group 5**: Measure + verify. Run the modified pipeline against `dev` HEAD on a draft PR, capture wall-clock baselines vs current, post numbers in the PR body. Acceptance: measurable, honest reduction; if the achieved win is <10% the wish abandons rather than ships.

### OUT

- **Per-file parallelism rework / LPT scheduling**: deferred to the existing `.genie/wishes/pg-test-perf/` wish. This wish does not split or rebalance shards.
- **Replacing `bun test` with another runner** (Vitest, Node test runner): single-runner constraint preserved.
- **Migration tooling changes**: migrations stay as-is; the only change is *which* DB they target per test.
- **Switching to `pglite` WASM in-process**: explicitly out of scope (incompatible with `genie serve` runtime).
- **macOS RAM disk** (`hdiutil`-backed): covered by `pg-test-perf` wish on macOS. This wish is Linux-Blacksmith only because that's where CI runs.
- **`pgserve-v2-smoke` job**: stays unchanged — already a v2-specific path that works.
- **Pre-push hook test perf**: focus is CI; pre-push hook can pick up the wins via the same harness changes but is not separately tuned here.
- **Cross-fingerprint DB cleanup**: pgserve's GC sweep handles this; we don't add a custom reaper.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | One pgserve daemon for the whole `pg-tests` job, started in a job step before `bun test` | v2's singleton model makes "one per host" the only supported topology; matches genie's daemon-recovery code in `db.ts` (PRs #1554/#1557). Cold-boot cost is paid once instead of per-shard. |
| 2 | `--ram` (no `--data`) on Linux Blacksmith runners | Blacksmith runners are ephemeral; persistent disk gives us nothing. `--ram` uses `/dev/shm` internally (pgserve's documented mode) — eliminates fsync wait on every commit. Mixing `--ram` with `--data <path>` is contradictory; pick one. |
| 3 | Keep `createTestDatabase` + template clone, NOT fingerprint-rotation | Investigated v2's fingerprint mechanism: it's derived from `package.json name` + `SO_PEERCRED`, with no per-connect override. Per-test fingerprint rotation would require a pgserve-side knob that doesn't exist. Template-clone via `CREATE DATABASE ... TEMPLATE genie_template` is the right v2-era speedup — microseconds to clone, no migration replay. |
| 7 | DBs accumulate within a single CI run; rely on the ephemeral runner being thrown away | pgserve's GC sweep TTL defaults to 24h and is not exposed via daemon CLI. Within a 15-min CI run, DBs accumulate. That's fine: Blacksmith runners are ephemeral, `/dev/shm` is wiped between jobs. No GC tuning required. |
| 4 | Drop the retry-once wrapper unconditionally, not behind a feature flag | Flake reasons it covered are addressed in 2.0.5–2.0.7. If a flake remains, we want to see it red, not hide it. Reverting is a one-line PR if a real new flake surfaces. |
| 5 | One PR for all five groups (not split per group) | Groups are coupled — measuring (Group 5) requires Groups 1-4 in place. Splitting into five tiny PRs would waste review cycles. |
| 6 | Target `dev` branch, not `main` | Per agent-bible §1: feature PRs target `dev`. genie has an active `dev → main` flow. |

## Success Criteria

- [ ] `pg-tests` p50 wall-clock measurably reduced vs the baseline measured before this PR. Specific reduction target is set after Group 5 collects the baseline; if the achieved win is <10% the wish abandons rather than ships, on the principle that harness churn without measured benefit is net negative.
- [ ] Daemon-cold-boot cost is paid exactly once per `pg-tests` job (verified by counting `[pgserve] daemon listening` banners in the job log).
- [ ] Flake rate over 20 consecutive `dev` CI runs ≤ baseline (ideally lower, since 2.0.5+ recovery + dropped retry-wrapper). No new categories of flake observed.
- [ ] No `test-pgserve.lock` references remain in source or workflows.
- [ ] No `bun test || bun test ...` retry wrappers remain in `ci.yml`.
- [ ] PR body posts measured before/after wall-clock numbers from a real CI run, not local.
- [ ] Existing test count unchanged (no skipped tests as a side effect of harness changes).

## Execution Strategy

### Wave 1 (sequential, this whole wish is one PR)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Add pre-warm step to `pg-tests` job; spawn one pgserve daemon with `--ram --data /dev/shm/pgserve-tests` and wait for socket bind |
| 2 | engineer | Refactor `test-setup.ts` to use fingerprint-rotated DBs instead of `CREATE/DROP DATABASE` |
| 3 | engineer | Remove retry-once wrapper from `ci.yml` `Test (serial, PG-backed)` step |
| 4 | engineer | Remove `test-pgserve.lock` from `test-setup.ts` and any companion code |
| 5 | engineer | Run twice on a draft PR (1-shard + 4-shard), capture timing, write PR body |

All five groups touch the same logical surface (`test-setup.ts` + `.github/workflows/ci.yml`) and must land together for Group 5's measurement to be meaningful. No parallelism — sequential by design.

## Execution Groups

### Group 1: Pre-warm pgserve daemon, RAM-backed, once per job

**Goal:** Eliminate per-test (and per-shard) pgserve cold-boot. One daemon up before `bun test`, all 56 PG-dependent test files connect to it via the libpq Unix socket.

**Deliverables:**
1. New step in `.github/workflows/ci.yml` `pg-tests` job, before the `Test (serial, PG-backed)` step, that:
   - Sets `XDG_RUNTIME_DIR=${RUNNER_TEMP}/xdg-pgtests` (matches `pgserve-v2-smoke`'s pattern).
   - Spawns `./node_modules/.bin/pgserve daemon --ram --log warn &`.
   - Polls for `${XDG_RUNTIME_DIR}/pgserve/.s.PGSQL.5432` symlink to appear, max 30s.
   - Exports `XDG_RUNTIME_DIR` so `bun test` (and child processes) inherit it.
2. `src/lib/test-setup.ts` updated so that when `XDG_RUNTIME_DIR/pgserve/.s.PGSQL.5432` already exists, the test harness does NOT spawn its own pgserve — it connects to the pre-warmed daemon. Today the harness writes `${initialGenieHome}/data/test-pgserve.lock` and may auto-spawn; that branch must be guarded by an existing-socket check first.
3. A teardown step (`if: always()`) sends SIGTERM to the daemon for clean shutdown.

**Acceptance Criteria:**
- [ ] Job log contains exactly one `[pgserve] daemon listening` banner (grep count == 1).
- [ ] No test produces `[pgserve] Downloading @embedded-postgres/...` (binaries cached at the package level via `bun install` postinstall).
- [ ] `pg-tests` test step starts within 5s of pgserve being ready (vs current bootstrap eating 10-30s of test time).
- [ ] `src/lib/test-setup.ts` checks for `${XDG_RUNTIME_DIR}/pgserve/.s.PGSQL.5432` before spawning. Verified by a unit test that fakes the env var + socket file and asserts no spawn happens.

**Validation:**
```bash
gh run list --repo automagik-dev/genie --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId' \
  | xargs -I{} gh run view {} --repo automagik-dev/genie --log \
  | grep -c '\[pgserve\] daemon listening'
# expected: 1
```

**depends-on:** none

---

### Group 2: Speed up `createTestDatabase` via admin-conn reuse + template clone

**Goal:** Drop the slow DDL + migration-replay cost from every test setup. Same isolation model (one DB per test file, drop on teardown), but cloning a pre-migrated template instead of running migrations from scratch and reusing one admin connection across all setup/teardown calls.

**Deliverables:**
1. `src/lib/test-setup.ts`:
   - One module-level admin client opened once on first `createTestDatabase` call, kept open for the rest of the bun-test process. All `CREATE DATABASE` / `DROP DATABASE` calls go through it. Today's behaviour opens/closes per call.
   - On first call, build a `genie_template` DB with all migrations applied. Subsequent `createTestDatabase(name)` calls do `CREATE DATABASE "<name>" TEMPLATE genie_template` — cheap clone, no migration replay.
   - `dropTestDatabase` calls go through the same admin client.
2. The template build is idempotent and migration-hash-keyed: if the template already exists and the migration files haven't changed, skip the build. (Hash check is straightforward: SHA-1 over the migration file contents, stored as a comment on `genie_template`.)
3. Per-test isolation guarantees unchanged — every test still gets its own DB, named the same way it is today. Only the under-the-hood mechanism changes.

**Acceptance Criteria:**
- [ ] Admin connection count to pgserve during a full PG test run drops to ~1 (verified via `pg_stat_activity` snapshot in a test or via pgserve audit log).
- [ ] First test in a fresh CI job pays the migration cost (template build); subsequent tests don't (clone is microseconds).
- [ ] `pg_stat_database` after a full run shows the expected per-test DBs plus `genie_template` plus the system DBs.
- [ ] Test isolation guarantees unchanged: existing test suite passes without modification.

**Validation:**
```bash
bun test --timeout 15000 src/lib/test-setup.test.ts
```

**depends-on:** group 1

---

### Group 3: Remove retry-once wrapper from `ci.yml`

**Goal:** Delete the `bun test --timeout 15000 || bun test --timeout 15000` shape from the `Test (serial, PG-backed)` step. The flakes it covered (NOTIFY gaps, INSERT visibility) are addressed by pgserve@2.0.5+ recovery code; if anything still flakes, see it red.

**Deliverables:**
1. `.github/workflows/ci.yml` `Test (serial, PG-backed)` step simplified to a single `bun test --timeout 15000` invocation.
2. Inline comment explaining the rationale and the rollback recipe.
3. No `GENIE_TEST_PG_NO_REUSE` env var or related code paths remain in test-setup (orphaned by the wrapper removal).

**Acceptance Criteria:**
- [ ] `grep -nE '\|\| bun test|GENIE_TEST_PG_NO_REUSE' .github/workflows/ci.yml` returns zero matches.
- [ ] One `bun test` invocation per shard.

**Validation:**
```bash
yamllint .github/workflows/ci.yml
grep -c '|| bun test' .github/workflows/ci.yml  # expected: 0
```

**depends-on:** group 1

---

### Group 4: Remove `test-pgserve.lock` userland mechanism

**Goal:** Delete the userland `${GENIE_HOME}/data/test-pgserve.lock` file mechanism. v2's `pgserve.pid` (kernel-checked liveness, auto-cleanup of stale locks) supersedes it. The userland lock has been observed dangling on Blacksmith runners and is now strictly worse than letting v2 enforce singletons.

**Deliverables:**
1. Remove the lock-file write/read code from `test-setup.ts` and any companion module.
2. Remove the `rm -f "$GENIE_HOME/data/test-pgserve.lock"` step in the retry path (which is being removed in Group 3 anyway).
3. Inline comment explaining the v2 supersession in the test-setup file.

**Acceptance Criteria:**
- [ ] `grep -r test-pgserve.lock` returns zero hits across `src/`, `test/`, `.github/`, `scripts/`.
- [ ] Concurrent `bun test` invocations on the same host (e.g. running tests during `genie serve`) don't deadlock — v2's singleton handles it.

**Validation:**
```bash
grep -r 'test-pgserve.lock' src test .github scripts | wc -l   # expected: 0
```

**depends-on:** group 1

---

### Group 5: Measure + post baseline

**Goal:** Demonstrate the speedup with real CI numbers. The wish doesn't ship until the PR body has measured before/after.

**Deliverables:**
1. Run `pg-tests` job on a draft PR, capture p50 wall-clock from `gh run view --json`.
2. Compare against baseline from the last 5 main-branch CI runs before this PR.
3. Run twice with `bun test --concurrency` if applicable, and once at the default — capture both numbers.
4. PR body table of results.

**Acceptance Criteria:**
- [ ] Baseline + new numbers in the PR body. Pass/fail per the ≥30% reduction success criterion above.
- [ ] If the speedup is <30%, post the numbers anyway and either narrow scope or abandon the wish — don't ship a "looks good" change without measured wins.

**Validation:**
```bash
gh run list --repo automagik-dev/genie --workflow CI --branch dev --limit 5 --json conclusion,startedAt,updatedAt --jq '.[] | select(.conclusion=="success") | (.startedAt) + " → " + (.updatedAt)'
```

**depends-on:** group 1, group 2, group 3, group 4

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] **Functional**: The full PG test suite still passes on `dev` with the new harness (no test-suite regressions).
- [ ] **Performance**: `pg-tests` job p50 wall-clock dropped ≥30% measured over 10 post-merge runs.
- [ ] **Stability**: Flake rate over the same 10 runs ≤ pre-merge baseline. No new flake categories.
- [ ] **Local dev**: `bun test` locally on Linux/macOS still works without env var setup (test harness auto-detects when no daemon is pre-started and falls back to spawning its own).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Fingerprint-per-test breaks tests that share state via shared sequences/types in the `postgres` system DB | Medium | Audit test-setup for any cross-test shared state during Group 2 implementation. Most genie tests are already DB-isolated via `createTestDatabase` — fingerprint just changes the naming, not the isolation model. |
| Removing retry wrapper exposes a real flake in a test still relying on the pgserve@<2.0.5 race conditions | Medium | If post-merge CI shows a new flake in the first 5 runs, file an issue with logs and either (a) re-add the wrapper as a feature-flagged opt-in or (b) fix the underlying race. Don't blanket-revert. |
| `/dev/shm` size on Blacksmith runners is too small for the test database footprint | Low | `/dev/shm` is half of RAM on Linux by default. For 8-vCPU Blacksmith runners (~16GB RAM), that's 8GB available — plenty for 56 small test DBs. If we hit it, fall back to default `--data` (still gets the singleton-daemon win). |
| Local-dev test runs break if developers don't have pgserve in PATH | Low | The test harness already auto-detects pgserve. Local devs install pgserve via `bun install` (it's a dep). The pre-warm step is CI-only; local dev path is unchanged. |
| The 30% reduction target is missed | Medium | If achieved win is 10-29%, narrow the wish (e.g. ship Groups 1+3+4 only, defer Group 2 to a follow-up wish) and post the smaller numbers honestly. Don't ship without measured wins. |
| Concurrent `genie serve` running on a developer machine conflicts with the test daemon | Low | v2's singleton enforces one daemon per host. The test harness already isolates via `GENIE_HOME=${RUNNER_TEMP}/...` so the data dirs differ. The only shared resource is `${XDG_RUNTIME_DIR}/pgserve/control.sock` — but tests in this wish use a custom `XDG_RUNTIME_DIR=${RUNNER_TEMP}/xdg-pgtests`, side-stepping the conflict. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
automagik-dev/genie:
  .github/workflows/ci.yml             # Group 1, 3 (pre-warm step + drop retry wrapper)
  test-setup.ts                        # Group 2, 4 (fingerprint-rotated DBs + remove lock)
  src/lib/test-db.ts (or similar)      # Group 2 (helper for fingerprint-routed connect)
  .genie/state/test-durations.json     # NOT touched (pg-test-perf wish owns this)
```
