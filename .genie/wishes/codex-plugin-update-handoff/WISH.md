# Wish: Codex plugin update handoff

| Field | Value |
|-------|-------|
| **Status** | IN_PROGRESS — A+B+C+D execution-SHIP on this branch (D: SHIP loop 0, 2026-07-22, tip `5f51f785` — Fork A ratified: setup is activation-only, UX change documented for Felipe's final-gate veto); Group E remains. Dev independently shipped the delivery-adjacent plugin-only layer (B1 `3b4faa3b`, B2 `6f423869`); NONE of the activation protocol is on dev. Merge gate holds: A–E must each independently SHIP before the PR merges to dev. Plan gate SHIP 2026-07-12 at fix loop 1/2 (reviewed digest `4c71ab68…`) |
| **Slug** | `codex-plugin-update-handoff` |
| **Date** | 2026-07-12 |
| **Author** | Felipe + Codex brainstorm session |
| **Appetite** | large |
| **Branch** | `wish/codex-plugin-update-handoff` |
| **Repos touched** | genie |
| **Design** | [DESIGN.md](../../brainstorms/codex-plugin-update-handoff/DESIGN.md) |

## Status Update: Handoff Criterion Classification — 2026-07-21

Execution proceeded on the wish branch while delivery-adjacent plugin-only work landed on origin/dev
(`3b4faa3b` "stage B1 plugin-only convergence, health proof, lifecycle wiring", `6f423869` "stage B2
doctor + uninstall plugin-only classifier semantics", and related).

**Shipped to origin/dev:** plugin-only convergence orchestrator, one shared health-proof per
snapshot, agent-sync scoping to Claude skills, install.sh verification hardening, and narrower
delivery guards: verify-before-mutate, refusal to mutate a same-version payload in place, no
automatic remove/reinstall. Dev's delivery path still executes cache-advancing `codex plugin add`
on a stale installed version with no permit machinery — by this wish's contract that remains an
unpermitted cache-advancing mutation; the core hazard is NOT closed on dev.

**Not shipped to dev:** the entire activation protocol. On the wish branch, Groups A and B are
complete and execution-SHIP-reviewed — A: SHIP after 2 fix loops (`84fab8bf`, `c490aabe`,
`9fd46bcb`, `f410ddea`; full check 1481 pass/0 fail); B: SHIP, all 7 ACs pass (`b46d3b03`,
`ac264911`; full gate 1514 pass/0 fail); branch tip `ac264911`. None of it is on dev. Groups C–E
(delivery/rollback API + evidence validator, doctor integrationSummary + refusal gates, release
readiness) are not started anywhere.

**Unblocking sequence:** execute Group C next on the wish branch — it must rewire the three legacy
cache-advancing call sites (update/install/setup) per the Group B handback, which forbids shipping
or merging A–B standalone before C lands. Then Groups D–E. Per the merge gate (A–E must each
independently SHIP before the PR merges to dev), the branch reaches dev only as a whole. The
post-release user-gated live dogfood ritual stays blocked until A–E reach dev.

## Summary

Prevent `genie update` from invalidating open or resumable Codex tasks that retain paths into the
currently active versioned plugin generation. Genie will separate signed delivery from explicit
cross-version activation, classify integration state without mutation, require an unforgeable
external real-TTY retirement assertion before activation, bind each process-local permit to the exact
observed request, and prove the new generation through physical parity plus a bounded H3 SessionStart
smoke. One exclusive, operation-ID-fenced Codex lifecycle lease serializes every mutating lifecycle
command — activation, delivery publication, rollback, and uninstall — so that under cross-process
concurrency exactly one process wins and every loser performs zero mutation.

Implementation must begin in a new isolated worktree based on refreshed `main` at or after
`5.260712.1`; the current `wish/routing-delivery-fix` checkout is stale and contains unrelated work.

## Scope

### IN

- One bounded Codex activation observer, total pure classifier, deep consent API, unforgeable branded
  `RetirementAssertion`, fingerprint-bound opaque process-local activation permit, typed refresh
  journal, explicit-downgrade receipt, and stable human/JSON projection.
- Delivery-only behavior for update, install, already-current runs, post-delivery convergence,
  explicit downgrade, and compatible rollback; ordinary delivery never advances the Codex plugin
  cache.
- A permit-gated activation/recovery transaction reachable only through external interactive
  `genie setup --codex` or the explicitly accepted Codex step of full setup.
- Exact refusal behavior for Codex tasks, quick/noninteractive/CI/piped invocations, decline, and EOF;
  all refusals happen before activation-side mutation.
- Physical payload parity, enabled-state restoration, exact bounded H3 smoke, phase-aware crash
  recovery, downgrade receipt binding, and digest-bound rollback capability floor.
- A deep attestation/protocol store whose raw paths remain private and whose public surface is limited
  to delivery publication, callback-scoped delivery-root revalidation, activation start, and typed
  journal/receipt transitions; production activation rejects environment/CLI bundle-root overrides.
- Additive `doctor --json` integration state, deterministic human output and 0/1/2 exit semantics,
  installer-wrapper propagation, POSIX/Windows hook-command fixtures, four-platform release-readiness
  checks, operator docs, and user-gated N→N+1 candidate dogfood evidence before stable promotion.
- Legacy `--sync-only` as an explicit non-activation exception that branches before every plugin
  observer, classifier, authorization, query, or mutation call and reports only agent-sync failures.
- `genie init` as a read-only integration consumer that may reconcile project fallback only from a
  freshly observed `verified-current` state; pending, broken, or indeterminate states retain fallback
  and never mutate plugin/cache state.
- A deliberately narrow `genie uninstall` exception: the explicit user-requested command retains its
  existing user-data safeguards and separate destructive-removal authority, warns that current or
  resumable tasks can break, and is never an activation path or a callable subroutine of update,
  install, setup, doctor, or sync.
- One exclusive, operation-ID-fenced Codex lifecycle lease (see the ratified contract below)
  serializing activation, delivery publication, rollback, and uninstall, with dead-holder
  supersession, `codex-lifecycle-busy` loser semantics, and real two-process exactly-one-winner
  tests.
- An executed end-to-end installer integration test proving exit-2 delivered/action-required
  propagation, the machine-readable result trailer, lease cleanup, and idempotent rerun — not a
  syntax check.
- A structural schema plus validator for candidate dogfood evidence, a public per-command 0/1/2
  exit matrix with one stable machine-readable exit-2 result trailer carrying `deliveryComplete`,
  homolog as the canonical pre-stable candidate channel, and golden what/why/next message fixtures.
- A normative subprocess-fixture isolation contract for Groups B–E: isolated `HOME`, `GENIE_HOME`,
  `CODEX_HOME`, and temp roots before import/spawn, explicit `CODEX_THREAD_ID`/`CI` control, and
  rejection of any path escaping the fixture root.

### OUT

- Genie-owned retention, copies, aliases, symlinks, restoration, or garbage collection inside the
  Codex plugin cache; host generation leases remain an upstream Codex enhancement.
- Seamless resume of generation-N tasks after the operator explicitly activates N+1.
- Reading, copying, writing, or automatically approving Codex hook-trust state; activation still ends
  with `/hooks` review and a genuinely new task.
- H4/H6 policy changes, hook/skill/MCP content redesign, user-tier skill adoption, role-agent delivery,
  Claude/Hermes convergence, task scanning/killing, daemons, or worktree-policy changes.
- Native Windows binary installation; Windows scope is parity of shipped hook command, environment,
  refusal, observer, and activation semantics under the supported Codex/WSL boundary.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Delivery and activation are separate phases | The live failure came from delivery invoking a host command that pruned the generation retained by this task. |
| 2 | Every activation-capable or integration-reporting path shares one observer/classifier/gate | A total tagged state and opaque permit make bypasses and fail-open behavior mechanically testable. |
| 3 | Legacy sync-only branches before the activation subsystem | Felipe ratified this exception; SessionStart agent sync must never query or diagnose plugin state. |
| 4 | Only A's deep consent API can mint a branded retirement assertion | The API owns the real-TTY, environment, flag, and version-specific prompt guards; pure authorization consumes the unforgeable assertion and returns a process-local permit rather than persisted liveness truth. |
| 5 | Pending delivery exits 2 with `deliveryComplete:true` | Automation must distinguish delivered-but-action-required from both success and failure. |
| 6 | Genie never manages Codex cache generations or trust records | Those are host-owned boundaries; Genie verifies supported CLI outcomes and remains opaque to trust storage. |
| 7 | Rollback requires a digest-bound protocol-1+ capability | A fixed updater must never hand control to a pre-contract binary that can silently reactivate during rollback. |
| 8 | Execution starts from refreshed main in an isolated worktree | This checkout is `5.260711.6`, while installed behavior and the reviewed design target `5.260712.1+`; unrelated dirty routing changes must remain untouched. |
| 9 | Activation state is owned by one deep protocol store | Private paths plus callback-scoped revalidation prevent delivery, setup, or executor callers from retaining raw roots or hand-editing temporal state. |
| 10 | Init and uninstall are explicit non-activation contracts | Init gets only verified-current fallback reconciliation; uninstall keeps its separately requested destructive authority, warning, and user-data safeguards without becoming a permit source or shared repair helper. |
| 11 | One exclusive lifecycle lease serializes every mutating lifecycle command | The plan gate proved concurrent setup/update/install/rollback/uninstall could interleave journal, receipt, plugin, and payload mutation; a single fenced lease makes exactly-one-winner mechanically testable. |
| 12 | Installer exit-2 behavior is proven by an executed integration test | `bash -n` proves syntax, not behavior; the live incident class was behavioral, so the delivered/action-required path must actually run end-to-end in an isolated fixture. |
| 13 | Candidate evidence is schema-validated, never nonempty-checked | `test -s` accepts any garbage file; stable promotion must prove the exact ritual ran on the exact candidate with real identities, digests, exits, and doctor JSON. |
| 14 | Homolog is the canonical pre-stable candidate channel; every exit-2 path emits one stable machine-readable result trailer | Removes channel ambiguity for the user-gated ritual and gives automation a stable `deliveryComplete` carrier beyond `doctor --json`. |

## Lifecycle lease contract (ratified 2026-07-12)

User-ratified normative amendment closing plan-gate loop-2/2 HIGH gap 1. The eight contract clauses
below are binding verbatim; the mechanics that follow pin the remaining degrees of freedom the gate
diagnosed as `ambiguous-spec` (ownership, acquisition timing, transaction extent, loser semantics) so
no two conforming implementations can diverge.

### Ratified contract

- One exclusive Codex lifecycle lease covers activation, delivery publication, rollback, and
  uninstall.
- Setup acquires it after consent but before fresh re-observation or journal writes.
- Update/install acquire it after download verification but before the first swap/publication.
- Rollback/uninstall acquire it after confirmation but before mutation.
- Hold it through terminal journal, receipt, plugin, and payload state, with operation-ID fencing.
- A loser performs zero mutation and exits 2 with code `codex-lifecycle-busy`,
  `deliveryComplete:false`, and a retry action.
- Read-only doctor/init/observation never acquire it.
- Real two-process tests must prove exactly one winner.

### Binding mechanics

- **Ownership.** Group A's deep attestation/protocol store owns the lease. Its raw path is private
  like every other protocol file; the public surface is `acquireLifecycleLease(kind)`, which returns
  either a held lease bound to a fresh 128-bit operation ID or a typed `codex-lifecycle-busy`
  refusal naming the holder's kind. No other module may create, read, rename, or delete the lease
  file.
- **Acquisition.** A single atomic exclusive create (`O_EXCL`-equivalent) of a regular-file lease
  record `{schemaVersion:1, operationId, kind, pid, startedAt}` where `operationId` is 128
  OS-CSPRNG bits as exactly 32 lowercase hex characters. A symlinked, non-regular, oversized
  (>16 KiB), or schema-invalid lease file fails closed as busy — it never grants acquisition and is
  never silently deleted.
- **Stale-holder rule.** If the lease exists and its recorded pid is provably dead on this host
  (`kill(pid, 0)` → `ESRCH`), the acquirer supersedes it by an atomic same-directory rename to a
  non-overwriting `.stale-<operationId>` name (the acquirer's fresh operation ID) plus parent
  fsync, then retries the atomic create exactly once. A live or indeterminate holder is always
  busy — no TTL, no force flag, and no consent path can override a live holder. PID reuse can only
  make a dead holder look live, which fails safe (stays busy, never wrongly supersedes). The lease
  itself never grants recovery authority; that still comes only from the intent-phase table.
- **Boundary.** The lease contract assumes one host, one PID namespace, and one `GENIE_HOME`.
  Concurrent lifecycle commands reaching a shared `GENIE_HOME` across PID namespaces, containers,
  or hosts are outside the contract — that is a decision, not an assumption, and docs state it.
- **Operation-ID fencing.** Every journal, receipt, tombstone, delivery-record, and lease-release
  transition in A's store carries the acquiring operation ID and is rejected with a typed fencing
  error when it does not match the currently held lease, so a superseded operation's late writes
  cannot land.
- **Extent and release.** The holder keeps the lease through its terminal journal, receipt, plugin,
  and payload state — on success, typed refusal, and handled failure alike — then releases it by
  atomic delete plus parent fsync. A crash while holding leaves a dead-pid lease for the next
  acquirer's stale-holder rule.
- **Acquisition points (normative).** Setup: after the retirement assertion is minted but before
  `beginActivation`'s fresh re-observation and first journal write. Update/install: after signed
  download verification but before the first binary swap or `publishDelivery`. Rollback: after
  capability/sidecar confirmation but before any exchange. Uninstall: after destructive
  confirmation but before the first removal. The internal `--post-delivery-converge` child never
  acquires; its parent holds.
- **Loser semantics.** A loser in any of the five commands performs zero mutation of binary,
  journal, receipt, tombstone, plugin, cache, config, fallback, lease, or trust state and exits 2
  with machine-readable code `codex-lifecycle-busy`, `deliveryComplete:false`, and a retry action
  naming the holder kind.
- **Read-only exclusion.** Doctor, init, `--sync-only`, `--post-delivery-converge` classification,
  and every observer path never acquire, probe, or block on the lease; spies prove zero lease calls.
- **Proof.** Real spawned-two-process contention tests in isolated fixtures must prove exactly one
  winner for at least: setup+setup, setup+update, update+install, update+rollback, and
  uninstall+setup — winner completes, loser exits 2 `codex-lifecycle-busy` with zero mutation.

## Dependencies

**depends-on:** none
**blocks:** none

`routing-delivery-fix` is not a semantic dependency, but it overlaps update/doctor integration surfaces.
The semantic merge order is deterministic: if its approved branch lands before this wish begins,
this wish rebases on that merge; otherwise this wish's two-phase activation contract lands first and
`routing-delivery-fix` rebases on it. In either order, role-agent delivery cannot weaken the sync-only
exception, permit boundary, or delivery/activation split. Its dirty branch remains isolated; neither
branch is copied wholesale into the other.

## Success Criteria

- [ ] A pure exhaustive truth-table suite covers current, upgrade/downgrade pending, installed-newer,
      absent/query-failed, invalid versions, cache faults, payload mismatch, every valid intent phase,
      invalid/mismatched intent, target-current dominance, and a fail-closed fallback.
- [ ] Pure eligibility/authorization accepts only an unforgeable branded `RetirementAssertion` minted
      by A's deep consent API after all real-TTY/env/flag guards and the version-specific prompt; no
      activation mutator is callable without the resulting process-local opaque permit.
- [ ] Every permit is bound to an opaque activation-request fingerprint covering observed N/T,
      canonical and installed-delivery digests, delivery ID, registration/cache identities, enabled
      state, intent phase/ID, and receipt ID. `beginActivation(permit)` freshly re-observes and
      exact-matches that fingerprint immediately before the first journal write; stale consent causes
      deterministic refusal with zero mutation.
- [ ] Normal update, already-current update, post-delivery convergence, and install preserve registered
      N when canonical T differs, report delivery separately from activation, and exit 2 without a
      cache-advancing Codex command.
- [ ] A task pinned to N resumes/compacts and runs its N SessionStart resources after ordinary N+1
      delivery because activation was deferred.
- [ ] `CODEX_THREAD_ID`, any quick form, `--no-interactive`, CI, non-TTY/piped I/O, decline, and EOF
      produce zero activation-side mutation and deterministic action-required output.
- [ ] Authorized activation preserves enabled/disabled state, verifies full physical parity, passes the
      exact 5-second/64-KiB sanitized-environment H3 fixture, and prints `/hooks` plus new-task actions.
- [ ] Activation can use canonical bytes only inside
      `withRevalidatedDeliveryRoot(callback)` after a fresh delivery-record/version/inventory/root-
      identity check; the deep store never returns or exposes a reusable raw root, and production
      rejects `GENIE_BUNDLE_ROOT` and explicit bundle-root overrides before mutation.
- [ ] Failure injection at every journal phase yields deterministic recovery and idempotent gated retry;
      post-command failures never claim generation N survives.
- [ ] Bad or stale intents grant only quarantine authority; `intent-target-current` finalization requires
      fresh consent and reverification but no add/remove command.
- [ ] Explicit downgrade activation requires the exact digest/channel/from/target/128-bit delivery
      transaction ID, binds it into the intent, durably records its one-time consumption, and fails
      closed on corruption or single-file replay; installed-newer without it fails closed.
- [ ] C only publishes attested delivery and downgrade-receipt facts through A. B consumes the receipt
      and performs every activation-time journal/receipt transition through A before any plugin
      command; source tests prove callers cannot reach private paths or write protocol files directly.
- [ ] First-fixed→pre-contract rollback is refused before mutation; fixed→fixed rollback verifies binary
      hash, regular-file/no-symlink sidecar, bounded protocol probe, and readable intent schema.
- [ ] `doctor --json` remains additive over `{ok,checks}` and exposes stable `integrationSummary`,
      `deliveryComplete`, action-required state, authorization, versions, recovery action, and 0/1/2 exits.
- [ ] Trust spies prove zero hook-trust read/write/copy/approval calls, and no path alias allows
      N-reviewed commands to execute N+1 bytes.
- [ ] Sync-only spies prove zero observer/classifier/authorization/plugin-query/plugin-mutation calls;
      it exits nonzero only for a real agent-sync failure.
- [ ] `genie init` uses the shared observation facade: only `verified-current` may reconcile project
      fallback; pending, broken, and indeterminate fixtures retain fallback and make zero plugin/cache
      mutations.
- [ ] Explicit `genie uninstall` warns that current/resumable tasks may break, retains its existing
      user-data safeguards, never mints/accepts an assertion or permit, and source/CLI spies prove it is
      not callable from update, install, setup, doctor, or sync.
- [ ] POSIX and Windows hook command/environment fixtures satisfy the same activation/refusal contract;
      all four supported artifacts build and independently pass extraction, payload parity, H3, and
      version checks; the full repository gate is green.
- [ ] Before stable promotion, user-gated exact-commit homolog candidate evidence records N task →
      update exit 2 → N resume/compact → external setup → `/hooks` → genuinely new N+1 task,
      including exact commands, versions, outputs, physical identity/digest snapshots, and doctor JSON.
- [ ] Real two-process contention tests (spawned processes in isolated fixtures) prove exactly one
      winner for setup+setup, setup+update, update+install, update+rollback, and uninstall+setup;
      every loser performs zero lifecycle mutation and exits 2 with `codex-lifecycle-busy` and
      `deliveryComplete:false`; fencing rejects a superseded operation's late transitions; and spies
      prove doctor/init/sync-only/observer paths make zero lease calls.
- [ ] The release installer path is executed end-to-end in an isolated fixture: `install.sh`
      propagates exit 2 as delivered/action-required with the stable result trailer and no all-green
      footer, the lease is released afterward, and an immediate rerun is idempotent with identical
      exit and state.
- [ ] `scripts/validate-live-dogfood-evidence.ts` structurally validates candidate evidence — exact
      candidate commit/version/channel (homolog), N/T physical identities and digests before/after
      both query-inertness snapshots, per-step commands and exit codes for every ritual step,
      embedded parseable doctor JSON, `/hooks` and genuinely-new-task proof, and the explicit
      N non-guarantee — and rejects nonempty-but-invalid files with named missing/invalid fields;
      the post-release gate runs this validator, never a nonempty check.
- [ ] A public per-command 0/1/2 exit matrix (including `codex-lifecycle-busy`) is documented and
      fixture-tested; every exit-2 lifecycle path except `doctor --json` (whose single-object
      contract carries `deliveryComplete` in `integrationSummary`) emits the one A-owned ANSI-free
      single-line JSON result trailer carrying `schemaVersion`, machine code, `deliveryComplete`,
      and the retry/next action; golden what/why/next message fixtures cover it; and pending
      `doctor --json` exit 2 is documented as an intentional compatibility change.
- [ ] Every Group B–E subprocess fixture isolates `HOME`, `GENIE_HOME`, `CODEX_HOME`, and temp roots
      before import/spawn, explicitly sets or unsets `CODEX_THREAD_ID` and `CI`, and fails on any
      path that escapes the fixture root.

## Execution Strategy

### Mandatory execution preflight (before Wave 1)

`work` must fetch `origin/main`, verify the base package version is at least `5.260712.1`, create an
isolated worktree/branch `wish/codex-plugin-update-handoff`, and rerun the repository map there. It must
refuse to implement in the current `wish/routing-delivery-fix` worktree or copy its unrelated dirty
changes. If refreshed main changes any named anchor, preserve the reviewed behavior and update file
placement before coding.

### Subprocess-fixture isolation contract (normative for Groups B–E)

Every test that imports lifecycle modules with side effects or spawns a genie/installer/probe/H3
subprocess must, before import or spawn: point `HOME`, `GENIE_HOME`, `CODEX_HOME`, `TMPDIR` (and
Windows `TEMP`/`TMP`) at fresh directories under one per-test fixture root; explicitly set or unset
`CODEX_THREAD_ID` and `CI` for the scenario under test; and assert after the run that no created or
modified path escapes the fixture root. Two-process contention tests spawn real OS processes (not
in-process simulation) against the same fixture-root lease/state directory. Setup-side races must
satisfy the real-TTY consent guards with a real pseudo-terminal harness (for example a
`script`-allocated PTY) plus a stubbed `codex` CLI on the fixture `PATH` — never by weakening,
bypassing, or test-constructing the consent assertion.

### Wave 1 (protocol foundation)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| A | engineer-complex | 5 — orchestration boundary (+2), stateful protocol (+2), prior review rework (+1) | high | activation-protocol-core: bounded observation, branded consent/authorization, deep attestation store, journals/receipts, stable projections |

### Wave 2 (after A)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| B | engineer-complex | 5 — activation lifecycle (+2), stateful crash recovery (+2), prior rework (+1) | high | permit-gated-executor: owns only executor/runtime integration files; supported Codex mutations, callback-scoped delivery revalidation, parity/H3, recovery |

### Wave 3 (after B)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| C | engineer-complex | 6 — updater orchestration (+2), stateful delivery/rollback (+2), CI/release path (+1), prior rework (+1) | high | delivery-and-rollback: consumes B's stable facade and owns only update/install/capability/wrapper files; delivery publication, receipts, capability floor, exit propagation |

### Wave 4 (after C)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| D | engineer-complex | 5 — lifecycle UX boundary (+2), stateful recovery surface (+2), prior rework (+1) | high | lifecycle-surfaces: setup/doctor routing, verified-current init behavior, uninstall isolation, human/JSON output, trust opacity, platform fixtures |

### Wave 5 (deterministic release-readiness gate)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| E | engineer-complex + independent final-gate | 4 — release work (+1), four-platform artifact proof (+2), prior incident (+1) | highest justified | release-readiness: payload gates, docs, four-platform build/extraction/parity/H3 evidence, full validation |

Execution is strictly sequential: **A → B → C → D → E**. Agents share one workspace, so a later group
must not be claimed or edited until its predecessor has completed validation and handed off a stable
facade; disjoint-looking files do not make parallel edits safe. A owns `src/lib/codex-activation*`
except the executor pair, plus `src/lib/codex-lifecycle-lease*`. B owns `src/lib/codex-activation-executor*`,
`src/lib/runtime-integrations*`, and `src/lib/codex-project-mcp*`. C consumes B's stable facade and owns
`src/genie-commands/{update,install}*`, `src/lib/update-capabilities*`,
`src/lib/smart-install-hook.test.ts`, `install.sh`,
`tests/integration/install-from-gh-releases.sh`, and
`tests/integration/install-exit2-propagation.test.ts`. D owns setup/doctor/init/uninstall/CLI surfaces and E
consumes the complete lifecycle facade. No group edits its predecessor's owned files without an
explicit handback and revalidation. The task rows for A–E carry no dependency edges (the task CLI
cannot encode them), so all five show `ready` simultaneously; therefore ONLY the `/work`
orchestrator may run `genie task checkout`, and it claims groups strictly in A→B→C→D→E order,
claiming each group only after its predecessor's execution review returns SHIP. Workers never
self-claim from the board. After A–E independently SHIP, the PR may merge to dev. Live candidate QA
remains outside this DAG.

## Execution Groups

### Group A: activation-protocol-core

**Goal:** Define one deep, fail-closed activation protocol whose state and authorization decisions are
pure and total, while its consent and temporal-state APIs make authority and freshness unforgeable by
callers.

**Deliverables:**
1. Add focused activation modules (prefer `src/lib/codex-activation.ts` plus a small persistence helper
   if needed) defining snapshot facts, every tagged classifier state, invocation context,
   authorization/refusal, an unforgeable branded `RetirementAssertion`, opaque `ActivationPermit`,
   quarantine-only authority, activation-request fingerprints, journal/receipt schemas, and stable
   human/JSON projection types — including the exit-2 result-trailer type and its one canonical
   serializer (`schemaVersion`, machine code, `deliveryComplete`, retry/next action) that C and D
   consume without redefining. The refresh intent has its own 128-bit ID (null when absent from a
   snapshot), distinct from the downgrade receipt and delivery IDs.
2. Implement bounded physical observation by reusing refreshed-main plugin-root/parity primitives;
   distinguish query failure, absence, malformed versions, symlinks/non-regular files, unsafe roots,
   missing payload, and mismatched canonical digest without mutation.
3. Bound `codex plugin list --json` to 5 seconds and 64 KiB, require empty stderr and exactly one
   schema-valid JSON value, reject duplicate Genie registrations, and sanitize ANSI/OSC from modeled
   diagnostics. Snapshot N's stable physical identity and bounded inventory digest immediately before
   and after the query so plugin query and doctor tests prove observation is inert.
4. Implement one deep attestation/protocol store whose raw delivery, intent, receipt, and tombstone
   paths are private. Its public mutation/capability surface is limited to `publishDelivery`,
   `withRevalidatedDeliveryRoot(callback)`, `beginActivation`, and typed journal/receipt transitions.
   `withRevalidatedDeliveryRoot` freshly validates delivery ID, installed identity/version, physical
   root identity, and inventory digest and never returns or exposes a reusable raw root/path; the
   callback receives only callback-scoped operations. Production activation rejects
   `GENIE_BUNDLE_ROOT` and explicit root overrides.
5. Make that store's consent entry point own the real stdin/stdout TTY checks, empty
   `CODEX_THREAD_ID`/`CI` checks, every quick/no-interactive spelling, and the affirmative prompt that
   names observed N and T. Only this deep API can mint the private-brand `RetirementAssertion`; pure
   eligibility/authorization consumes that value, never performs I/O, and cannot accept a boolean,
   structural lookalike, persisted consent, or caller/test-constructed substitute.
6. Bind each `ActivationPermit` to an opaque activation-request fingerprint containing observed N/T,
   canonical payload digest, installed-delivery digest and delivery ID, registration and cache physical
   identities, enabled state, intent phase and intent ID, and receipt ID (with explicit nulls). In
   `beginActivation(permit)`, freshly re-observe and exact-match every field immediately before the
   first journal write; stale consent returns a typed refusal and performs zero mutation.
7. Implement backup-first, atomic, fsync-before-rename persistence for regular-file/no-symlink refresh
   intents, delivery records, receipt-consumption tombstones, and explicit-downgrade receipts behind
   the store. The receipt ID is the persisted 128-bit delivery transaction ID and the intent binds the
   same ID. Oversized intents are never hashed past 16 KiB: after fresh quarantine authority, rename
   them in the same directory to a non-overwriting `.invalid-oversized-<128-bit-nonce>` and fsync the
   parent.
8. Add table-driven tests for every design row, dominance rule, invalid schema/binding, authorization
   overlay, output projection, idempotency, bounded reads, and fail-closed fallback under isolated
   `GENIE_HOME`/`CODEX_HOME` fixtures. Type/source tests prove raw paths and brands are not exportable.
9. Implement the ratified lifecycle lease in `src/lib/codex-lifecycle-lease.ts` behind the deep
   store per the binding mechanics: private lease path, `acquireLifecycleLease(kind)` with atomic
   exclusive create of the `{schemaVersion:1, operationId, kind, pid, startedAt}` record, typed
   `codex-lifecycle-busy` refusal naming the holder kind, dead-pid stale-holder supersession via
   atomic non-overwriting rename plus one retry, fail-closed handling of symlinked/oversized/invalid
   lease files, atomic release with parent fsync, and operation-ID fencing wired into every journal,
   receipt, tombstone, delivery-record, and release transition of the store.

**Acceptance Criteria:**
- [ ] Classifier and authorization functions perform no I/O and every input returns one tagged result;
      authorization requires the deep consent API's branded assertion and returns a process-local,
      fingerprint-bound permit.
- [ ] Real TTY/env/flag/version-prompt cases can mint the brand only through the consent API; structural
      forgery, stale/persisted consent, generic confirmation, and direct test construction fail at the
      type/API boundary.
- [ ] Invalid or incomparable version/intent/receipt input cannot become current, pending-with-authority,
      or activation-permitted.
- [ ] `intent-target-current` dominates ordinary current-state classification but grants no mutation
      authority without fresh setup consent.
- [ ] Journal/receipt tests cover tamper, symlink, oversized file, partial write, crash-before-rename,
      single-file replay, mismatch, bounded oversized quarantine, consumption, and rerun behavior. The
      stated boundary covers corruption/replay of one Genie state file; same-user rollback of all Genie
      state plus the live binary is explicitly outside the security boundary.
- [ ] The protocol-store API keeps every raw state/root path private, revalidates inside the delivery
      callback, rejects escaped callback capabilities, and is the only writer of delivery, intent,
      receipt, and tombstone state.
- [ ] A permit becomes stale after a change to any fingerprint field; `beginActivation` detects the
      exact mismatch on its immediate re-observation and tests prove no journal, receipt/tombstone,
      plugin/cache, config, fallback, or trust mutation occurred.
- [ ] Query fixtures cover timeout, output cap, trailing/second JSON, exact schema, duplicate entries,
      stderr, ANSI/OSC diagnostics, and physical identity/digest replacement during observation.
- [ ] Lease tests cover atomic single-winner acquisition, busy refusal with holder kind, dead-pid
      supersession (rename evidence retained, exactly one retry), live/indeterminate holders staying
      busy, symlinked/oversized/invalid lease files failing closed without deletion, fenced
      transitions rejecting a superseded operation ID, and release-on-success/refusal/failure. A real
      spawned-two-process primitive race against one fixture-root store proves exactly one
      `acquireLifecycleLease` winner.

**Validation:**
```bash
bun test src/lib/codex-activation.test.ts src/lib/codex-lifecycle-lease.test.ts
bun run check
```

**depends-on:** none

---

### Group B: permit-gated-executor

**Goal:** Make the opaque permit the only route to Codex activation mutation and verify the installed
generation before reporting success.

**Deliverables:**
1. Add `src/lib/codex-activation-executor.ts` and its focused test, and refactor refreshed-main Codex
   marketplace/plugin/config/role-agent plus activation-time project-fallback mutators behind its
   narrow `ActivationPermit` boundary. B owns this executor, `src/lib/runtime-integrations*`, and
   `src/lib/codex-project-mcp*`, removes public/indirect activation bypasses, and exposes a stable
   observation/reporting facade for C and D while preserving non-activation agent sync.
2. Make the executor call A's `beginActivation(permit)` before any activation transition. That call
   performs the immediate fresh observation and exact fingerprint match; a stale permit returns the
   typed action-required refusal with zero journal/receipt/plugin/cache/config/fallback/trust mutation.
3. Execute supported Codex CLI add/remove operations through A's typed phase transitions, preserve the
   observed enabled flag, handle target-current finalization without add/remove, and implement
   deterministic recovery for planned, command-started, removal-observed, ambiguous, and verified
   phases. For an explicit downgrade, B durably consumes the exact receipt through A's tombstone
   transition before the first cache-advancing plugin command; completion and cleanup also go through A.
4. Use canonical bytes only inside A's `withRevalidatedDeliveryRoot(callback)`; never retain or return
   a raw root. Revalidate delivery-record binding, stable device/inode-or-platform identity, version,
   and inventory digest for the callback and reject post-attestation root replacement or any
   production bundle-root override.
5. Implement physical N+1 payload parity within that callback, including regular-file/no-symlink
   checks, canonical digest comparison, and path-alias rejection before success.
6. Implement the exact no-shell H3 SessionStart replay. Resolve and physically validate an absolute
   Node executable before creating the child environment; then construct a sterile environment from
   scratch with fresh HOME/temp directories and fixed locale (no inherited variables), verified
   physical T, identical process/JSON cwd, 5-second timeout, 64-KiB combined cap, exact schema/context,
   empty stderr, cleanup, and no network/trust/cache write.
7. Add failure injection at every phase plus spies proving no hook-trust reads/writes/copies/approvals,
   no activation mutation without a real permit, no direct protocol-file access, and no receipt
   consumption or activation-time transition outside A's store.
8. Enforce the lease extent for activation: `beginActivation(permit)` additionally requires a held
   lifecycle lease and passes its operation ID into every subsequent journal/receipt/tombstone
   transition; the executor holds the lease through terminal journal, receipt, plugin, and payload
   state and releases it on success, typed refusal, and handled failure alike. A busy lease is the
   typed `codex-lifecycle-busy` refusal with zero mutation. Add a real spawned-two-process executor
   race (isolated fixture root) proving exactly one activation transaction wins while the loser
   leaves journal, receipt, plugin, cache, config, fallback, and trust state untouched. All B
   subprocess fixtures follow the isolation contract.

**Acceptance Criteria:**
- [ ] Type/API tests make every activation mutator unreachable without the opaque permit.
- [ ] Every fingerprint-field race between consent and `beginActivation` refuses before the first
      journal write with zero mutation; a matching permit is usable only in its minting process and
      only for that exact request.
- [ ] Successful and target-current activation restore enabled state, prove parity/H3, clear the journal,
      and return a verified result; any post-command failure remains broken/retry.
- [ ] Downgrade receipt consumption is one-time and durably tombstoned by B through A before the first
      plugin command; C, D, and direct callers cannot consume receipts or advance journal phases.
- [ ] Each injected interruption has one documented recovery action and a second authorized run is
      idempotent.
- [ ] H3 timeout, cap, spawn, environment, fixture, schema, output, side-effect, POSIX command, and
      Windows command cases are deterministic; fixtures poison `GENIE_BUNDLE_ROOT`, `PATH`, `HOME`,
      every `TMP*`, and `ComSpec`, and cover Node/root replacement after validation.
- [ ] Activation is impossible without a held lease: a busy lease yields the typed
      `codex-lifecycle-busy` refusal with zero mutation, fenced transitions reject a superseded
      operation ID mid-transaction, the lease is provably released on every terminal path, and the
      real two-process executor race shows exactly one winner.

**Validation:**
```bash
bun test src/lib/codex-activation-executor.test.ts \
  src/lib/runtime-integrations.test.ts \
  src/lib/codex-project-mcp.test.ts src/hooks/__tests__/codex-manifest.test.ts
bun run check
```

**depends-on:** A

---

### Group C: delivery-and-rollback

**Goal:** Make every noninteractive delivery path preserve the active Codex generation and enforce a
protocol-safe rollback boundary.

**Deliverables:**
1. Consume B's stable observation/reporting facade in normal/already-current update, fresh-binary
   `--post-delivery-converge`, install modes, explicit channel downgrade, and installer wrappers;
   observe/classify/report without a permit or Codex cache-advancing command. Preserve non-plugin agent
   convergence and do not import A's private persistence implementation or B's executor internals.
2. Keep legacy `--sync-only` as an early branch before activation imports/calls; remove any plugin
   advisory/drift query and make a genuine agent-sync failure the only nonzero result.
3. Emit deterministic pending/current/broken/indeterminate human output and propagate exit 2 as
   delivered/action-required (`deliveryComplete:true`) through `install.sh` and fresh-binary parent/child
   boundaries without an all-green footer.
4. After attested explicit-channel delivery, publish the exact downgrade-receipt facts through A's
   `publishDelivery` using the pre-delivery snapshot and one 128-bit delivery transaction ID as the
   receipt ID. C never consumes/tombstones that receipt, writes an activation intent, begins activation,
   or runs a plugin command; B later owns those activation-time transitions through A.
5. Through the same `publishDelivery` API, publish authenticated installed-delivery facts binding
   delivery ID, attestation identity, installed binary identity/version, canonical/delivery digest,
   physical payload-root identity, and inventory digest. C receives only the publication result; raw
   record/receipt paths remain private and later activation can access payload bytes only inside A's
   revalidated callback.
6. Add a hidden bounded JSON capability probe and digest-bound backup sidecar at authenticated backup
   publication. Bind the sidecar to the authenticated delivery record, backup slot, expected previous
   version, delivery ID, binary hash, protocol, and readable intent schemas. Open the sidecar/binary
   no-follow, fstat regular files, cap reads, retain stable device/inode-or-platform identities, fsync
   the parent, and immediately revalidate both identities before atomic exchange.
7. Run the probe without a shell through the verified absolute backup binary in a sterile environment;
   require timeout <=5 seconds, <=64 KiB output, empty stderr, and exactly one schema-valid JSON object
   agreeing with the sidecar. Preserve live/backup/integration state on every pre-exchange refusal.
8. Test first-fixed→pre-contract refusal, fixed→fixed rollback, explicit downgrade, query/cache failure,
   post-delivery child failure, wrapper exit mapping, reruns, tamper, paired sidecar/binary swap, parent
   symlink, replacement between check/probe/exchange, and sync-only zero-call spies.
9. Enforce the ratified lease acquisition points for delivery paths: update/install acquire after
   signed download verification but before the first binary swap or `publishDelivery`; rollback
   acquires after capability/sidecar confirmation but before any exchange; the
   `--post-delivery-converge` child never acquires (the parent holds). Every C loser path performs
   zero mutation and exits 2 with `codex-lifecycle-busy`, `deliveryComplete:false`, the A-owned
   result trailer, and a retry action; the lease is released on all terminal paths. Add real
   spawned-two-process update+install and update+rollback races proving exactly one winner.
10. Add `tests/integration/install-exit2-propagation.test.ts`, which actually executes `install.sh`
    end-to-end inside an isolated fixture (fixture-root `HOME`/`GENIE_HOME`/`CODEX_HOME`/temp, a
    local release fixture — file-based tarball or stubbed fetch on `PATH` — and a genie binary whose
    post-install path yields the delivered/action-required state). It must assert: installer exit
    code 2; delivered/action-required output containing the stable result trailer with
    `deliveryComplete:true`; no all-green footer; lease absent after completion; and an immediate
    rerun that is idempotent with identical exit and state. `bash -n` remains only a fast
    pre-check, never the proof.

**Acceptance Criteria:**
- [ ] N→T update/install/already-current paths contain zero Codex activation commands and leave the N
      generation physically present-unverified while returning action-required exit 2.
- [ ] Sync-only makes zero activation observer/classifier/authorization/plugin query/mutation calls and
      exits 0 unless agent sync itself fails.
- [ ] Pending output always names N/T and `retire tasks → genie setup --codex → /hooks → new task`;
      JSON/human parent-child exit semantics agree.
- [ ] Source and spy tests prove C only publishes delivery/receipt facts: it never calls
      `beginActivation`, consumes/tombstones a receipt, advances a journal, retains a delivery root, or
      invokes a plugin/cache mutator.
- [ ] Rollback and downgrade tests prove receipts/sidecars cannot be forged, replayed, swapped, or
      bypassed by consent, quick mode, old binaries, malformed probes, or crash timing.
- [ ] Single-file receipt corruption/replay fails closed; same-user rollback of every Genie state file
      plus the live binary is documented as outside the security boundary.
- [ ] The executed installer integration test passes: real `install.sh` run in the isolated fixture
      propagates exit 2 with the result trailer and no all-green footer, releases the lease, and
      reruns idempotently.
- [ ] Two-process update+install and update+rollback races each produce exactly one winner; the loser
      exits 2 `codex-lifecycle-busy` with `deliveryComplete:false` and zero binary/journal/receipt/
      plugin/cache/config/fallback mutation.

**Validation:**
```bash
bun test src/genie-commands/__tests__/update.test.ts src/genie-commands/install.test.ts \
  src/lib/smart-install-hook.test.ts src/lib/update-capabilities.test.ts \
  tests/integration/install-exit2-propagation.test.ts
bash -n install.sh tests/integration/install-from-gh-releases.sh
bun run check
```

**depends-on:** B

---

### Group D: lifecycle-surfaces

**Goal:** Route setup, doctor, init, and the deliberate uninstall exception through truthful lifecycle
contracts without duplicating authority or exposing an activation bypass.

**Deliverables:**
1. Replace setup's direct Codex repair with B's stable observer/executor facade and call A's deep
   consent API for the dedicated assertion. Setup must not duplicate TTY/env/flag checks, render its own
   generic confirmation into authority, construct a `RetirementAssertion`, or retain a permit; the A
   API owns the prompt naming observed N and target T. Ordinary full-wizard consent is insufficient.
2. Ensure every guard failure, decline, EOF, invalid state, and fresh recovery refusal happens before
   marketplace/plugin/config/role-agent/project-fallback/intent/trust mutation; unrelated wizard work
   remains separately reported.
3. Run the activation observer once in doctor, reuse it for existing checks, and add
   `integrationSummary` without changing existing `{ok,checks}` meanings. Keep pending potentially
   `ok:true` while the command exits 2 and `integrationSummary.actionRequired === true`. In fixtures
   and candidate QA, capture N's stable physical identity plus bounded inventory digest before and
   after the plugin query/doctor run and reject any query-induced change.
4. Implement the reviewed stable schema and human stdout/stderr split for current, pending, broken,
   indeterminate, authorization-refused, delivery-incomplete, and recovery states.
5. Update `src/term-commands/init.ts` to use B's shared observation facade. It may reconcile project
   fallback only after the fresh result is exactly `verified-current`; pending, broken, and
   indeterminate states retain the fallback and make no plugin/cache mutation. Init never requests an
   assertion/permit or treats a prior/current-looking snapshot as fresh authority.
6. Preserve explicit `genie uninstall` as a deliberately separate, user-requested destructive-removal
   authority rather than expanding the activation protocol. It must warn before confirmation that
   current or resumable tasks can break, retain all existing ownership/user-data/backup/lock safeguards,
   never mint or accept an assertion/permit, and never be callable from update, install, setup, doctor,
   sync, post-delivery convergence, or init.
7. Add CLI/source/fixture tests for setup-only, full setup, every quick spelling, global
   `--no-interactive`, Codex task, CI, piped I/O, decline/EOF, trust opacity, doctor idempotency, and
   POSIX/Windows command/environment parity. Add init state-matrix spies and uninstall warning,
   safeguard-regression, and cross-command call-graph isolation tests.
8. Wire the ratified lease into the lifecycle surfaces: setup acquires after the retirement
   assertion is minted but before `beginActivation`'s re-observation/first journal write; uninstall
   acquires after destructive confirmation but before the first removal; doctor, init, and every
   observer path never acquire, probe, or block on the lease (spies prove zero lease calls). Add
   real spawned-two-process setup+setup, setup+update, and uninstall+setup races proving exactly one
   winner with loser `codex-lifecycle-busy` semantics.
9. Document the public per-command 0/1/2 exit matrix (including `codex-lifecycle-busy`) and wire
   A's canonical result-trailer serializer into the setup and uninstall surfaces: one ANSI-free
   single-line JSON object (`schemaVersion`, machine code, `deliveryComplete`, retry/next action)
   emitted on every exit-2 lifecycle path except `doctor --json`, whose exactly-one-object stdout
   contract is owned by the design and already carries `deliveryComplete` inside
   `integrationSummary`. The trailer type and serializer are defined once in Group A (Wave 1); C's
   commands and wrappers consume that serializer in Wave 3; D wires and documents it and never
   redefines it. Fixture-test golden what/why/next messages for pending, busy, refused, broken, and
   recovery states, and document pending `doctor --json` exit 2 as an intentional compatibility
   change.

**Acceptance Criteria:**
- [ ] Only an eligible external real-TTY setup assertion can mint a permit; all refusal variants have
      zero activation-side mutation and deterministic exit/action output.
- [ ] Setup reaches the unforgeable brand only through A's consent API; source tests prove no surface
      reimplements the guards/prompt or fabricates an assertion/permit.
- [ ] Full setup asks a separate version-specific retirement question and preserves completed unrelated
      sections when Codex activation is refused.
- [ ] `doctor --json` remains backward-compatible and exposes stable machine-readable classifier,
      versions, cache state, mutation authority, authorization, recovery, action, and delivery fields.
- [ ] Pending, broken, query-failed, invalid-intent, and target-current recovery are identical between
      human and JSON projections and across repeated runs.
- [ ] Init reconciles project fallback only for a fresh `verified-current` observation. Pending,
      broken, indeterminate, and observation-race cases retain fallback and show zero plugin/cache
      calls.
- [ ] Uninstall prints the task-breakage warning before destructive confirmation, preserves every
      existing user-data safeguard, has no assertion/permit/activation dependency, and cannot be
      reached from update/install/setup/doctor/sync/post-delivery/init source or CLI paths.
- [ ] Setup+setup, setup+update, and uninstall+setup two-process races each yield exactly one winner;
      losers exit 2 `codex-lifecycle-busy` with `deliveryComplete:false`, the retry action, and zero
      lifecycle mutation; doctor/init/observer lease spies stay at zero.
- [ ] The exit matrix and result trailer are implemented exactly as documented; golden message
      fixtures pass for pending, busy, refused, broken, and recovery states; human and JSON
      projections agree on the trailer fields.

**Validation:**
```bash
bun test src/genie-commands/setup.test.ts src/genie-commands/doctor.test.ts \
  src/term-commands/init.test.ts src/genie-commands/uninstall.test.ts src/genie.test.ts
bun run check
```

**depends-on:** C

---

### Group E: release-readiness

**Goal:** Prove deterministically that every supported release artifact carries the reviewed activation
contract before execution review and PR handoff.

**Deliverables:**
1. Extend hook manifest, bundle-parity, content-binding, fresh-install, release-doc, and payload-version
   gates so the exact H3 command, activation verifier, capability probe, and version binding are
   present and identical in every supported tarball/manifest surface.
2. Add `scripts/verify-codex-activation-payload.ts` plus tests. Given an extracted root, platform, and
   version, it verifies the complete inventory/version/manifest binding, physical plugin parity, exact
   platform H3 command, and bounded H3 fixture without trusting the checkout payload.
3. Document the two-phase operator flow, exit 2 meaning, automation handling, the per-command 0/1/2
   exit matrix and result trailer, the lifecycle lease and `codex-lifecycle-busy` retry semantics,
   rollback floor, sync-only and verified-current-init exceptions, the separately authorized
   uninstall warning and isolation, hook-trust opacity, `/hooks`, new-task requirement, homolog as
   the canonical pre-stable candidate channel, and the explicit limit that activated N tasks cannot
   resume without upstream host leases.
4. Add `scripts/validate-live-dogfood-evidence.ts` plus tests defining the structural candidate-
   evidence schema: `schemaVersion`, exact candidate commit (40-hex) and version (release grammar),
   `channel:'homolog'`, N/T physical identity and bounded inventory digest snapshots before/after
   both the `codex plugin list --json` and `genie doctor --json` inertness checks, an ordered step
   list with exact command, exit code, and captured output for every ritual step (N task,
   update exit 2 with `deliveryComplete:true`, N resume/compact, external setup activation, doctor
   JSON embedded as exactly one fenced ```json block per snapshot — that block is the validated
   payload — parseable with `integrationSummary.state === 'current'`, `/hooks` review,
   genuinely new N+1 task), and the explicit N non-guarantee statement. The validator exits nonzero
   naming every missing or invalid field; tests prove nonempty-but-invalid files are rejected.
5. Run focused suites, `bun run check`, build all four supported tarballs, extract and verify each
   independently, then obtain an independent execution final gate before PR handoff.

**Acceptance Criteria:**
- [ ] `linux-x64-glibc`, `linux-x64-musl`, `linux-arm64`, and `darwin-arm64` tarballs each contain a
      version-matched binary, manifests, plugin payload, H3 command, activation verifier, capability
      probe, and documentation; the extracted-root verifier fails on any cross-artifact drift.
- [ ] Each extracted artifact independently passes inventory/version binding, physical parity, exact
      platform H3-command selection, and the bounded H3 fixture.
- [ ] The full deterministic suite and an independent final gate return SHIP before PR/dev handoff.
- [ ] A–E completion requires no installed release or live user action.
- [ ] The evidence validator accepts a complete synthetic fixture, rejects nonempty-but-invalid
      fixtures (wrong commit format, missing step, bad exit, unparseable doctor JSON, missing
      non-guarantee) with named fields, and the post-release gate command invokes it.
- [ ] Operator docs carry the exit matrix, result trailer, lease busy/retry semantics, and homolog
      candidate channel exactly as implemented; the release-docs gate fails on drift.

**Validation:**
```bash
bun test src/hooks/__tests__/codex-manifest.test.ts scripts/hook-bundle-parity.test.ts \
  scripts/hook-content-binding.test.ts scripts/fresh-install-smoke.test.ts \
  scripts/release-docs.test.ts scripts/release-payload-version.test.ts \
  scripts/verify-codex-activation-payload.test.ts \
  scripts/validate-live-dogfood-evidence.test.ts
bun run check
VERSION="$(node -p "require('./package.json').version")"
for PLATFORM in linux-x64-glibc linux-x64-musl linux-arm64 darwin-arm64; do
  bash scripts/build-binary.sh --platform "$PLATFORM" --version "$VERSION"
  ROOT="$(mktemp -d)"
  tar -xzf "dist/genie-${VERSION}-${PLATFORM}.tar.gz" -C "$ROOT"
  bun run scripts/verify-codex-activation-payload.ts \
    --root "$ROOT" --platform "$PLATFORM" --version "$VERSION"
  rm -rf "$ROOT"
done
```

**depends-on:** D

---

## Post-release QA gate

This is an explicitly user-gated lifecycle check, not an execution group or task. It does not block
Groups A–E, execution review, PR creation, or merge to dev. The lifecycle is:

`A–E SHIP → PR/dev merge → exact-commit homolog candidate → Felipe live ritual → stable promotion → WISH SHIPPED`.

Homolog is the canonical pre-stable candidate channel for this ritual. Against that exact candidate,
record
`.genie/wishes/codex-plugin-update-handoff/qa/live-dogfood-<date>.md` with N's stable physical identity
and bounded inventory digest before and after both `codex plugin list --json` and `genie doctor --json`,
then run N task → update/delivery exit 2 → N resume/compact → external retirement assertion/setup →
doctor JSON → `/hooks` review → genuinely new N+1 task. Capture commands, candidate commit/version,
outputs, exits, query-inertness snapshots, and the explicit non-guarantee for N after activation. Any
failure blocks stable promotion and the WISH's SHIPPED transition, but does not retroactively block the
completed engineering groups.

**Evidence validation:** structural, never nonempty. The file must satisfy the schema owned by
`scripts/validate-live-dogfood-evidence.ts` (Group E): exact candidate commit/version/channel,
both pre/post identity-and-digest inertness snapshots, every ritual step with exact command and exit
code, embedded parseable doctor JSON, `/hooks` and new-task proof, and the N non-guarantee. A file
that merely exists and is nonempty does not pass.

```bash
EVIDENCE="$(ls -t .genie/wishes/codex-plugin-update-handoff/qa/live-dogfood-*.md | head -1)"
bun run scripts/validate-live-dogfood-evidence.ts --file "$EVIDENCE"
```

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: ordinary cross-version update delivers T, returns pending exit 2, and an already-open
      N task can resume/compact and execute its N SessionStart path.
- [ ] Authorization: every quick/task/CI/noninteractive/piped/declined path has zero activation-side
      mutation; eligible external setup activates only after the version-specific assertion.
- [ ] Recovery: injected crashes across delivery, activation, intent quarantine/target-current, explicit
      downgrade, and binary rollback converge or fail closed exactly as specified on rerun.
- [ ] Diagnostics: human output, `doctor --json`, and process exits agree while preserving the existing
      `{ok,checks}` contract and hook-trust opacity.
- [ ] Lifecycle isolation: init retains fallback unless a fresh observation is `verified-current`, and
      explicit uninstall warns about task breakage while preserving its existing user-data safeguards;
      neither surface provides an activation bypass.
- [ ] Concurrency: two simultaneous mutating lifecycle commands on the same host yield exactly one
      winner; the loser exits 2 `codex-lifecycle-busy` with `deliveryComplete:false`, names a retry
      action, and leaves all lifecycle state untouched; a rerun after the winner finishes succeeds.
- [ ] Regression: agent sync, role agents, Claude/Hermes surfaces, H4/H6 behavior, user config,
      install, uninstall behavior beyond its warning/isolation contract, release artifacts, and
      user-owned files remain unchanged outside explicit scope.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Current checkout is stale and dirty | High | Mandatory isolated-worktree preflight from refreshed main `>=5.260712.1`; never implement or merge unrelated routing changes here. |
| Codex CLI JSON/cache behavior changes | High | Bound reads, total fail-closed classifier, supported CLI-only mutations, physical postconditions, and live pre-release smoke. |
| Operator retires N then resumes it after activation | High | Consent is explicitly authority, not liveness proof; output/docs state N may be gone and require `/hooks` plus a new task. |
| Rollback reintroduces a vulnerable updater | High | Digest-bound regular-file sidecar, bounded capability probe, protocol floor, readable intent schema, and pre-mutation refusal. |
| Persistence files become injection/symlink surfaces | High | Size bounds, `lstat` regular-file checks, no symlinks, schema/binding validation, backup-first atomic fsync/rename, and hostile fixtures. |
| Consent becomes stale before activation starts | High | Fingerprint every activation-relevant observation and require `beginActivation` to re-observe and exact-match immediately before its first journal write, refusing with zero mutation on drift. |
| Installer treats exit 2 as failure or success | High | Explicit `deliveryComplete` field and wrapper tests for delivered/action-required propagation without green success text. |
| Hook trust becomes coupled to private host storage | High | No trust API or file access in activation code; spies enforce zero reads/writes/copies/approvals. |
| Routing-delivery-fix edits overlap update/doctor files | Medium | Independent worktree, refreshed base, semantic conflict resolution, focused regression suites, and no dependency on its unreviewed branch state. |
| Native Windows support is inferred from command fixtures | Medium | Keep native installer OUT; document supported WSL boundary and test only shipped Windows hook/env semantics. |
| Explicit uninstall is mistaken for activation or silently breaks tasks | High | Keep its separate user-requested destructive authority, add a pre-confirmation task-breakage warning, retain user-data safeguards, and prove no other command can call it. |
| Live dogfood cannot run before a candidate exists | Medium | Complete A–E and merge to dev first; run the user-gated ritual on the exact homolog candidate and block stable promotion/WISH SHIPPED on failure. |
| Two mutating lifecycle commands interleave journal/receipt/plugin/payload state | High | Exclusive lifecycle lease at the ratified acquisition points with operation-ID fencing; real two-process tests prove exactly one winner and loser zero-mutation. |
| A crashed holder leaves a stale lease and blocks all lifecycle commands | Medium | Dead-pid supersession via atomic non-overwriting rename plus fencing that rejects the superseded operation's late writes; live/indeterminate holders stay busy with no TTL or force override. |

---

## Review Results

### Plan review — initial — 2026-07-12T17:28:52Z

- **Verdict:** FIX-FIRST
- **Target SHA-256:** `0ae4d21914a7c21402f4ff15b7213e8f5f4a7b4948d492302c8eae1ae6f25baa`
- **Reviewer:** `/root/plan_gate`
- **HIGH gaps:** Group E mixed pre-PR completion with post-release evidence; only darwin-arm64 was
  built despite a four-artifact criterion. The supply-chain lens additionally required authenticated
  delivery-root lineage, sterile H3 execution, and rollback lineage/TOCTOU hardening.
- **Evidence:** design review verification, wishes lint, target digest, and scoped diff checks passed.

### Plan review — fix loop 1/2 — 2026-07-12T17:47:55Z

- **Verdict:** FIX-FIRST
- **Target SHA-256:** `7df2c658dd4b7456dbd1e1edce5cb259efda98679884c4f8da62ef34e2d0df64`
- **Reviewer:** `/root/plan_gate_loop1`
- **HIGH gap:** executor and integration-test paths named by Groups B/C were absent from the
  authoritative file manifest. The architecture lens additionally required snapshot-bound consent,
  deep protocol-store ownership, strict shared-workspace sequencing, and explicit init/uninstall
  contracts.
- **Evidence:** prior lifecycle/release and supply-chain HIGH gaps closed; design verification, wishes
  lint, digest, and diff checks passed.

### Plan review — fix loop 2/2 — 2026-07-12T18:02:51Z

- **Verdict:** BLOCKED
- **Target SHA-256:** `37c86263c4c8305db41addb438aa853874492da070c3f29077afc5f0b43fb882`
- **Reviewer:** `/root/plan_gate_loop2`
- **CRITICAL:** 0
- **HIGH gaps:**
  1. No shared cross-process lifecycle lease/fencing contract or exactly-one-winner setup/setup and
     setup/update/install/rollback tests.
  2. Group C syntax-checks the release installer fixture but never executes the exit-2 integration
     path that must preserve delivery, action-required output, lease cleanup, and rerun behavior.
  3. The post-release evidence gate accepts any nonempty file rather than structurally validating the
     exact candidate, N/T identities/digests, exits, doctor JSON, `/hooks`, and new-task proof.
- **QA advisory:** also require B–D subprocess fixtures to isolate `HOME`, `GENIE_HOME`, `CODEX_HOME`,
  and temp roots before import/spawn, explicitly control `CODEX_THREAD_ID`/`CI`, and reject paths that
  escape the fixture.
- **DX advisory:** define a public per-command 0/1/2 matrix and stable machine-readable carrier for
  `deliveryComplete`; treat pending `doctor --json` exit 2 as an intentional compatibility change;
  select one canonical pre-stable candidate channel (homolog recommended); and fixture-test golden
  what/why/next messages plus the structural candidate-evidence schema.
- **Escalation diagnosis:** `ambiguous-spec`. Lease ownership, acquisition timing, transaction extent,
  and loser semantics allow materially different implementations. Model/effort escalation is not
  justified; the next action is an explicit contract amendment followed by a fresh digest-bound plan
  review.
- **Evidence:** design verification, wishes lint (41 files, zero broken links), exact target digest,
  scoped staged/unstaged diff checks, and refreshed-main anchor inspection passed.

### Contract amendment — 2026-07-12 (user-ratified)

- Felipe ratified the lifecycle lease contract verbatim (see "Lifecycle lease contract"), resolving
  the `ambiguous-spec` escalation: lease ownership (Group A deep store), acquisition timing (per
  command), transaction extent (through terminal state, operation-ID fenced), and loser semantics
  (`codex-lifecycle-busy`, exit 2, `deliveryComplete:false`, zero mutation) are now pinned.
- HIGH gap 2 closed by the executed installer integration test
  (`tests/integration/install-exit2-propagation.test.ts`, Group C); HIGH gap 3 closed by the
  structural candidate-evidence schema/validator (`scripts/validate-live-dogfood-evidence.ts`,
  Group E) replacing the nonempty check.
- QA advisory folded in as the normative subprocess-fixture isolation contract (Groups B–E); DX
  advisory folded in as the public 0/1/2 exit matrix, the stable exit-2 result trailer, the
  documented `doctor --json` pending exit-2 compatibility change, homolog as the canonical
  candidate channel, and golden what/why/next message fixtures (Groups D–E).
- Next action: fresh digest-bound independent plan review of this amended document.

### Plan review — fresh gate after ratified amendment — 2026-07-12T18:51Z

- **Verdict:** FIX-FIRST
- **Target SHA-256:** `5d144a2ef8967db475763b20eb6fd3632965b84084731b674c31697182b0e3b1`
- **Reviewer:** `plan-gate-amendment` (independent final-gate subagent)
- **Prior HIGH gaps 1–3:** all adjudicated CLOSED with quoted evidence (lease contract fully
  pinned; executed installer test; structural evidence validator).
- **HIGH (new):** result-trailer ownership contradicted the wave order — Group D (Wave 4) "defined"
  a trailer Group C (Wave 3) must already emit, with no pinned key names/serializer, allowing
  divergent conforming implementations.
- **Advisories:** exclude `doctor --json` from the trailer (design's exactly-one-object contract
  wins); task rows carry no dependency edges; setup races need a real PTY harness; pin whose
  operation ID names the `.stale-` rename; PID reuse fails safe; fenced-JSON evidence payload;
  dual-touch validation surfaces mitigated by sequencing.
- **Design digest note:** DESIGN.md hashes differently only because the design-review evidence
  block was appended after SHIP; the pre-block content hashes exactly to the reviewed
  `893595f7…` digest. No substantive drift.
- **Validation evidence:** wishes lint OK (41 files, 0 broken links), WISH digest exact match,
  5 task rows present, manifest anchors verified against `origin/main` @ `5.260712.1`.

### Plan fix loop 1/2 — 2026-07-12

- Trailer ownership moved to Group A (Wave 1): A's deliverable 1 now defines the exit-2
  result-trailer type and one canonical serializer; C consumes it in Wave 3; D wires and documents
  it and never redefines it; `doctor --json` is explicitly excluded per its single-object contract.
- Advisories folded in: same-host/same-PID-namespace/one-`GENIE_HOME` lease boundary stated as a
  decision; `.stale-` rename pinned to the acquirer's fresh operation ID; PID-reuse fail-safe
  noted; PTY-harness requirement added to the fixture isolation contract; fenced-JSON evidence
  payload pinned; orchestrator-only strictly-ordered task claiming pinned (CLI cannot encode
  dependency edges).
- Next action: independent re-review (loop 1/2).

### Plan re-review — fix loop 1/2 — 2026-07-12T18:55Z

- **Verdict:** SHIP
- **Target SHA-256:** `4c71ab6860aef73bafe36714bdbc9ceaafa39bed7dedabda00cdbddf5f3b4a61`
- **Reviewer:** `plan-gate-amendment` (independent final-gate subagent; recomputed digest first,
  exact match)
- **HIGH-1:** CLOSED — trailer ownership pinned in one direction across A deliverable 1,
  C deliverable 9, D deliverable 9, and the success criterion; A defines the one canonical
  serializer in Wave 1, C consumes in Wave 3, D wires/documents in Wave 4 and never redefines;
  the C→D forward dependency is gone and exact key names are fixed once by A's serializer.
- **New-contradiction hunt:** clean — A's scope growth sits inside its projection-types charter;
  the `doctor --json` trailer exclusion exactly matches the design's one-object stdout mandate;
  all advisory fixes verified in place.
- **LOW residuals (non-blocking, no action):** Decision 14 and the Scope IN bullet elide the
  `doctor --json` exception that the normative sections carry; D's deliverable names
  setup/uninstall while its AC covers all exit-2 surfaces including human doctor.
- **Validation evidence:** wishes lint OK (41 files, 0 broken links); digest exact match.
- Zero CRITICAL/HIGH gaps remain; all three original loop-2/2 HIGH gaps and fresh-gate HIGH-1 are
  closed with mechanically checkable, singly-owned requirements. Plan is ready for `/work`.

### Execution — Group D (lifecycle-surfaces) — 2026-07-22 — SHIP loop 0

Engineer eng-D-lifecycle-surfaces (opus), 8 commits `da7359ae..5f51f785`. **Fork A ratified by
orchestrator** (setup = pure activation surface: observe → A consent → A authorize → B executor;
marketplace/delivery stays with update/install) under four conditions, all met: actionable
refusal on undelivered payload, UX change documented (exit matrix + codex-integration-map.md +
this note — **Felipe veto point at final gate/live QA:** `genie setup --codex` no longer
performs from-scratch install), D-side sync-TTY helper (fail-closed /dev/tty read), and
prove-not-accommodate re-specs (~19 setup tests). Delivered: doctor `integrationSummary`
(add-only checks[], one bounded observation, pending exits 2 with ok:true), init fallback gated
on fresh verified-current, uninstall task-breakage warning + `uninstall` lease (one additive
A-file touch, reviewer-accepted) + call-graph isolation, real two-process cross-kind lease races
(setup+setup, setup+update, uninstall+setup). Independent review (rev-D, opus): **SHIP loop 0**,
all ACs met; PTY command-harness ruled NOT required (lease-primitive races + in-process busy
translation close the seam by source); D3 single-observation interpretation accepted as honoring
the stronger backward-compat constraint. D-scoped suites 262/0; typecheck/biome/budget clean.

### Execution — Group C (delivery-and-rollback) — 2026-07-21/22 — SHIP after fix loop 1/2

Executed post dev-merge `79400467` (union sync; A+B 118 green throughout). Engineer
eng-C-delivery-rollback (opus), 11 commits `4c1029cd..2c2dceec`; incremental green-tree
discipline across 5 resumed sessions. Seam: **Resolution Y** (orchestrator-ratified) — one shared
`classifyCodexDelivery` gate; parent publishes attested facts under `codex-lifecycle-lease`
('update-delivery', post-verify/pre-swap, released in finally); child converges read-only
agents-only on N≠T. Closes the 2026-07-11 incident class at both vectors (update `c07ba6c2`,
install `7c7d98ce`+`2c2dceec`). Independent review (rev-C, opus): loop 0 FIX-FIRST — 1 HIGH
(install never acquired the codex lease; AC8 proven only at primitive level) → fixed `2c2dceec`
(install-converge lease, busy → exit 2 `codex-lifecycle-busy` `deliveryComplete:false`, zero
Codex-cache mutation, real command-path race arm) → loop 1 **SHIP**, all 8 ACs met for real
commands. Suite 2024 pass / 1 known macOS ui-bridge `ss` fail; typecheck/biome/complexity/knip
clean. LOW follow-ups captured on the roadmap (lease-primitive TOCTOU hardening — A-owned;
gate-above-writeConsent ordering). smart-install.js confirmed a retired non-issue.

### Execution — Group D (lifecycle-surfaces) — 2026-07-22 — in progress (Fork A ratified)

Engineer eng-D-lifecycle-surfaces (opus), incremental green-tree commits `da7359ae..`.
Landed: doctor `--json` `integrationSummary` from one bounded observer with 0/1/2 exit and
human stdout/stderr split (D3/D4); init project-fallback reconcile gated on a fresh
`verified-current` observation (D5); uninstall task-breakage warning + codex lifecycle lease
loser semantics + cross-command isolation (D6, uninstall D8/D9); the `uninstall` lifecycle-lease
kind added additively to Group A's enum (the ratified contract names uninstall as a lease
holder; flagged for reviewer); and the setup activation rewrite (D1/D2/D8/D9).

**Ratified UX change (Fork A, team-lead-approved 2026-07-22).** `genie setup --codex` is now
**activation-only**: it retires the active plugin generation and activates the delivered one
through A's deep consent API (the sole retirement-assertion source) + B's permit-gated
`executeCodexActivation` (which self-acquires the `setup-activation` lease). It no longer runs
the legacy cache-advancing `installRuntimeIntegrations` convergence — **delivery of the plugin
payload, marketplace registration, and role agents belongs to `genie update` / `genie install`**.
On a host with nothing delivered, setup emits an actionable refusal pointing at `genie update`
rather than dead-ending (never installs from a fresh machine without prior delivery). `--quick`,
CI, `CODEX_THREAD_ID`, non-TTY, piped, and decline/EOF are unconditional activation refusals
(exit 2, A-owned trailer, zero mutation). The per-command 0/1/2 exit matrix and result trailer
are documented in `plugins/genie/references/codex-integration-map.md`. This change is surfaced
to Felipe for final-gate veto; if vetoed it becomes a follow-up wish, not a re-revert.

### Execution — Group A (activation-protocol-core) — 2026-07-12

- **Verdict:** SHIP after 2 fix loops. Reviewer: independent subagent; engineer: separate subagent.
- Commits: `84fab8bf`, `c490aabe`, `9fd46bcb`, `f410ddea` (+ `c58fceb5` wish-status doc fix).
- Fix loop 1: exported brand classes exposed public static `mint` → forgery (empirically proven);
  closed via type-only export. Fix loop 2: residual `instance.constructor.mint` route (empirically
  proven, incl. fresh-fingerprint permit forgery accepted by `beginActivation`); closed by removing
  the statics for module-private free factories — sole WeakSet registrars. Reviewer re-probed HEAD:
  all forgery routes dead at all three consumption sites (authorize, beginActivation, quarantine).
- Validation: focused suites 85 pass/0 fail; full `bun run check` 1481 pass/0 fail (exit 0).
- LOW carried: optional dedicated quarantine-path forgery test; `new Date()` injectability nit.
- Task `t_mri2bsh8f2617d39` done.

### Execution — Group B (permit-gated-executor) — 2026-07-12 — SHIP

- **Final verdict: SHIP** after fix loop 1/2 (commit `ac264911`). Reviewer empirically confirmed:
  the bricked-Codex scenario (removal-observed, N gone, T absent) recovers end-to-end → activated →
  `current`; fingerprint gate not skippable on resume; re-stamped operation ID keeps fencing sound
  (foreign-lease mid-resume swap → `codex-lifecycle-fenced`); phase never resets backward to
  planned; single-journal invariant held; handback edit bounded to the 4 authorized files with A's
  brand guarantees re-probed intact. All 7 ACs pass. Orchestrator validation: focused 118 pass/0
  fail; full gate 1514 pass/0 fail (exit 0). Task `t_mri2bsj07c8c4964` done.
- LOW carried: H3 poison/Node-root-replacement coverage extensions; Windows env branch structural;
  observe/beginActivation throw escapes as exception (lease still released); inert
  `*.genie-backup-*` sidecar accumulation (pre-existing).

### Group B review detail (historical)

- Engineer commit `b46d3b03` (executor + 20-test suite; real two-process race exactly-one-winner).
  Orchestrator validation: focused suites 141 pass/0 fail; full gate 1501 pass/0 fail (exit 0).
- **Review verdict: FIX-FIRST** — one HIGH: post-command phases (`command-started`,
  `removal-observed`, `ambiguous-absent`) were activation-ineligible in A's `ACTIVATION_ELIGIBLE`,
  contradicting the DESIGN truth table's recovery authority and B deliverable 3; a failed add after
  removal bricked Codex with no tool path. Fix loop 1/2 dispatched: align code with DESIGN (widen
  eligibility + resume the existing bound intent in `beginActivation`; executor drives idempotent
  re-add → parity → H3 → finalize), under an explicit orchestrator handback authorizing the bounded
  Group A edit with mandatory A-suite revalidation.
- **Adjudication (binding for AC interpretation):** downgrade-receipt consumption at
  `finalizeActivation` (terminal) is COMPLIANT with the normative DESIGN ordering ("intent first,
  then receipt after all postconditions") and crash-window-safe (reviewer traced both branches: an
  interrupted add leaves the receipt either inert under `installed-newer` matching rules or locked
  to the same bound target; `publishDelivery` clears stale receipts; the finalize tombstone defeats
  single-file replay). Group B's AC "tombstoned before the first plugin command" is read per the
  DESIGN; wording is reconciled here rather than by weakening any replay guarantee.
- **Hard handback to Group C (blocking):** the legacy unpermitted cache-advancing mutator
  `convergeCodexPlugin` (runtime-integrations.ts) remains wired into update/install/setup at
  `b46d3b03`. C's deliverable 1 MUST remove/rewire all three call sites onto B's permit-gated
  facade; the branch must not ship or merge standalone before C lands. Escalates to HIGH if
  violated.
- MEDIUM/LOW carried: failure injection extended in fix loop 1 (beforeParity/beforeH3/
  beforeEnabledRestore/afterPluginAdd/beforeRemovalObserved); H3 poison-coverage extensions
  (PATH/HOME/TMP*/ComSpec, Node/root replacement post-validation); Windows env branch structural
  (per WSL boundary); observe/beginActivation throw escapes as exception (lease still released).

---

## Files to Create/Modify

```text
src/lib/codex-activation.ts
src/lib/codex-activation.test.ts
src/lib/codex-activation-executor.ts
src/lib/codex-activation-executor.test.ts
src/lib/codex-lifecycle-lease.ts
src/lib/codex-lifecycle-lease.test.ts
src/lib/update-capabilities.ts
src/lib/update-capabilities.test.ts
src/lib/runtime-integrations.ts
src/lib/runtime-integrations.test.ts
src/lib/codex-project-mcp.ts
src/lib/codex-project-mcp.test.ts
src/genie-commands/update.ts
src/genie-commands/__tests__/update.test.ts
src/genie-commands/install.ts
src/genie-commands/install.test.ts
src/genie-commands/setup.ts
src/genie-commands/setup.test.ts
src/genie-commands/doctor.ts
src/genie-commands/doctor.test.ts
src/genie-commands/uninstall.ts
src/genie-commands/uninstall.test.ts
src/term-commands/init.ts
src/term-commands/init.test.ts
src/genie.ts
src/genie.test.ts
install.sh
tests/integration/install-from-gh-releases.sh
tests/integration/install-exit2-propagation.test.ts
src/lib/smart-install-hook.test.ts
plugins/genie/hooks/codex-hooks.json
src/hooks/__tests__/codex-manifest.test.ts
scripts/hook-bundle-parity.ts
scripts/hook-bundle-parity.test.ts
scripts/hook-content-binding.ts
scripts/hook-content-binding.test.ts
scripts/fresh-install-smoke.ts
scripts/fresh-install-smoke.test.ts
scripts/release-docs.test.ts
scripts/release-payload-version.test.ts
scripts/verify-codex-activation-payload.ts
scripts/verify-codex-activation-payload.test.ts
scripts/validate-live-dogfood-evidence.ts
scripts/validate-live-dogfood-evidence.test.ts
README.md
plugins/genie/README.md
plugins/genie/references/codex-integration-map.md
.genie/wishes/codex-plugin-update-handoff/qa/live-dogfood-<date>.md
```
