# Wish: Graceful lifecycle-lease busy handling for update/install/uninstall

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS |
| **Slug** | `lifecycle-lease-busy-grace` |
| **Date** | 2026-08-02 |
| **Author** | Felipe Rosa + Genie |
| **Appetite** | small |
| **Branch** | `wish/lifecycle-lease-busy-grace` |
| **Repos touched** | genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

`genie update` crashed with a raw Bun stack trace ("Another Genie lifecycle command is active: another agent-sync run holds the lock…") because the shared lifecycle lease is single-attempt fail-fast and the busy path throws a bare `Error`. This wish makes lifecycle commands steal a provably-dead same-host holder immediately, wait briefly for a live one, and — when the wait genuinely times out — print an accurate, actionable message with exit code 2, never a stack trace.

**Incident evidence (2026-08-02, linux-x64-glibc, 5.260728.8 → 5.260802.1):** the crash occurred at ~19:49 while `~/.genie-lifecycle-40f4cac7c62506dd.lock` held record `1683714:<token>:<start-identity>:<host>` with mtime 19:48:21. At 19:59 pid 1683714 was **not running** and the lock was still present. Because `acquireFileLock`'s staleness gate (`src/lib/agent-sync.ts:5921`) short-circuits before the liveness check (`:5924`), a dead holder inside the 10-minute `LOCK_STALE_MS` window is never stolen — waiting alone would not have fixed this incident; only dead-holder stealing or a 10-minute delay would.

## Scope

### IN

- **Same-host dead-holder early steal:** steal the lock regardless of mtime freshness **iff** `owner.host === currentSyncLockHostId()` **and** `lockOwnerIsLive(owner) === false` (the existing `lockOwnerIsLive` semantics: dead pid ⇒ dead; live pid + mismatched start-identity ⇒ pid reuse ⇒ dead; EPERM or unprovable liveness ⇒ alive; cross-host ⇒ never judged). Unknown/absent host or a record that fails to parse keeps today's conservative stale-window behavior — this positive host-match requirement is load-bearing: it protects the create→write window in `tryInitializeFileLock` where a not-yet-written lock parses to `null`.
- **Bounded wait** for the agent-sync lifecycle lease in `update`, `install`, and `uninstall` (default ~15s, env-overridable `GENIE_LIFECYCLE_LEASE_WAIT_MS`, `0` = single attempt), retrying only genuinely-held/contended outcomes — never borrow-mismatch or IO failures. Precedent: `acquireRetirementLock` (`src/lib/agent-sync.ts:2997-3025`).
- **Structured skip cause** on `acquireLifecycleLease` (e.g. `cause: 'borrow-mismatch' | 'held' | 'io' | 'contended'`) so the wait loop and messages discriminate without string-matching.
- **Graceful busy projection at all four raw-throw sites:** `src/genie-commands/update.ts:2473` (`acquireUpdateLifecycleLeasesOrProject`), `update.ts:1665` (`acquireRequiredLifecycleLease`, serving `--rollback` / `--sync-only` / `--post-delivery-converge`), `install.ts:402`, `uninstall.ts:3483` — exit 2 with a one-line stderr message, no stack trace.
- **Accurate wording at the source:** rewrite `heldLockSkip()` (`agent-sync.ts:5976`) to name the lock path and drop "(the holder converges the same targets)" — a claim that is false for lifecycle commands. This also fixes `setup`'s parroted message (`setup.ts:156`) for free.
- **DI seam for the uninstall agent-sync lease** (`UninstallDeps.acquireLease`) so its busy path is testable in-process like update's and install's.
- Regression tests for the busy paths: held → timeout → exit 2; held → released mid-wait → proceeds; dead-holder-fresh-lock → stolen and proceeds.

### OUT

- No change to agent-sync's own skip behavior or report wording — `runAgentSync` builds its own literal (`agent-sync.ts:6959`) on a separate path and a concurrent holder there really does converge the same targets. Its separate lock implementation (`acquireAgentMutationLock:6275` / `stealStaleAgentLock:6749`) keeps the fresh-dead-holder blind spot **deliberately**: an agent-sync run skipping is harmless (the next run converges), unlike a blocked update.
- No change to the codex-lease busy path (`CodexLifecycleBusyError` already projects gracefully with exit 2 and a trailer).
- No change to the staleness window (10 min), cross-host or unknown-host steal rules, lock file format (the existing 4-field record already carries host + start-identity), or the borrowed-lease (`--post-delivery-converge`) protocol.
- No change to `install.sh`'s shell-side lock loop (4 fail-fast attempts) — the shell path hands `genie install` a borrowed lease anyway (`install.sh:813-818`).
- No lock queueing/fairness, no daemon, no cross-process notification.
- No global CLI-wide uncaught-exception prettifier; only the named throw sites are converted.
- Holder identification in user-facing messages beyond the lock path (pid/host prose) — deferred; the path lets an operator inspect the record themselves.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Steal same-host provably-dead holders immediately, before any wait | Incident evidence shows the real-world failure is a dead holder inside the 10-min window — a state today's code cannot exit for up to 10 minutes. The 4-field `pid:token:start-identity:host` record exists precisely to make this decidable; the code comment "age alone never proves abandonment" stays true — we add *death* as proof, not age. |
| 2 | Wait briefly (default ~15s, `GENIE_LIFECYCLE_LEASE_WAIT_MS`) for live holders instead of failing fast | The realistic live holder is an agent-sync convergence run finishing in seconds; user expectation is "update just works". Precedent: `acquireRetirementLock` (25ms poll, env override, nothing mutated on timeout, `0` = single attempt). |
| 3 | On timeout, exit 2 with a projected message mirroring the codex-busy path — but with its own wording, never a Codex trailer | The two busy variants of one acquisition should present alike; exit 2 is already update's documented busy status. Install/uninstall must NOT reuse their Codex-busy projections verbatim: those emit `"code":"codex-lifecycle-busy"` machine trailers that `install.sh:837-849` classifies and tests pin — a false trailer for an agent-sync holder is a new lie. |
| 4 | Keep the wait in the command layer (wrapper over `acquireLifecycleLease`), not inside it | Other consumers need fail-fast: `runtime-integrations.ts:2166-2169` treats skip as a soft integration detail; `install-promote.ts:157-162` asserts an exact borrow. Commands opt in. The wrapper wraps whatever acquirer is in play — including the injected DI seam — so tests can drive mid-wait release. |
| 5 | Fix the wording in `heldLockSkip()` at the source, not per-command | Verified: agent-sync's report literal at `:6959` is a separate string, and no test asserts the parenthetical (all assert `toContain('holds the lock')`). One edit fixes update/install/uninstall **and** setup with zero test churn — strictly less machinery than per-command rewrites. |

## Simplicity Case

- **Simplest complete design:** (a) reorder/extend `acquireFileLock`'s gates so a same-host, identity-proven-dead holder is stolen without waiting for staleness; (b) a small `acquireLifecycleLeaseWithWait(acquirer, deadlineMs)` poll loop retrying only `cause: 'held' | 'contended'`; (c) replace four `throw new Error(...)` sites with each command's exit-2 projection carrying the (now accurate) source message.
- **Added machinery:** one env override (`GENIE_LIFECYCLE_LEASE_WAIT_MS`) — needed so tests run the timeout path in milliseconds and scripts can opt out (`0`); one `cause` discriminant on the existing skip result — needed so the wait loop cannot spin on borrow-mismatch (AC) or mislabel IO errors as "busy".
- **Deferred until measured:** pid/host prose in the busy message (lock path only for now); any liveness probing for unknown-host or legacy 3-field records (they keep stale-window behavior).
- **Complexity removed:** no daemon, no queueing, no lock-format change; a dumb 25ms sleep-poll matches the in-repo pattern and seconds-scale hold times.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [x] Reproduction of the incident state (lock record whose host matches this host, `lockOwnerIsLive(owner) === false` — e.g. dead pid — and mtime < 10 min old): `genie update` steals the lock and proceeds normally. _(Evidenced at the lock layer by the fresh-dead steal tests + command harness; final gate confirmed updateCommand's default acquirer flows through `acquireFileLock`.)_
- [x] With the lease held by a **live** process past the wait deadline: `genie update` exits code 2 with a single human-readable line naming the lock path — no stack trace, no minified frames, no "the holder converges the same targets". _(Pinned by new update busy-path tests.)_
- [x] With the lease held and released within the wait window: `genie update` proceeds without any busy message. _(Pinned by the mid-wait-release test, which asserts progress past the busy branch.)_
- [x] `genie update --sync-only` (and the other `acquireRequiredLifecycleLease` modes) present the same graceful busy behavior — no raw throw. _(Pinned by the spawned isolated-GENIE_HOME subprocess test.)_
- [x] Direct `genie install` and `genie uninstall` busy paths behave the same way, and **neither emits a `codex-lifecycle-busy` or action-required machine trailer for an agent-sync holder** (`tests/integration/install-exit2-propagation.test.ts` semantics preserved — 10/10 unmodified). _(Pinned by new install/uninstall busy tests with the load-bearing `schemaVersion` negative assertion.)_
- [x] `GENIE_LIFECYCLE_LEASE_WAIT_MS=0` restores single-attempt fail-fast; a borrow-mismatch fails immediately at any wait setting. _(Pinned by wait-loop unit tests.)_
- [x] Agent-sync's own lock-held skip report is unchanged (`bun test src/lib/agent-sync.test.ts` passes with report-wording tests untouched — zero existing tests modified across the PR).
- [x] `bun run check` passes. _(All non-test gates pass locally; the 14 local bun-test failures reproduce byte-identically at pristine HEAD (env-conditioned). PR CI fully green: Unit, Quality Gate, E2E v5 lifecycle, Codex plugin smoke, all 4 platform builds.)_

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 4 — stateful lock/steal semantics (+2), no deterministic test for steal reorder until Group 2 (+1), multi-command surface sharing one helper (+1) | `engineer-complex` / high | Dead-holder steal, structured skip cause, bounded-wait helper, four graceful projections, uninstall DI seam, source wording fix |
| 2 | engineer | 3 — concurrency test choreography (+2), spawned/hand-written foreign-pid lock fixtures for steal tests (+1) | `engineer-standard` / high | Busy-path and steal-path regression tests for update/install/uninstall |

Group 2 depends on Group 1; one worker running the wave sequentially is acceptable at this appetite.

## Execution Groups

### Group 1: Dead-holder steal, bounded wait, graceful projections

**Goal:** Lifecycle commands recover from dead holders instantly, wait briefly for live ones, and on genuine timeout present one clean exit-2 line instead of throwing.

**Deliverables:**
1. Early steal, two coordinated edits in `src/lib/agent-sync.ts`: (a) in `acquireFileLock` (`:5914`), before the staleness gate at `:5921`, when the parsed record satisfies *host matches `currentSyncLockHostId()` AND `lockOwnerIsLive(owner) === false`*, attempt the steal; (b) extend `stealStaleFileLock` with a death-proven mode — its guarded re-verification at `:6250` currently re-checks **mtime staleness** and would return `'contended'` for a fresh dead lock, so in this mode the re-check under the guard becomes *same-host + still-dead + record-unchanged* instead (the `lockHasLiveOwner` re-check at `:6251` stays). Never drop re-verification-under-guard entirely — it closes the double-writer hole (`:6200-6233`). Unknown host / unparsable records / live-or-unprovable holders keep current behavior.
2. Structured skip cause on `acquireLifecycleLease` results — **optional** field (`cause?: 'borrow-mismatch' | 'held' | 'io' | 'contended'`) so existing fixtures constructing bare `{ skipped: '…' }` (e.g. `setup.test.ts:679`) still typecheck — threaded from `acquireFileLock`'s distinct return points (`:5921/:5924/:5925` held; `:5952/:5973` io; `:5928` contended; `:6150` borrow-mismatch).
3. `acquireLifecycleLeaseWithWait(acquirer, deadlineMs)` — 25ms poll retrying only `held`/`contended` (missing `cause` = no retry); deadline from `GENIE_LIFECYCLE_LEASE_WAIT_MS` (default ~15000, `0` = one attempt). It wraps the acquirer **passed into** `acquireOrderedLifecycleLeases` at each command call site (`update.ts:2467`, `install.ts:399`, `uninstall.ts:3477`, plus the direct use at `update.ts:1661`), DI-injected acquirers included; `src/lib/ordered-lifecycle-leases.ts` and its strict busy-shape tests stay untouched.
4. `heldLockSkip()` (`:5976`) rewritten to an accurate message that names the lock path and **keeps the exact substring "holds the lock"** (e.g. "another Genie process holds the lock at <path>; retry shortly, or remove the file if its owner has crashed") — `setup.test.ts:1152` asserts that substring on spawned-child stderr via setup's `withSetupLease` exit-1 path (`setup.ts:1137-1139`), which inherits this string; keeping it preserves Decision 5's zero-test-churn claim.
5. Graceful projections at all four sites: `update.ts:2473` → `DeferredUpdateTerminal(2, …)`; `update.ts:1665` → same deferred-terminal convention for explicit modes; `install.ts:402` and `uninstall.ts:3483` → exit-2 stderr projection **without** reusing `CodexLifecycleBusyError` messages or `CODEX_LIFECYCLE_BUSY_TRAILER`/`codexLifecycleBusyTrailer` output.
6. `UninstallDeps.acquireLease` seam (mirroring `install.ts:384`) used by `acquireUninstallLifecycleLeasesOrProject`.
7. Update the "ONE protocol, two acquirers" doc comment (`agent-sync.ts:6211-6229`) to record the deliberate one-sided divergence: TS steals fresh same-host dead locks; install.sh's `recover_stale_lifecycle_lock` (`install.sh:245-274`) remains staleness-gated. Note that `acquireRetirementLock` (`:3018`) inherits the early steal via `acquireFileLock` (benign — cross-host retirement refusal unchanged).

**Acceptance Criteria:**
- [ ] No `throw new Error(\`Another Genie lifecycle command is active…\`)` remains anywhere in `src/genie-commands/`.
- [ ] Busy messages contain the lock path and no "(the holder converges the same targets)"; no stack trace reaches the terminal.
- [ ] No `codex-lifecycle-busy` or `INSTALL_ACTION_REQUIRED` trailer is emitted for an agent-sync holder.
- [ ] Borrow-mismatch (`LIFECYCLE_LEASE_PATH_ENV` set but stale/mismatched) fails without a single retry sleep.
- [ ] Same-host dead-holder steal detects pid-reuse via start-identity (a reused pid is judged dead and stolen) and never steals cross-host or unknown-host records.
- [ ] `setup`'s busy message no longer contains the false phrase (inherited from the source fix; `setup.test.ts:1152`'s `toContain('holds the lock')` still passes).

**Validation:**
```bash
bun run typecheck && bun test src/lib/agent-sync.test.ts src/genie-commands/__tests__/update.test.ts src/genie-commands/setup.test.ts src/genie-commands/install.test.ts src/genie-commands/uninstall.test.ts
```

**depends-on:** none

---

### Group 2: Busy-path and steal-path regression tests

**Goal:** Each command's lease-busy behavior and the dead-holder steal are pinned by tests that fail on reintroduction of the raw throw, the misleading message, or the 10-minute dead-holder hang.

**Deliverables:**
1. Steal tests: hand-written lock records with this host's id and mtime fresh — dead pid (identity irrelevant, incl. the `unknown` shell form as in the `sameHostRecord` fixture, `agent-sync.test.ts:2895`) → stolen; live pid + mismatched start-identity (pid reuse) → stolen; live matching holder, cross-host, and unparsable-record variants → not stolen. Plus one race test for deliverable 1b's record-unchanged re-verification: an observed dead record replaced by a fresh live record between observation and the guarded steal → stealer fails closed (template: the sibling-lock property at `agent-sync.test.ts:3317`).
2. Update tests: live holder past deadline → `process.exitCode = 2`, stderr asserted (lock path present, no "converges the same targets", no stack frames); holder releases mid-wait → command proceeds; `--sync-only` busy → same projection.
3. Install and uninstall timeout-path equivalents via their DI seams, asserting no Codex trailer is emitted.
4. All waits driven by `GENIE_LIFECYCLE_LEASE_WAIT_MS` at millisecond scale — no test slower than ~1s.

**Acceptance Criteria:**
- [ ] Reverting any Group 1 projection or the steal reorder makes at least one new test fail.
- [ ] Existing agent-sync report-wording tests pass unmodified.
- [ ] `tests/integration/install-exit2-propagation.test.ts` passes unmodified.

**Validation:**
```bash
bun run check
```

**depends-on:** group-1

---

## QA Criteria

- [ ] Functional: with a second terminal holding the lease (paused `genie install`), `genie update` waits, then either completes (holder finished) or prints one clean line with the lock path and exits 2 — no Bun stack trace.
- [ ] Functional: kill -9 a lease-holding command, immediately run `genie update` → it steals the dead lock and updates (the 2026-08-02 incident scenario).
- [ ] Integration: uncontended `genie update` output and behavior unchanged (prompt before lease, delivery after).
- [ ] Regression: `--post-delivery-converge` child still borrows the parent lease correctly (one end-to-end dev-build update).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Dead-holder steal misfires under pid-namespace-shared or NFS `$HOME` | Medium | Steal only when the record's host hash equals `currentSyncLockHostId()` — the field was added exactly for this; unknown/legacy records keep stale-window behavior. |
| Start-identity false "dead" verdict for a live but unreadable process | Low | Reuse the existing `lockHasLiveOwner` probe semantics (already trusted for stale-window stealing); when liveness is unprovable, do not steal. |
| Waiting delays the borrowed-lease child handoff | Low | Borrow path returns before any file lock is touched (`agent-sync.ts:6141-6155`) and `cause: 'borrow-mismatch'` is never retried — pinned by Group 1 AC. |
| Install/uninstall projection conventions are Codex-flavored and machine-parsed | Medium | Decision 3 forbids reusing Codex trailers for agent-sync holders; integration test pins `install.sh` classification behavior. |
| Dead parent, live borrowed-lease child (final-gate residual): if the update parent is SIGKILLed mid-converge, the on-disk record names the dead parent and a third lifecycle command death-steals immediately, where staleness previously shielded ~10 min | Low | Window is seconds and requires killing exactly the parent; the agent mutation lock and Codex lifecycle lease record the child's own live pid and still refuse contention. Accepted at final gate (MINOR, doc-only). |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — 2026-08-02 (reviewer: genie:reviewer)

**Verdict: FIX-FIRST** (superseded by revision below)

- MAJOR-1: fourth raw-throw site missed — `update.ts:1665` `acquireRequiredLifecycleLease` serves `--rollback`/`--sync-only`/`--post-delivery-converge`; Group 1 AC contradicted the deliverable list.
- MAJOR-2: Decision 4's premise false — `heldLockSkip()` (`agent-sync.ts:5976`) does not feed agent-sync's report (separate literal at `:6959`) and no test pins the parenthetical; source-level wording fix is strictly simpler and covers setup.
- MAJOR-3: generic poll loop would spin on borrow-mismatch (violating its own AC) and mislabel IO errors as busy; discrimination mechanism and DI-seam wrapping unspecified.
- MAJOR-4: likeliest field scenario (dead holder inside the 10-min stale window) unfixed by waiting; message "try again in a moment" wrong by up to 10 minutes; no incident holder evidence recorded.
- MAJOR-5: reusing install/uninstall's "existing convention" would emit a false `codex-lifecycle-busy` machine trailer parsed by `install.sh:837-849`.
- MINOR-1: setup still parrots the false phrase (`setup.ts:156`); MINOR-2: uninstall lacks an agent-sync lease DI seam, making its busy test harder than rated.

**Disposition:** all findings incorporated in the 2026-08-02 revision — fourth site added to scope; Decisions 1/3/5 rewritten; structured `cause` + DI-seam wrapping specified; dead-holder early steal added (incident evidence confirmed: lock `~/.genie-lifecycle-40f4cac7c62506dd.lock`, pid 1683714 dead, mtime 19:48:21, lock still present at 19:59); Codex-trailer prohibition made an AC; uninstall seam added to Group 1; Group 2 re-rated to complexity 3.

### Plan re-review — 2026-08-02 (reviewer: genie:reviewer, round 2)

**Verdict: FIX-FIRST (narrow)** — all six round-1 findings verified resolved against the code; the newly added steal scope judged sound in principle (gating maps onto `lockOwnerIsLive` at `agent-sync.ts:6041-6055`; positive host-match protects the create→write window where an unwritten lock parses to `null`), with one MAJOR spec defect and seven clarifications:

- MAJOR-A: "steal via the existing guarded steal path regardless of mtime" cannot work — `stealStaleFileLock` re-verifies **mtime staleness** under its guard (`:6250`) and would return `'contended'` for a fresh dead lock; a death-proven mode replacing that re-check with same-host + still-dead + record-unchanged is required, keeping re-verification-under-guard (double-writer hole, `:6200-6233`).
- MINOR-B: steal rule stated three inconsistent ways; unified to *host matches AND `lockOwnerIsLive(owner) === false`* (dead pid short-circuits before identity; identity only matters for live pids).
- MINOR-C: proposed wording dropped the substring "holds the lock" asserted at `setup.test.ts:1152`; wording now keeps it.
- MINOR-D: `withSetupLease` (`setup.ts:1137-1139`, exit-1 path) named as the consumer of the reworded string.
- MINOR-E: blast radius stated — `acquireRetirementLock` inherits the early steal (benign); agent-sync's own `acquireAgentMutationLock` keeps its blind spot deliberately.
- MINOR-F: "ONE protocol, two acquirers" doc contract (`agent-sync.ts:6211-6229`) must record the one-sided TS/shell divergence — added as Group 1 deliverable 7.
- MINOR-G: Group 1 validation extended with `install.test.ts` + `uninstall.test.ts`.
- MINOR-H: wait wrapper attachment point specified (wraps the acquirer passed into `acquireOrderedLifecycleLeases`; `ordered-lifecycle-leases.ts` untouched); `cause` made optional for fixture compatibility.

**Disposition:** all nine items incorporated in this document (same day). Round-3 verification below.

### Plan re-review — 2026-08-02 (reviewer: genie:reviewer, round 3)

**Verdict: SHIP**

- MAJOR-A verified resolved: both coordinated edits correctly specified — the pre-staleness-gate insertion point (`agent-sync.ts:5921`) and the death-proven mode replacing the `:6250` mtime re-check with same-host + still-dead + record-unchanged (which mirrors the shell's own `current == observed` re-read at `install.sh:267-269`), keeping `:6251` and re-verification-under-guard.
- MINOR-B verified: all five steal-test variants trace correctly through `lockOwnerIsLive` (`:6041-6055`), including the unparsable-record case where the positive host-match gate is what prevents stealing.
- MINOR-C through MINOR-H verified resolved against the cited files and line spans.
- Two non-blocking execution notes returned and incorporated same-day: (1) Group 2 now includes a race test for the record-unchanged re-verification (template: `agent-sync.test.ts:3317`); (2) the pid-reuse AC wording flipped to the authoritative direction (reused pid ⇒ judged dead ⇒ stolen).

**Orchestrator action:** status set DRAFT → APPROVED per SHIP verdict.

### Execution review — Group 1 — 2026-08-02 (reviewer: genie:reviewer, independent of engineer)

**Verdict: SHIP** (acceptance + quality/security pass on the uncommitted diff)

- All seven deliverables verified with file:line evidence. Death-proven steal adversarially probed and sound: record replaced by a new live owner is blocked by byte-identical record re-verification (128-bit random token per acquisition) plus the retained `lockHasLiveOwner` re-check; the create→write empty-file window parses to null and is never entered; pid-reuse steals correctly; EPERM/unprovable liveness does not steal. Guard-file, symlink refusal, and double-writer protections intact.
- Engineer's baseline claims independently reproduced in an isolated HEAD worktree: identical 655 pass / 4 fail (same four pre-existing names); no test files modified; `ordered-lifecycle-leases.ts` untouched. Broader at-risk set (install-exit2-propagation 10/10, codex-lifecycle-race 12/12, +8 suites: 370 pass / 3 fail, all 3 reproduce at HEAD). Lint and complexity budget clean.
- Security: no new weaponization surface — steal authority narrowed by positive host match; forging requires lock-file write access, which already implies `rm`-equivalent power. Wait loop safe under signals (no SIGINT handler → OS default kill); borrowed-lease child never enters the loop.
- Divergence doc comment verified against install.sh:245-273 — shell remains staleness-gated with the `current == observed` re-read; both acquirers serialize on the same `.steal` guard path.
- MINOR (fixed same-day via engineer follow-up): `acquireRequiredLifecycleLease` wrapped the wait inside the default parameter, so a DI-injected acquirer bypassed the retry policy; aligned to wrap outside the seam like the other three sites.
- MINOR (informational, accepted): `GENIE_LIFECYCLE_LEASE_WAIT_MS=''` parses as `0` — exact parity with the `GENIE_RETIREMENT_LOCK_WAIT_MS` precedent.

### Execution review — Group 2 — 2026-08-02 (reviewer: genie:reviewer, independent of engineer)

**Verdict: SHIP** — no BLOCKER/MAJOR/MINOR findings.

- 15 new tests across four files (+609/-1 lines, test additions only; implementation byte-identical to the Group 1 reviewed state apart from the requested seam alignment, which was verified correct).
- Race-test determinism verified from first principles: `processStartIdentity` reads `/proc/<pid>/stat` and never calls `process.kill`, so the monkey-patched kill probe inside `lockOwnerIsLive` is provably the only hook point, landing the record replacement exactly in the guarded window. The dead-replacement parameterization isolates `stealGroundsStillHold`'s byte-identity re-read (a liveness re-probe alone cannot refuse a dead replacement).
- Reviewer independently reproduced three of the engineer's five negative controls in a scratch worktree (early-steal disabled → 3 steal tests fail; record re-read dropped → race test fails; update raw throws restored → 2 update tests fail).
- Spawned `--sync-only` test's env isolation confirmed complete (replaced env, tmpdir HOME/GENIE_HOME, no borrow vars; lock path assertion proves the child used the isolated home). The `schemaVersion` negative assertion is load-bearing: every machine trailer flows through `serializeActivationResultTrailer`, which always emits it.
- Gates: typecheck clean; focused four-file run 626 pass / 4 fail with all four matching the HEAD baseline by name; lint 3 pre-existing warnings; complexity budget intact; knip clean (new exports consumed); `install-exit2-propagation` unmodified 10/10.

### Final gate — PR #2745 — 2026-08-02 (reviewer: genie:final-gate, aggregate risk after all ordinary reviews)

**Verdict: SHIP** — no BLOCKER/MAJOR; one MINOR (doc-only) and three INFO notes.

- Q1 cross-implementation protocol safety: TS death-steal and shell stale-steal cannot double-fire — shell locks are host-less 3-field records that `sameHostDeadOwnerRecord` refuses; both stealers serialize on the same `.steal` guard (TS O_EXCL, shell `ln`); byte-identical record re-verification refuses any replacement; Bun spawns (not forks) so the reentrant lease map never diverges from disk.
- Q2 non-interactive contexts: exactly four `acquireLifecycleLeaseWithWait` call sites (grep-verified); setup/hooks/MCP/runtime-integrations/install-promote keep fail-fast; both programmatic invocation paths (install.sh, converge child) ride the borrow short-circuit which returns before any file lock; no retained hook dispatches these commands.
- Q3 old/new binary concurrency during self-update: death proof requires a dead pid, so a live old-binary holder is never stolen in either direction; `processStartIdentity` format untouched and stable since 2026-07-14, so no false pid-reuse verdicts across coexisting versions (≥ 5.260711.6).
- Q4 success criteria: all eight evidenced (criteria ticked above); reviewer independently re-ran agent-sync tests on branch vs detached `dev` worktree — same 4 pre-existing failure names, all 10 new agent-sync tests green; PR CI fully green closes criterion 8.
- Q5 scope: PR diff is exactly the 10 expected files; roadmap.json delta is only the two wish task cards; no strays.
- MINOR-1 (accepted, doc-only): dead-parent/live-borrowed-child residual window — recorded in the Assumptions/Risks table above.
- INFO-2 (recorded): a converge-child lease refusal exits 2, which the parent maps to 'action-required' without install.sh's trailer disambiguation — unreachable in practice since both steal grounds now require a dead pid and the parent is alive by definition.

**Orchestrator validation (Group 2 gate = repo full `bun run check`):** all non-test steps pass (typecheck, biome, knip, skills/wishes lint, complexity budget, council-workflow, hook-bundles, hook-content, plugin-executables). Full `bun test`: 2977 pass / 14 fail; the orchestrator independently re-ran the seven failing files in a pristine detached worktree at HEAD `e0d37b8f1` — the 14 failure names reproduce **byte-for-byte identically**, all pre-existing env-conditioned failures on this host. Zero regressions from this wish. Both tasks (`t_mscebl889535b59e`, `t_mscebla86e45ab77`) marked done.

---

## Files to Create/Modify

```
src/lib/agent-sync.ts                                — dead-holder steal in acquireFileLock, cause discriminant,
                                                       acquireLifecycleLeaseWithWait, heldLockSkip rewording
src/genie-commands/update.ts                         — busy projections at :2473 and :1665, waiting acquirer
src/genie-commands/install.ts                        — busy projection at :402, waiting acquirer
src/genie-commands/uninstall.ts                      — busy projection at :3483, acquireLease DI seam, waiting acquirer
src/lib/agent-sync.test.ts                           — steal + cause tests
src/genie-commands/__tests__/update.test.ts          — busy-path tests (incl. --sync-only)
src/genie-commands/install.test.ts                   — busy-path tests
src/genie-commands/uninstall.test.ts                 — busy-path tests
```
