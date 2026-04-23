# Wish: PG Test Performance Bundle

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `pg-test-perf` |
| **Date** | 2026-04-22 |
| **Author** | felipe |
| **Appetite** | medium |
| **Branch** | `wish/pg-test-perf` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Cut the `bun test` wall-clock for CI and pre-push hooks by ≥60% through nine targeted changes to the pgserve test harness: shared long-lived daemon, macOS RAM disk, lazy boot, template cache, admin-connection reuse, per-file parallelism, split CI job, strategic PG-test ordering, and quarantine of three existing perf-threshold flakes. Follow-on to the `test-pg-ram-isolation` commit (`12477470`, 2026-04-04) — same harness, higher throughput.

## Scope

### IN

- Long-lived shared pgserve daemon reused across `bun test` invocations (port lockfile, health-gated, stale reap after 1h).
- Template DB cache: skip migration replay when `genie_template` exists and migration-file hash is unchanged.
- macOS RAM disk path (`hdiutil`-backed) behind `GENIE_TEST_MAC_RAM=1`, graduating to default after soak.
- Admin-connection reuse in `test-setup.ts` (single long-lived client for `createTestDatabase` / `dropTestDatabase`).
- Lazy pgserve boot: skip preload when no loaded test file imports `test-db.ts`.
- Per-file parallelism via multiple `bun test` workers, each with its own cloned DB; serializer around `CREATE DATABASE ... TEMPLATE` to avoid template-busy races.
- Strategic PG-test ordering: longest-duration-first (LPT scheduling) across workers, using a committed `.genie/state/test-durations.json` timing cache.
- CI workflow split: PG-tests job vs non-PG-tests job on separate Blacksmith runners, both feeding `quality-gate` status.
- Quarantine three existing perf flakes: `executor-read p99 < 10ms`, `events-stream persisted cursor resume`, `trace-context parseToken` — widen thresholds or mark `.flaky` with issue links.

### OUT

- Replacing `bun test` with another runner (Vitest, Node test runner) — single-runner constraint.
- Switching pgserve to `pglite` WASM in-process — explicitly off-scope.
- Switching PG isolation from database-clone to schema-per-test — migrations assume `public` schema; rework is too wide for this wish.
- Changing migration tooling or migration content.
- Reducing the 1041 PG-dependent tests by mocking out the database.
- CI-runner upgrades (Blacksmith vCPU, cache tier changes).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Shared daemon via `~/.genie/data/test-pgserve.lock` not ephemeral per-run | Saves ~4s per pre-push; orphan-reap already handles crash recovery. |
| 2 | Template cache keyed on SHA-256 of migration sources | Skips ~1s when migrations unchanged. Invalidation is deterministic. |
| 3 | macOS RAM disk via `hdiutil attach -nomount ram://…` behind env flag first | Zero-risk soak; darwin lacks `/dev/shm`, so APFS hits dominate local times. |
| 4 | Parallelism via multi-process `bun test --shard`, not `--concurrency` within a process | Bun's in-process concurrency is file-level; shard split is deterministic and isolates CREATE DATABASE serialization per worker. |
| 5 | LPT (Longest Processing Time) scheduling with a committed duration cache | Classic ≥(4/3)·OPT bound; caching in-repo survives fresh clones and keeps shards balanced. |
| 6 | Split CI: `pg-tests` job (full pgserve) + `unit-tests` job (no pgserve), both required for `quality-gate` | Hides ~3s pgserve boot behind the unit-tests critical path; non-PG suite finishes in ~20s. |
| 7 | Quarantine, not delete, the three perf flakes | Tests cover real invariants; relaxing thresholds on CI (`process.env.CI` branch) keeps the assertion meaningful locally. |
| 8 | Fail-closed: if any optimization regresses correctness, revert that item individually | Bundle is nine loosely-coupled changes; each must be revertible without touching the others. |
| 9 | Duration cache distributed via GitHub Actions artifact, not committed to the repo | `actions/upload-artifact@v4` on main-branch success + `actions/download-artifact@v4` on each run avoids merge conflicts on `.genie/state/test-durations.json`, eliminates the need for a rolling-pr bot (not present in this repo), and gracefully degrades to median-estimate when the artifact is missing. |

## Success Criteria

- [ ] CI `quality-gate` Test step median ≤ 30s on Blacksmith 8-vCPU (baseline: 71s median, 15 sample runs 2026-04-21..04-22).
- [ ] `bun run check` fresh clone (no lockfile reuse, no template cache) ≤ 60s on M-series Mac and Blacksmith 8-vCPU Linux (baseline: ~130s cold, derived from 105s `bun test` + ~25s typecheck/lint/dead-code, local warm daemon on M-series Mac).
- [ ] `bun run check` warm shell (lockfile + template hot) ≤ 45s on M-series Mac and Blacksmith 8-vCPU Linux.
- [ ] `bun test` on macOS runs in RAM when `GENIE_TEST_MAC_RAM=1` — verified by `mount | grep /Volumes/genie-test-ram` and pgserve data dir residing on that mount.
- [ ] Non-PG `bun test` invocations (those with no `test-db.ts` imports in the loaded files) skip pgserve boot entirely — verified by absence of `[test-setup] pgserve` log line.
- [ ] Ten consecutive full-suite runs produce 0 pgserve-attributable failures (template-busy, connection-refused, deadlock, port-race). Real test regressions don't count.
- [ ] The three quarantined flakes (`executor-read p99`, `events-stream cursor resume`, `trace-context parseToken`) no longer appear in any CI failure in the 10-run sample.
- [ ] Duration cache `.genie/state/test-durations.json` is updated by a CI artifact step on every successful dev-branch run, and consumed by the next run's scheduler.
- [ ] `bun test --shard=1/4`, `2/4`, `3/4`, `4/4` each complete in ≤ the slowest-shard 95th-percentile (within 15% of each other — LPT balance target).
- [ ] All nine items are independently revertible: each lands as its own commit with a clean single-item diff and a `Revert with: git revert <sha>` footer.

## Execution Strategy

Nine items organized into three sequential waves. Within each wave, items are parallel-safe. Later waves depend on infrastructure landed in earlier ones (e.g., shared daemon must exist before parallelism can safely serialize `CREATE DATABASE TEMPLATE` contention).

### Wave 1 (parallel — foundations, no behavior change to test execution)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Shared long-lived pgserve daemon with lockfile reuse |
| 2 | engineer | Template DB cache keyed on migration-source hash |
| 3 | engineer | Admin-connection reuse in `test-setup.ts` |
| 4 | engineer | Quarantine the three existing perf flakes (CI-branch threshold widening) |

### Wave 2 (parallel — extend reach, depend on Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Lazy pgserve boot — skip when no test file imports `test-db.ts` |
| 6 | engineer | macOS RAM disk path behind `GENIE_TEST_MAC_RAM=1` flag |

### Wave 3 (sequential — throughput changes, depend on Wave 1 + 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Per-file parallelism via `bun test --shard` + CREATE DATABASE serializer |
| 8 | engineer | LPT scheduling with committed `test-durations.json` cache |
| 9 | engineer | CI workflow split: `pg-tests` + `unit-tests` jobs feeding `quality-gate` |

## Execution Groups

### Group 1: Shared long-lived pgserve daemon

**Goal:** Reuse a single `pgserve --ram` child across multiple `bun test` invocations via a lockfile handshake.

**Deliverables:**
1. `src/lib/test-setup.ts` writes `~/.genie/data/test-pgserve.lock` (JSON: `{port, pid, startedAt}`) on successful boot.
2. On subsequent preload, if the lockfile points at a healthy pgserve (port responds to `SELECT 1`), reuse it; otherwise reap and re-spawn.
3. Stale-reap heuristic widened to `age > 1h OR ppid=1 OR health-probe-fails`.
4. `GENIE_TEST_PG_NO_REUSE=1` env opt-out for CI jobs that want hermetic isolation.

**Acceptance Criteria:**
- [ ] Second `bun test src/lib/wish-state.test.ts` invocation in the same shell reuses the first run's pgserve (observable: no `[test-setup] pgserve --ram on port` log on second invocation).
- [ ] Killing the daemon between invocations triggers clean re-spawn on the next run.
- [ ] `src/lib/test-setup.test.ts` adds a case proving reuse and a case proving reap-after-kill.

**Validation:**
```bash
bun test src/lib/test-setup.test.ts && \
  bun test src/lib/wish-state.test.ts > /tmp/run1.log 2>&1 && \
  bun test src/lib/wish-state.test.ts > /tmp/run2.log 2>&1 && \
  grep -q "pgserve --ram" /tmp/run1.log && \
  ! grep -q "pgserve --ram" /tmp/run2.log
```

**depends-on:** none

---

### Group 2: Template DB cache keyed on migration hash

**Goal:** Skip the `genie_template` migration replay when the migration source hash is unchanged since the last run.

**Deliverables:**
1. Compute SHA-256 of concatenated migration SQL + `db-migrations.ts` source at preload.
2. Store the hash in `~/.genie/data/test-pgserve.lock` alongside port/pid.
3. On boot, if daemon is reused AND stored hash matches current hash AND `genie_template` exists, skip `buildTemplateDatabase`.
4. Always rebuild when hash mismatches or daemon is fresh.

**Acceptance Criteria:**
- [ ] Two consecutive runs with unchanged migrations: second run skips migration replay (timing: second preload < 300ms after pgserve health check).
- [ ] Editing a migration file: next run rebuilds the template.
- [ ] `src/lib/test-setup.test.ts` adds a case for hash-match skip and a case for hash-mismatch rebuild.

**Validation:**
```bash
bun test src/lib/test-setup.test.ts
# and timing check:
bun test src/lib/wish-state.test.ts > /dev/null 2>&1 && \
  /usr/bin/time -p bun test src/lib/wish-state.test.ts 2>&1 | awk '/real/ {if ($2+0 > 2.5) {print "too slow"; exit 1}}'
```

**depends-on:** Group 1

---

### Group 3: Admin-connection reuse

**Goal:** Reuse a single long-lived admin pg client for `createTestDatabase` / `dropTestDatabase` instead of opening + closing one per call.

**Deliverables:**
1. `src/lib/test-setup.ts` holds a module-scoped admin client opened once after pgserve is healthy.
2. `createTestDatabase` / `dropTestDatabase` use that shared client.
3. Client is torn down in `stopTestPgserve()`.
4. `buildTemplateDatabase` continues to use a dedicated short-lived template-DB client (it connects to the template, not `postgres`).

**Acceptance Criteria:**
- [ ] 51 PG-test files complete their `createTestDatabase` / `dropTestDatabase` pairs with exactly 1 admin TCP connection per `bun test` run (not 51×2).
- [ ] No regression on `src/lib/test-setup.test.ts` and PG-dependent test files.

**Validation:**
```bash
# Instrument pgserve logs or pg_stat_activity to count admin connections.
bun test
```

**depends-on:** none

---

### Group 4: Quarantine the three existing perf flakes

**Goal:** Stop the `executor-read p99`, `events-stream cursor resume`, and `trace-context parseToken` assertions from tripping under CI load without losing their local-dev signal.

**Deliverables:**
1. `src/lib/executor-read.test.ts:167` — `test('read latency is well under the 10ms p99 budget', …)`: gate the `< 10 ms p99` assertion behind `!process.env.CI`, and under CI widen the threshold to the observed 95th percentile × 3 with a TODO comment linking a new issue.
2. `src/term-commands/events-stream.test.ts:140` — `test('persisted cursor resumes on reconnect', …)`: raise the 2s wait to 10s under `process.env.CI`, and add a retry loop.
3. `src/lib/trace-context.test.ts:43` — `test('parseToken rejects tampered signatures', …)`: remove timing-sensitive expectations if any; verify the test is purely logical (inspect first, patch only if needed).
4. File three GitHub issues to track the real fix; link from TODOs.

**Acceptance Criteria:**
- [ ] Ten consecutive CI runs on the branch show 0 occurrences of the three failure names.
- [ ] Local `bun test` with `CI=1 bun test …` reproduces the old tight thresholds.
- [ ] Three GitHub issues are filed and linked from test-file TODOs.

**Validation:**
```bash
bun test src/lib/executor-read.test.ts src/term-commands/events-stream.test.ts src/lib/trace-context.test.ts
```

**depends-on:** none

---

### Group 5: Lazy pgserve boot for non-PG invocations

**Goal:** Skip pgserve boot entirely when no test file in the current `bun test` invocation imports `test-db.ts`.

**Deliverables:**
1. At preload, inspect `process.argv` + `Bun.argv` to resolve the test-file glob.
2. Grep the matched files for `test-db` imports (fast regex over the source set).
3. If none match, set `GENIE_TEST_SKIP_PGSERVE=1` and short-circuit.
4. Fall back to eager boot when glob resolution is ambiguous (safe default).

**Acceptance Criteria:**
- [ ] `bun test src/lib/knip-stub.test.ts` (no PG) emits no `[test-setup] pgserve --ram` log and returns in < 3s.
- [ ] `bun test src/lib/wish-state.test.ts` (PG) still boots pgserve normally.
- [ ] Full-suite `bun test` boots pgserve (some files in the suite use PG).

**Validation:**
```bash
out=$(bun test src/lib/knip-stub.test.ts 2>&1); \
  ! grep -q "pgserve --ram" <<< "$out" && \
  bun test src/lib/wish-state.test.ts 2>&1 | grep -q "pgserve"
```

**depends-on:** Group 1

---

### Group 6: macOS RAM disk path

**Goal:** Store pgserve data in a RAM-backed volume on darwin to match Linux `/dev/shm` performance.

**Deliverables:**
1. `src/lib/test-setup.ts` detects `platform() === 'darwin'` and `GENIE_TEST_MAC_RAM=1`.
2. Creates a 1 GiB RAM disk via `hdiutil attach -nomount ram://2097152` + `diskutil erasevolume HFS+ genie-test-ram /dev/disk…` on first boot.
3. Passes `--data /Volumes/genie-test-ram/pgserve` to pgserve.
4. Cleans up the RAM disk on daemon reap (shared with Group 1's reap logic).
5. Docs update in `CLAUDE.md` under Testing section.

**Acceptance Criteria:**
- [ ] `GENIE_TEST_MAC_RAM=1 bun test` on macOS mounts `/Volumes/genie-test-ram`, and pgserve data resides on that mount.
- [ ] Unmounting + running again re-creates the disk cleanly.
- [ ] `bun test` without the env flag is unchanged (falls back to ephemeral temp dir).
- [ ] Local `bun run check` (warm) on M-series macOS with flag set ≤ 45s.

**Validation:**
```bash
GENIE_TEST_MAC_RAM=1 bun test src/lib/wish-state.test.ts && \
  mount | grep -q '/Volumes/genie-test-ram' && \
  ls /Volumes/genie-test-ram/pgserve
```

**depends-on:** Group 1

---

### Group 7: Per-file parallelism via shards + CREATE DATABASE serializer

**Goal:** Run `bun test --shard=N/K` workers in parallel, with a file-lock serializer around `CREATE DATABASE ... TEMPLATE` to prevent template-busy races.

**Deliverables:**
1. `scripts/test-parallel.ts` spawns K=4 `bun test --shard=i/K` children against the shared daemon.
2. Shards use distinct database-name prefixes (`test_shard1_…` etc.) to avoid name collisions.
3. Inside `createTestDatabase` in `src/lib/test-setup.ts`, call `SELECT pg_advisory_lock(<stable-int-id>)` on the shared admin client BEFORE issuing `CREATE DATABASE ... TEMPLATE genie_template`, and `SELECT pg_advisory_unlock(<same-id>)` immediately after the create returns (or on error). PG-level serialization — no OS file-lock involved. The lock id is a compile-time constant (e.g. hash of `"pg-test-perf:create-db"` truncated to int64) so every worker agrees on the same id.
4. Stdout streams interleaved with shard-id prefix; exit code is max of all shards.
5. `package.json` adds `"test:parallel": "bun run scripts/test-parallel.ts"`.

**Acceptance Criteria:**
- [ ] `bun run test:parallel` runs 4 workers, total wall-clock ≤ 40s on Blacksmith 8-vCPU.
- [ ] No template-busy errors across 10 consecutive `bun run test:parallel` runs.
- [ ] Individual shards are reproducible: same file set each run for a given shard index.

**Validation:**
```bash
for i in 1 2 3 4 5 6 7 8 9 10; do bun run test:parallel || exit 1; done
```

**depends-on:** Group 1, Group 3

---

### Group 8: LPT scheduling + duration cache

**Goal:** Assign test files to shards by longest-first (LPT) using a checked-in duration cache so shards finish within 15% of each other.

**Deliverables:**
1. CI step on successful `main`-branch runs uploads per-file duration as a GitHub Actions artifact via `actions/upload-artifact@v4` (artifact name: `test-durations`, retention 14 days). No commit, no `.genie/state/test-durations.json` in the repo.
2. Subsequent CI runs pull the latest successful `main`-branch artifact via `actions/download-artifact@v4` (using `gh run download` or the action's `run-id: <latest-main-success>` input) before sharding.
3. `scripts/test-parallel.ts` reads the downloaded `test-durations.json` from the workflow workspace, applies LPT to sort files descending, greedily packs into K shards, then overrides `bun test --shard` with an explicit file list per worker.
4. If no artifact is available (first run, expired, new fork), scheduler falls back to median-estimate for every file — no crash, no commit.
5. Missing-duration files within an otherwise-present artifact get assigned the median of known durations so new tests don't break LPT.

**Acceptance Criteria:**
- [ ] `bun run test:parallel` shard wall-clocks are within 15% of each other (measured on 5 consecutive runs).
- [ ] Adding a new test file without updating the cache doesn't crash the scheduler — falls back to median-estimate.

**Validation:**
```bash
bun run test:parallel --report-shard-times
# scripted check on output: max/min <= 1.15
```

**depends-on:** Group 7

---

### Group 9: CI job split

**Goal:** Split CI `quality-gate` into two parallel Blacksmith jobs: `pg-tests` (full pgserve, PG files only) and `unit-tests` (no pgserve, non-PG files only). Both gate the merge.

**Deliverables:**
1. `.github/workflows/ci.yml` adds `unit-tests` job on a 4-vCPU Blacksmith runner, runs `bun test --no-pgserve` (env → `GENIE_TEST_SKIP_PGSERVE=1`) with only non-PG files.
2. `pg-tests` job on an 8-vCPU runner runs `bun run test:parallel` (Group 7/8).
3. Retain an umbrella `quality-gate` job that declares `needs: [pg-tests, unit-tests]` and runs a trivial `run: echo "All sub-jobs passed"`. Branch protection continues to require `quality-gate` as the single status check — **no branch-protection configuration changes**.
4. Concurrency group key updated to cancel `pg-tests`, `unit-tests`, and the umbrella `quality-gate` together on new pushes.
5. `typecheck` / `lint` / `dead-code` move to the `unit-tests` job (short critical path).

**Acceptance Criteria:**
- [ ] Both jobs pass on a test PR against this branch.
- [ ] `unit-tests` job wall-clock ≤ 20s (median).
- [ ] `pg-tests` job wall-clock ≤ 30s (median).
- [ ] Umbrella `quality-gate` job is present in `ci.yml`, declares `needs: [pg-tests, unit-tests]`, and runs a trivial echo step. It succeeds iff both sub-jobs succeed.
- [ ] Branch-protection config on GitHub is unchanged — still requires only `quality-gate`. Verified by `gh api repos/:owner/:repo/branches/main/protection` diff before/after.
- [ ] Merge queue still requires `quality-gate` status.

**Validation:**
```bash
gh pr create --draft --title "ci: verify split quality-gate" && \
  gh pr checks --watch
```

**depends-on:** Group 5, Group 7, Group 8

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] CI `quality-gate` median wall-clock on 10 consecutive dev merges ≤ 30s (Test-step equivalent).
- [ ] `bun run check` on a fresh clone completes in ≤ 60s on both supported platforms.
- [ ] `bun run check` on a warm workspace completes in ≤ 45s.
- [ ] No pgserve-attributable failures (template-busy, port-race, connection-refused, deadlock) across the same 10 merges.
- [ ] Full-suite local `bun test` on an M-series Mac with `GENIE_TEST_MAC_RAM=1` completes in ≤ 60s.
- [ ] `bun test` on a non-PG file subset (e.g., `bun test src/lib/knip-stub.test.ts`) emits no `[test-setup] pgserve` log.
- [ ] The three quarantined tests no longer appear in any CI failure during the observation window.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Concurrent `CREATE DATABASE ... TEMPLATE genie_template` races across shards (pgserve/pglite quirks). | Medium | Group 7 uses `pg_advisory_lock(<stable-id>)` — PG-level serialization, not file-lock — so contention is handled inside the database, not the filesystem. Group 7 validation runs the suite 10× before landing. Fallback: drop K from 4→2 shards. |
| Bun `--shard` allocation changes in a future version, breaking LPT assignment. | Low | Group 8 uses explicit file-lists, not `--shard`, after duration cache is populated. |
| RAM-disk creation on macOS requires elevated privileges on some host configs. | Medium | Gate behind opt-in env flag; document the `sudo`-free `hdiutil` path; graceful fallback to ephemeral dir on failure. |
| Widening the three flake thresholds masks a real regression. | Low | File GitHub issues with fixed owners + due date; CI continues to record timings so the drift is observable. |
| Duration cache `.genie/state/test-durations.json` becomes stale on branches with heavy test churn. | Low | Missing-file fallback uses median-estimate; cache is refreshed on every successful dev merge. |
| Splitting CI jobs changes required-status-check semantics in branch protection. | Medium | Validate on a throwaway PR before merging Group 9; keep `quality-gate` as the umbrella status. |
| Shared daemon lockfile stale after kernel panic / hard reboot. | Low | Stale-reap widens to `age > 1h` and always re-probes health before reuse. |
| `bun test` preload regex for detecting `test-db` imports misses indirect imports (e.g., through a helper). | Low | Fall back to eager pgserve boot when the file-set can't be statically determined; this is a pure-miss (slower), not a miss (broken). |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/lib/test-setup.ts                     # groups 1, 2, 3, 5, 6
src/lib/test-db.ts                        # group 3
src/lib/test-setup.test.ts                # groups 1, 2, 3, 5
scripts/test-parallel.ts                  # groups 7, 8 (new)
.github/workflows/ci.yml                  # groups 8, 9 (artifact upload/download + split jobs)
package.json                              # groups 7, 9 (new scripts)
bunfig.toml                               # group 7 (potentially)
CLAUDE.md                                 # group 6 (Testing section)
src/lib/executor-read.test.ts             # group 4
src/term-commands/events-stream.test.ts   # group 4
src/lib/trace-context.test.ts             # group 4 (inspect only)
.genie/wishes/pg-test-perf/               # this wish + follow-on reports
```
