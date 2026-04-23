# Wish: Test Suite Deflake

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `test-suite-deflake` |
| **Date** | 2026-04-22 |
| **Design** | _No brainstorm — direct wish_ (origin: live observation across 5 consecutive `bun test` runs 2026-04-21/22 on `fix/turn-close-row-targeting`; documented failure rate fluctuation 0/1/2/3 failures per run with identical code + machine) |

## Summary

Eliminate the structural flakiness in `bun run check` that produces 0–3 non-deterministic failures per full-suite run. Root cause is **concurrent test-file setup saturating the shared `--ram` pgserve**: 48 test files call `setupTestSchema()`, bun runs 20 concurrently by default, and `src/lib/test-db.ts` silently absorbs setup failures via `return async () => {};` catches — tests then run against uninitialized PG state and fail non-deterministically. Fix by (a) surfacing setup failures as explicit skips instead of silent garbage runs, (b) capping test concurrency for DB-backed suites, (c) serializing `setupTestSchema` via in-process mutex so only one file at a time runs the `CREATE SCHEMA + runMigrations` critical section. P0 (listen-bomb timeout) was already shipped in commit `a1555b97 test(pentest): bump listen-bomb flood-spill timeout to 15s` — this wish covers the remaining residual Classes B and C.

## Scope

### IN
- Replace silent catches in `src/lib/test-db.ts` with explicit `DB_SETUP_FAILED` flag + `describe.skipIf(DB_SETUP_FAILED)` pattern callers can consume
- Serialize `setupTestSchema` via in-process mutex so `CREATE SCHEMA + runMigrations + dropNotifyTriggers` run one-at-a-time
- Tune `bunfig.toml` test concurrency cap (propose 8, measure; target zero flakes on full-suite x20 consecutive runs)
- Raise `postgres` client `connect_timeout` from 5s to 15s; raise `idle_timeout` from 1s to 30s; raise `max` from 1 to 2 on the admin connection (to survive transient connection close during retry)
- Measurement: baseline pass/fail rate across 20 consecutive `bun test` runs on `origin/dev` before changes; same measurement after changes; proof is <=1 flake per 20 runs sustained
- Documentation note in CLAUDE.md Testing section naming the concurrency cap + mutex pattern so future contributors don't silently re-introduce it

### OUT
- P0 listen-bomb timeout fix — already shipped in `a1555b97`
- Rewriting any test that uses `setupTestSchema` — the fix is at the helper layer
- Changing pgserve itself (capacity tuning, connection limits) — addressed separately if P1 cap + P2 mutex don't converge
- Individual test-specific timeouts (those are Class A, one-offs — handle ad hoc as observed)
- Moving tests off PG entirely (out of scope — genie tests validate real SQL behavior)

## Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Silent catches become loud skips, not loud failures | Failing a whole suite on a transient pgserve blip is worse than skipping the DB tests that round. Skips ARE the correct signal — they tell operators "PG was unavailable" without masking the event. |
| D2 | In-process mutex for `setupTestSchema`, not a distributed lock | Bun runs tests in one process with worker threads; a simple `async-mutex` or hand-rolled semaphore suffices. Cross-process is irrelevant because bun doesn't do multi-process test execution by default. |
| D3 | Test concurrency cap at 8, not 4 or 1 | 4 is conservative and will noticeably slow the suite. 8 balances DB pressure vs runtime. Measure both values against the 20-consecutive-runs gate before committing to a number. |
| D4 | Do not touch individual test files' hooks | Per-test timeout misconfigurations (Class A, e.g. listen-bomb) are individual bugs, not infrastructure bugs. Fix them one at a time as observed, not as a bulk change. |
| D5 | Measurement-gated approval — no merge until 20 consecutive runs on the fixed branch hit zero flakes | Council discipline from `agent-row-unification` rejection: "data should justify the operation." Same discipline applies in reverse — data must justify that the fix actually works. |

## Success Criteria

- [ ] **C1** `src/lib/test-db.ts` `setupTestSchema` no longer returns no-op cleanup silently. Failure path sets module-level `DB_SETUP_FAILED` flag, logs `[test-db] pgserve unreachable — DB-backed tests will skip`, and returns a skip-marker.
- [ ] **C2** `describe.skipIf(DB_SETUP_FAILED)` pattern documented as the canonical guard for DB-backed test blocks; audit confirms all 48 callers use it.
- [ ] **C3** `setupTestSchema` acquires an in-process mutex before `CREATE SCHEMA`, releases after `dropNotifyTriggers` completes. Only one file at a time executes the critical section.
- [ ] **C4** `bunfig.toml` sets test concurrency to 8; `[test]` section documented.
- [ ] **C5** `postgres` client config in `setupTestSchema` + `cleanupSql`: `connect_timeout: 15`, `idle_timeout: 30`, `max: 2`.
- [ ] **C6** Baseline measurement captured: 20 consecutive `bun test` runs on `origin/dev` at a named commit SHA recorded in `baseline.md`. Target: document current pass-rate distribution.
- [ ] **C7** Post-fix measurement: 20 consecutive `bun test` runs on the fix branch. SHIP gate: ≤1 flake across 20 runs (95% pass).
- [ ] **C8** CLAUDE.md Testing section updated with concurrency-cap + mutex notes.

## Execution Strategy

Dependency graph: `G1 → G2 → G3 → G4`. Each group is a separate PR, revertible independently. No flag — this is a test-infra change, not a behavior change; flags add cost without reversibility benefit.

### Wave 1 (solo — measurement baseline)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | qa | 20× `bun test` runs on `origin/dev` at a pinned SHA; record pass/fail/timing into `baseline.md`. Establishes the "before" distribution. |

### Wave 2 (parallel — three independent fixes, each its own PR)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Loud-skip instead of silent-catch in `setupTestSchema`. Audit + migrate callers to `describe.skipIf(DB_SETUP_FAILED)`. |
| 3 | engineer | In-process mutex around `CREATE SCHEMA + runMigrations + dropNotifyTriggers`. Use `async-mutex` package or hand-rolled promise chain; benchmark choice. |
| 4 | engineer | `bunfig.toml` concurrency cap + `postgres` client timeout tuning. Single two-line PR. |

### Wave 3 (solo — measurement + gate)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | qa | 20× `bun test` runs on the combined fix branch. SHIP gate = ≤1 flake. If fails, iterate on cap value (8 → 6 → 4) until gate passes. Record into `after.md`. |

## Execution Groups

### Group 1: Baseline measurement
**Goal:** Quantify the "before" flake rate so we can prove the fix actually worked.

**Deliverables:**
1. `scripts/deflake-measure.sh` — runs `bun test` N times, records exit code + test-count summary per run to `.genie/wishes/test-suite-deflake/measurement-YYYYMMDD.log`
2. Execute 20 runs on `origin/dev` at a pinned SHA. Commit log output.
3. `.genie/wishes/test-suite-deflake/baseline.md` — summary: N pass, mean fail count, most common failing test

**Acceptance Criteria:**
- [ ] Script runs 20 iterations cleanly
- [ ] Baseline doc present, cites commit SHA + bun version + machine
- [ ] Summary table lists each run's pass/fail count

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bash scripts/deflake-measure.sh 20 origin/dev && test -f .genie/wishes/test-suite-deflake/baseline.md
```

**depends-on:** none

---

### Group 2: Loud-skip setup failures
**Goal:** Silent PG-unavailable catches become explicit skips that test files can observe.

**Deliverables:**
1. Refactor `src/lib/test-db.ts`: module-level `DB_SETUP_FAILED` boolean, set true when `ensurePgserve` or `CREATE SCHEMA` throws; `setupTestSchema` logs the reason and returns a marker cleanup. Callers consume `describe.skipIf(DB_SETUP_FAILED)` or the existing `DB_AVAILABLE` flag (extended to reflect setup success, not just pgserve presence).
2. Audit all 48 callers (`rg "setupTestSchema" src/ test/`); convert silent-test-runs-against-bad-state patterns to explicit skip guards.
3. Tests: unit-test the skipIf flow with injected pgserve failure mock.

**Acceptance Criteria:**
- [ ] `setupTestSchema` never returns silent no-op cleanup without logging
- [ ] All 48 callers use explicit `skipIf` guard; grep confirms zero unguarded usages
- [ ] Simulated pgserve failure produces "skipped" status in bun output, not "fail"
- [ ] `bun run check` passes on a machine with pgserve deliberately disabled (suite skips DB tests, doesn't fail)

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/lib/test-db.test.ts && bun run check
```

**depends-on:** Group 1 (baseline established first)

---

### Group 3: Serialize setup via mutex
**Goal:** Only one test file at a time executes `CREATE SCHEMA + runMigrations + dropNotifyTriggers`. Parallelism preserved at the test-function level.

**Deliverables:**
1. Add a simple mutex to `src/lib/test-db.ts` — `await setupMutex.acquire()` at the top of `setupTestSchema`, `release` in a `finally` after cleanup registration.
2. Benchmark: if using `async-mutex` package, document it; if hand-rolled, include unit test that verifies serialization.
3. Ensure mutex does NOT block test-function execution — only the setup critical section.

**Acceptance Criteria:**
- [ ] Two concurrent `setupTestSchema` calls serialize (observable via timing + log interleaving)
- [ ] Test-function execution still parallel after setup completes
- [ ] `bun run check` runtime does not regress >20% vs baseline (mutex overhead tolerable)
- [ ] Unit test for mutex serialization passes

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/lib/test-db.test.ts
```

**depends-on:** Group 2 (skipIf infrastructure lands first so mutex timeouts become visible skips, not hidden stalls)

---

### Group 4: Concurrency cap + pool timeouts
**Goal:** Reduce raw concurrency pressure on pgserve. Complements mutex.

**Deliverables:**
1. `bunfig.toml` `[test]` section: `concurrency = 8` (initial value — tune in Group 5).
2. `src/lib/test-db.ts` postgres client config: `connect_timeout: 15`, `idle_timeout: 30`, `max: 2` on admin connection.
3. Same tuning on `cleanupSql` connection in the cleanup closure.
4. CLAUDE.md Testing section: add note about concurrency cap and mutex, pointing at this wish's runbook.

**Acceptance Criteria:**
- [ ] `bunfig.toml` concurrency cap present
- [ ] postgres client configs tuned per spec
- [ ] CLAUDE.md updated
- [ ] `bun run check` passes with new cap + tuning

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && cat bunfig.toml && bun run check
```

**depends-on:** Group 3

---

### Group 5: Post-fix measurement + SHIP gate
**Goal:** Prove the fix actually eliminated flakes at the measurement level, not just "it feels better."

**Deliverables:**
1. Re-run `scripts/deflake-measure.sh 20 <fix-branch>` on the combined fix branch (G2+G3+G4 merged).
2. `.genie/wishes/test-suite-deflake/after.md` — same schema as baseline.md.
3. SHIP gate: ≤1 flake across 20 runs AND runtime regression <20% vs baseline.
4. If gate fails, iterate: drop concurrency cap from 8 → 6 → 4 until gate passes.

**Acceptance Criteria:**
- [ ] After-measurement doc present
- [ ] ≤1 flake across 20 runs (95% green rate)
- [ ] Runtime regression <20% vs baseline
- [ ] Final concurrency value documented in bunfig.toml comment

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bash scripts/deflake-measure.sh 20 HEAD && cat .genie/wishes/test-suite-deflake/after.md
```

**depends-on:** Groups 2, 3, 4

---

## Dependencies

- **depends-on:** none (standalone test-infra work)
- **blocks:** smoother `genie-configure` developer experience; smoother PR-review flow (no more `--no-verify` bypass narrative on flaky test pushes)
- **related:** `test-pg-ram-isolation` (prior wish that introduced the --ram pgserve pattern; this wish completes that work by addressing the residual concurrency pressure)

## QA Criteria

_Verified on the combined fix branch before merge._

- [ ] 20× consecutive `bun test` runs on fix branch: ≥19/20 pass (≤1 flake)
- [ ] 3× consecutive `bun run check` runs: 3/3 pass (integration smoke test)
- [ ] Deliberate `pgserve` stop mid-suite: suite gracefully skips DB tests with loud logs, does not hang
- [ ] Deliberate `pgserve` crash during setup: `setupTestSchema` times out loudly (not silently), tests skip with reason
- [ ] CI flake rate on dev merges to main: ≥14 days observation window with ≤1 flake per 20 pushes

## Assumptions / Risks

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | The mutex adds contention that outweighs the flake reduction | MEDIUM | Group 3 benchmark; if >20% regression, fall back to Group 4 cap-only approach |
| R2 | Concurrency cap at 8 is too low; suite becomes painfully slow | LOW-MEDIUM | Group 5 iterates; final value tuned against SHIP gate |
| R3 | Class B root cause is actually somewhere else (e.g., filewatch preloading, NATS mock setup) not covered by this wish | MEDIUM | Group 1 baseline captures failure distribution; if most failures are NOT in DB-backed tests, re-scope wish |
| R4 | Fresh `setupTestSchema` design reveals existing tests were passing *because* of the silent fallback (relying on uninitialized state) | LOW | Group 2 audit catches this before merge; any tests "passing by accident" become visible skips and can be fixed properly |
| R5 | `--ram` pgserve has a hard connection limit that even cap+mutex can't solve | LOW | Would require pgserve-side fix; this wish's Group 5 measurement surfaces it if true |

## Review Results

_Populated by `/review` after execution completes. First plan-review can run immediately; execution-review after Group 5._

## Files to Create/Modify (provisional)

```
Created:
  scripts/deflake-measure.sh
  .genie/wishes/test-suite-deflake/baseline.md            (Group 1 output)
  .genie/wishes/test-suite-deflake/after.md               (Group 5 output)
  src/lib/test-db.test.ts                                 (Groups 2, 3 unit tests)

Modified:
  src/lib/test-db.ts                  (skipIf flag + mutex + pool timeouts)
  bunfig.toml                         (test concurrency cap)
  CLAUDE.md                           (Testing section note)
  ~48 test files                      (Group 2 — replace silent-skip usages with `describe.skipIf(DB_SETUP_FAILED)`)
```
