# Design: Codex plugin update handoff

| Field | Value |
|-------|-------|
| **Slug** | `codex-plugin-update-handoff` |
| **Date** | 2026-07-12 |
| **WRS** | 100/100 |

## Problem

`genie update` can advance and prune a versioned Codex plugin cache while an open or resumable Codex
task still holds paths into that generation, causing hooks, skills, MCP, or other resources to vanish.
The 5.260711.6→5.260712.1 live update reproduced this as `SessionStart` exit 1 while the new H3 script
itself remained healthy.

## Scope

### IN

- Split signed Genie binary/canonical-payload delivery from cross-version Codex plugin activation.
- Put every activation-capable entry path behind one read-only observer, pure state classifier, and
  pre-mutation authorization gate: normal/post-delivery/already-current update, explicit channel
  downgrade, binary rollback, install, `setup --codex`, full setup, every `--quick` setup form, and
  interrupted refresh-intent recovery.
- Make update and install paths delivery/discovery-only. They report the classified Codex state and
  never obtain authority to run cache-advancing plugin commands. Treat legacy `--sync-only` as an
  explicit non-activation exception: it branches before the observer/classifier and performs agent sync
  only, with no plugin query, activation diagnosis, or activation-side mutation.
- Reuse explicit external `genie setup --codex` (or the Codex step of the full interactive wizard) as
  the activation boundary. A permit requires real stdin and stdout TTYs, no `CODEX_THREAD_ID`, no
  `--quick`, no `--no-interactive`, no `CI`, and a positive version-specific retirement assertion in
  that process. Every refused or declined activation makes zero activation-side mutation.
- Derive stable human/JSON states from a read-only snapshot. Keep ordinary pending state derived; use
  one bounded durable refresh intent only after an authorized activation transaction starts.
- Preserve enabled/disabled state, existing interrupted-refresh recovery, and explicit hook trust.
- Verify N+1 full physical payload parity and execute a bounded host-shaped H3 smoke before activation
  reports success.
- Specify direction-aware upgrade/downgrade/rollback behavior, idempotent pending reruns, exact
  stdout/stderr/exit semantics, sync-only isolation, failure recovery, POSIX/Windows parity, and
  post-release live dogfood.

### OUT

- Genie-owned copies, restoration, aliases, symlinks, retention, or garbage collection inside Codex's
  plugin cache.
- Seamless resume of retired N tasks after explicit N+1 activation; authoritative generation leases
  require a Codex-host enhancement.
- Reading, writing, copying, or automatically approving hook trust; task killing/scanning, daemons, or
  hidden background refresh.
- H4/H6 policy changes, skill/MCP content changes, user-tier skill or role-agent adoption, Claude/Hermes
  convergence, always-on identity, and worktree policy.

## Approach

Use a two-phase, fail-closed handoff with three explicit layers:

1. `observeCodexActivation()` performs only bounded reads and returns a `CodexActivationSnapshot`:
   canonical payload version/digest, registration query result and enabled state, `lstat`/realpath cache
   facts, matching explicit-delivery receipt when present, and refresh-intent phase when present.
2. Pure `classifyCodexActivation(snapshot)` returns one tagged state from the truth table below. Pure
   `authorizeCodexActivation(state, invocation)` returns either a refusal or an opaque, current-process
   `ActivationPermit`; it performs no I/O. The caller may create a permit only for the external real-TTY
   setup assertion described below. Every marketplace/plugin/config/role-agent/project-fallback
   mutator in the activation flow requires that permit, so no entry path can bypass the gate.
3. The executor uses supported Codex CLI commands only, advances a durable refresh intent around the
   destructive boundary, restores the prior enabled flag, verifies the installed physical payload, and
   runs the exact H3 smoke before deleting the intent and reporting success.

`genie update` still delivers and verifies the signed binary and canonical payload and may converge
non-plugin agent surfaces. It never receives an `ActivationPermit`. Once canonical T differs from
registered N, it reports a derived pending state and exits 2. The fresh-binary child uses a distinct
internal `--post-delivery-converge` mode with no activation permit; it converges non-plugin surfaces and
returns its classified state to the parent, which owns action-required exit 2. Legacy `--sync-only`
remains a separate hook-safe agent-sync surface and branches before activation observation or
classification. An already-current binary rerun reclassifies the plugin instead of short-circuiting
before Codex state is checked.

After the operator retires tasks pinned to N, external `genie setup --codex` (or the manually accepted
Codex step in full setup) requires `stdin.isTTY === true`, `stdout.isTTY === true`, `CI` and
`CODEX_THREAD_ID` unset, neither `--quick` nor `--no-interactive`, and an affirmative prompt naming N
and T: “I assert tasks pinned to N are retired and will not be resumed; activate T.” This is an
operator assertion authorizing only this process, not evidence or proof that no live/resumable task
exists. It is never persisted as liveness state. Decline, EOF, or any guard failure exits 2 before
writing an intent or touching Codex integration state.

Successful activation requires physical parity and H3 runtime evidence, preserves enabled state, and
prints `/hooks` plus new-task actions. Once any plugin command starts, N may already be pruned: a later
query, parity, enable-state, or H3 failure is `broken/retry`, never “N preserved.” Recovery re-enters the
same external-TTY gate with a fresh assertion and the durable intent; Genie never repairs cache files
directly.

Alternatives lost for concrete reasons: a mutable stable launcher protects only executables and can
run unreviewed bytes; Genie-side cache retention creates a second cache owner and unsound cleanup;
documentation alone already failed; host-owned immutable generation leases are the correct seamless
future but are cross-repo and not required for this bounded mitigation.

### Activation entry-point matrix

| Entry path | Shared-gate contract | Result when a version transition/repair is needed |
|---|---|---|
| Normal update, before and after signed delivery | Observe/classify before any activation call; delivery itself has no permit | Deliver canonical T, preserve registered N, report pending, exit 2 |
| Fresh-binary post-delivery re-entry | Internal `--post-delivery-converge` has no activation permit; it syncs non-plugin surfaces and returns classification | Parent maps pending to action-required exit 2; child never activates |
| Already-current update | Must classify Codex instead of returning after the binary comparison | Current→0, pending→2, broken/indeterminate→1; never activate |
| Explicit channel downgrade | Signed delivery records a matching explicit-downgrade receipt, but grants no activation permit | Registered newer becomes `pending-downgrade-explicit`, exit 2 |
| `genie update --rollback` | Verify the backup's digest-bound capability sidecar and read-only probe report activation protocol >=1 before replacement; consent cannot waive this floor | Compatible fixed binary only; otherwise preserve both binaries and integration state, set `deliveryComplete:false`, exit 2 |
| `genie install` (`auto`, `codex`, or `all`) | Post-install may deliver/sync, but never receives a permit (installers are commonly piped) | Absent/stale plugin is action-required, exit 2; install wrapper treats 2 as delivered-not-activated |
| External `genie setup --codex` | May receive a permit only after every environment guard and the dedicated retirement assertion | Execute one activation/recovery transaction; 0 only after all postconditions |
| Full interactive `genie setup` Codex step | The ordinary “configure Codex?” answer is not retirement consent; run the same dedicated gate | Same as `setup --codex` |
| `genie setup --quick`, `setup --codex --quick`, or any full-wizard quick path | `--quick` is an unconditional activation refusal and cannot synthesize consent | Zero activation-side mutation, action-required output, exit 2 |
| Refresh-intent recovery from update/install/doctor/post-delivery convergence | Observe and report the intent but never consume or advance it | Exit from the state table with external setup recovery |
| Refresh-intent recovery from external setup | Re-run every guard and obtain a fresh assertion; stored consent is forbidden | Reconcile/retry through supported Codex CLI only |
| Legacy `--sync-only` / `GENIE_UPDATE_SYNC_ONLY=1` | Agent-sync only; no activation observer, query, branch, or permit | Exit 0 unless sync itself fails; never affects parent/post-delivery classification |

`CODEX_THREAD_ID`, `--quick`, `--no-interactive`, non-empty `CI`, stdin not a TTY, or stdout not a TTY
always denies an otherwise eligible activation. The denial occurs before marketplace changes, plugin
commands, Codex config writes, role-agent copies, project fallback removal, trust access, or refresh-
intent creation. Delivery or unrelated wizard sections completed before reaching this gate remain
separate, explicitly reported phases.

### Pure state truth table

Classification uses the first matching row and always returns one row. The observer validates the
canonical target and every reported registration version against the exact `MAJOR.YYMMDD.N` grammar
(optional build metadata is stripped only after validation) before any comparison. A registration
entry with a missing, non-string, or invalid version is not “absent” or “older.” “External setup” means
a new permit from the gate above; the table's exit is the observer/doctor default before successful
recovery. Cache N in a pending row is only `present-unverified`: after canonical N+1 replaces the N
comparator, Genie cannot claim N's integrity.

| Classified state | Pure predicate | Mutation authority | Exit | Human output / recovery |
|---|---|---|---:|---|
| `query-failed` | `codex plugin list --json` failed or was unparseable | None | 1 | Indeterminate; repair Codex CLI/query, rerun doctor |
| `registration-version-invalid` | Registration exists but version is missing, non-string, or fails the release-version grammar | None | 1 | Indeterminate; no comparison or recovery authority |
| `unsafe-cache-symlink` | Registered cache root or any required payload path is a symlink | None | 1 | Unsafe path; operator repairs through Codex, never Genie filesystem surgery |
| `unsafe-cache` | Root escapes expected Codex cache, is not a physical directory, or has unsafe topology | None | 1 | Unsafe path/topology; manual Codex-host recovery |
| `intent-invalid` | Exact Genie-owned intent is a safe regular file but is corrupt, oversized, invalid JSON/shape, or has an unsupported schema/field value | Quarantine-only after a fresh external assertion | 1 | No recovery authority; quarantine safely, then re-observe |
| `intent-mismatch` | Structurally valid intent has stale/mismatched from, target, digest, direction, command, or receipt binding | Quarantine-only after a fresh external assertion | 1 | No recovery authority; quarantine safely, then re-observe |
| `intent-target-current` | Valid bound intent remains, while registration is T and safe physical T has full canonical parity | External setup after fresh assertion; no cache-advancing command | 2 | Restore prior enabled flag if needed, reverify enabled/parity/H3, then clear journal |
| `intent-ambiguous-absent` | Intent says `ambiguous-absent`; registration/cache absence cannot be attributed safely | External setup after fresh assertion | 1 | Broken/retry; reconcile with supported CLI, do not claim N survives |
| `intent-removal-observed` | Intent says `removal-observed` and target is not fully current | External setup after fresh assertion | 1 | N is gone; continue supported add/verify transaction |
| `intent-command-started` | Intent says `command-started`; target postconditions are incomplete | External setup after fresh assertion | 1 | Host may have pruned N; query and idempotently reconcile/retry |
| `intent-planned` | Authorized intent was durably written before a command, then interrupted | External setup after fresh assertion | 2 | No command is known to have started; resume through setup |
| `registration-absent` | Query succeeds, no registration, no recovery intent | External setup after assertion | 2 | Activation required; update/install do not install it |
| `cache-missing` | Registration exists but its expected physical generation is absent | External setup after assertion | 1 | Broken/repair; supported reinstall only |
| `payload-mismatch` | Registration is target T but safe physical T differs from canonical inventory/digests | External setup after assertion | 1 | Broken/repair; never execute or trust mismatched payload |
| `pending-downgrade-explicit` | Registered N>T and a verified delivery receipt explicitly selected this exact T | External setup after assertion | 2 | Explicit downgrade pending; name N/T and irreversible retirement step |
| `installed-newer` | Registered N>T without that exact explicit-downgrade receipt | None | 1 | Refuse implicit downgrade; run explicit channel update, then setup |
| `activation-pending` | Registered N<T, physical N is a safe regular directory and present-unverified | External setup after assertion | 2 | `retire tasks → setup --codex → /hooks → new task` |
| `current` | Registered T, safe physical T matches canonical payload, no unresolved intent | None | 0 | Current; no mutation |
| `snapshot-inconsistent` | Any otherwise-unhandled combination | None | 1 | Fail closed; print bounded snapshot facts, never infer authority |

Pending reruns are idempotent: they invoke no activation command, create/advance no refresh intent,
and return the same stable state/action (apart from separately reported delivery/sync work). Direction
is never inferred as authority. An explicit channel downgrade authorizes delivery of older canonical
bytes only; the later setup assertion authorizes plugin activation. Binary rollback is not plugin
rollback and cannot create a downgrade receipt.

The intent reader accepts at most 16 KiB, an exact schema-1 object, validated from/target versions
(`fromPluginVersion` may be null only for install), a 64-lowercase-hex canonical digest, boolean prior
enabled state, an allowed phase, `commandKind:'codex-plugin-add'`, bounded failure text, and a nullable
receipt ID. Semantic binding requires target/digest equal the current canonical snapshot; direction
equal the total result derived from validated from/target (`install`, `upgrade`, `downgrade`, or
`repair`); planned registration equal from (or be absent for install); later-phase registration be
only from, absent, or target; and receipt ID be exact and matching only for downgrade. Unknown keys,
unsupported schemas, invalid fields, a third registration version, or any mismatch in
from/target/digest/direction/command/receipt grants no recovery authority. `intent-target-current`
dominates all phase rows and `current`, closing the crash window after T becomes current but before
journal cleanup.

A safe regular invalid/mismatched intent may be quarantined only after a fresh external assertion by
a separate journal-only permit: atomically rename the exact file in the same directory to a
non-overwriting `.invalid-<file-sha256>` name, with no cache/config/plugin mutation. Then discard the
old snapshot, re-observe, and reclassify. Any activation requires a new authorization decision against
that fresh state; the bad intent itself never grants recovery authority. A symlink, non-regular,
unreadable, or unsafe intent path is not quarantined and fails closed.

Binary rollback has an inductive activation-protocol floor. Every fixed binary exposes a bounded,
read-only `--print-update-capabilities --json` probe and, when backed up, is paired atomically with
`<backup>.capabilities.json` containing exactly `{schemaVersion:1, reportedVersion, binarySha256,
codexActivationProtocol, readableIntentSchemas}`. Before any live-binary rename or exec, rollback
rehashes the backup, runs the no-shell probe with a 5-second timeout, requires exact
sidecar/probe/version agreement, `codexActivationProtocol >= 1`, and support for any valid extant
intent schema. Protocol 1 includes this same rollback-floor rule.

Thus the first fixed release may retain a pre-contract backup but must refuse to restore it; later
fixed-to-fixed rollback succeeds only with a matching digest/probe. Registration, explicit rollback,
and fresh or prior activation consent cannot waive the floor. Refusal precedes mutation, leaves live
binary, backup, canonical payload, registration, cache, receipt, and intent unchanged, sets
`deliveryComplete:false`, and tells the operator to select a compatible signed release. A pre-swap
crash is a safe rerun; after atomic swap the restored protocol-1+ binary reclassifies the unchanged
integration and enforces the same gate.

The downgrade receipt is a minimal atomic file at
`$GENIE_HOME/.codex-plugin-downgrade-receipt.json` containing only
`{schemaVersion:1, receiptId, fromPluginVersion, targetVersion, canonicalPayloadSha256, channel}`.
`receiptId` is 128 OS-CSPRNG bits encoded as exactly 32 lowercase hexadecimal characters. It is
atomically written only after attested explicit-channel delivery when validated `fromPluginVersion >
targetVersion`, and is usable only when its safe bounded exact schema and every field match the
snapshot. The downgrade intent must copy the same ID. Missing, malformed, reused, or mismatched IDs
grant no authority and classify a newer registration as `installed-newer`. Any other successful
delivery removes/replaces a stale receipt. Successful activation deletes the intent first, then the
exact matching receipt after all postconditions; a crash between deletes leaves an inert receipt that
`current` ignores and the next delivery removes. Rollback never writes or consumes it.

### Refresh intent and failure boundary

The only durable activation journal is `$GENIE_HOME/.codex-plugin-refresh-intent.json`, atomically
written after a permit and before the first mutator. It records schema version, from/target versions,
direction, prior enabled flag, canonical digest, matching explicit-downgrade receipt id when relevant,
phase, command kind, and last failure; it never records consent or a liveness claim.

Phases are `planned` (durable, no command started), `command-started` (fsynced immediately before each
cache-advancing command), `removal-observed` (a successful query proves old registration/cache absent),
and `ambiguous-absent` (absence observed after an uncertain command outcome). The journal is deleted
only after target registration, enabled-state restoration, safe full parity, and H3 smoke all pass.
After `command-started`, every failure is broken/retry and N preservation is explicitly unknown.
If T already has safe full parity, `intent-target-current` forbids add/remove: gated finalization may
only restore the recorded enabled flag through the supported non-cache-advancing command, re-query it,
reverify parity, run H3, delete the intent, and then delete a matching downgrade receipt.

### Output contract

Exit 0 means current (or successful activation); exit 2 means action or consent is required; exit 1
means broken, unsafe, or indeterminate. Every exit-2 result includes `deliveryComplete`: true only when
the invocation's requested canonical delivery is verified or was already verified, false when it was
refused or failed before completion. Human mode writes normal/current/pending status and recovery to
stdout; modeled broken diagnostics go to stderr without an all-green footer. A missing, declined, or
guard-refused assertion is an authorization result (`required` or `refused` plus reason), never a
classifier overlay: the underlying state and snapshot remain unchanged. Eligible setup refusal exits
2 even when that state's ordinary doctor exit is 1.

`doctor --json` writes exactly one ANSI-free object to stdout and reserves stderr for an unmodeled
process failure. It preserves the existing top-level `{ok,checks}` contract and adds one versioned
field, never replacing or renaming existing keys:

`{ok,checks,integrationSummary:{schemaVersion:1,codexPlugin:{state,installedVersion,targetVersion,
direction,registration,cache,intentPhase,mutationAuthority,authorization,actionRequired,
deliveryComplete,recovery}}}`.

`cache` is one of `verified-current`, `present-unverified`, `missing`, `unsafe-symlink`, `unsafe`,
`mismatch`, or `unknown`; `mutationAuthority` is `none`, `journal-quarantine-only`, or
`external-tty-setup`; `authorization` is `{result:'not-requested'|'required'|'granted'|'refused',
reason:null|string}`. Existing `ok`/`checks` semantics remain unchanged. Repeated human and JSON
pending runs have the same state/version/action values. `--post-delivery-converge` may classify but has
no permit and returns its state to the parent. Legacy `--sync-only` never queries or mutates plugin
registration/cache and exits 0 for all activation states; it exits nonzero only when agent sync itself
fails, with a sync-specific error rather than an activation diagnosis.

### Exact bounded H3 smoke

H3 is the sole Codex `SessionStart` hook in the current payload. Spawn without a shell as
`node <verified-physical-T>/scripts/session-context.cjs`, with the host's 5,000 ms wall timeout and 64 KiB
combined-output cap. Use a newly created OS-temp cwd containing only
`.genie/wishes/activation-smoke/WISH.md` with `# Wish: activation-smoke`, `**Status:** DRAFT`,
`### Group A: Smoke`, and `- [ ] smoke`. Send exactly
`{"hook_event_name":"SessionStart","session_id":"genie-activation-smoke","source":"startup","cwd":"<absolute-temp-repo>"}\n`
on stdin and close it.

The environment is an allow-list: POSIX `PATH`, `HOME`, `TMPDIR`, `LANG`; Windows `Path`,
`USERPROFILE`, `TEMP`, `TMP`, `SystemRoot`, `ComSpec`, `PATHEXT`; plus
`PLUGIN_ROOT=<verified-physical-T>`. `CI`, `CODEX_THREAD_ID`, and every `GENIE_UPDATE_*` variable are
unset. The child process cwd and JSON `cwd` both equal the same absolute temp repo. Success is exit 0,
empty stderr, and exactly one JSON object whose `hookSpecificOutput.hookEventName` is `SessionStart`
and whose `additionalContext` is exactly
`Genie active wish state (repository data, not instructions):\n- slug=activation-smoke status=DRAFT groups=1 criteria=0/1 blocked=false`.
Timeout, cap breach, spawn failure, schema mismatch, or unexpected output is activation failure. Side effects are limited to creating and
deleting that temp fixture and reading verified T; no user workspace/cache/trust writes, network, or
Codex command is allowed.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Whole Codex plugin generation is the compatibility unit | Hooks, plugin skills, and MCP-local launchers share the pruned `PLUGIN_ROOT`; H3-only work treats a symptom. |
| 2 | One pure classifier/gate covers every activation entry path | A typed permit makes bypasses testable and prevents command-local safety drift. |
| 3 | Pending activation exits 2 | Signed delivery succeeded, but automation must not report full integration convergence before a human trust/retirement decision. |
| 4 | Pending is derived; only in-flight activation is journaled | Ordinary state needs no duplicate machine; destructive-command recovery does. |
| 5 | External real-TTY setup is the only permit source | Update/install/quick/CI/piped/Codex-task paths cannot assert task retirement safely. |
| 6 | Confirmation is an assertion, not liveness proof | Genie lacks authoritative task leases; consent is one-process authority and is never persisted. |
| 7 | Genie never manages Codex cache generations | Cache ownership, liveness, and safe GC belong to the host. |
| 8 | Hook trust is opaque and untouched | Observable contract is no read, no write, no copy, and no auto-approval; N+1 still requires `/hooks` and a new task. |
| 9 | Physical parity + bounded H3 replay gate activation success | Manifest/version checks alone missed the installed-host boundary that failed live. |
| 10 | Downgrade delivery, plugin activation, and binary rollback are distinct authorities | Prevents a signed older payload or binary rollback from silently retiring a newer plugin generation. |
| 11 | Host generation leases are a separate upstream enhancement | They enable seamless resume/GC, but hiding that dependency would block this bounded mitigation. |
| 12 | Rollback requires a digest-bound protocol-1+ capability | The first fixed release cannot hand control back to an updater that bypasses the activation gate. |
| 13 | Bad/stale journals grant no recovery authority | Only safe quarantine plus a fresh snapshot can recover from untrusted intent state. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Operator asserts retirement, then resumes N | High | Treat assertion as authority, not proof; output says N may be gone and requires `/hooks` + a new task. |
| 2 | Update success is confused with integration success | High | Distinct phase output, exit 2, doctor structured state, and no all-green footer with warnings. |
| 3 | Explicit activation fails after plugin command starts | High | Journal exact phase; report broken/retry and never claim N preservation; retry only through the gated supported CLI. |
| 4 | Codex CLI/cache behavior changes | Medium | Verify physical pre/post state and H3 output; fail closed without direct cache repair. |
| 5 | Pending N is mistaken for integrity-verified | Medium | Report only safe physical presence; canonical T cannot verify N after delivery. |
| 6 | Windows command/env behavior diverges | Medium | Fixture both command forms and `CODEX_THREAD_ID`/noninteractive refusal semantics. |
| 7 | Trust implementation becomes coupled to host-private storage | High | Activation has no trust dependency or access; tests prove zero trust reads/writes/approval calls. |
| 8 | User-tier skills, role agents, or Claude remain stale | Medium | Keep separate; doctor must not imply they were fixed here. |
| 9 | Current checkout is older and dirty | High | Execute only in an isolated worktree based on refreshed main at or after 5.260712.1. |
| 10 | Binary rollback reintroduces the vulnerable updater | High | Verify the bound capability probe before swap; consent cannot waive protocol floor 1. |
| 11 | Corrupt/stale intent is mistaken for recovery authority | High | Total schema/binding validation, fail-closed states, quarantine-only permit, fresh reclassification. |

## Success Criteria

- [ ] Every activation-capable or integration-reporting entry path reaches the same pure
      classifier/authorization gate; legacy `--sync-only` is explicitly outside that set and branches
      before the observer/classifier. No activation mutator is callable without an opaque permit from
      external real-TTY setup.
- [ ] With registered N and canonical N+1, normal/post-delivery/already-current update and install never
      invoke a cache-advancing command; N remains present-unverified and a fixture snapshot proves those
      commands did not mutate it.
- [ ] Update reports signed delivery separately from `Codex activation pending`, includes N/N+1 and
      `retire tasks → genie setup --codex → /hooks → new task`, then exits 2.
- [ ] A task already pinned to N can resume/compact and read its N hook/skill paths after normal update
      because activation was deferred.
- [ ] The complete truth table is unit-tested as a pure function, including current, upgrade pending,
      explicit downgrade pending, installed-newer, absent/query-failed, invalid registration version,
      every cache fault, payload mismatch, invalid/mismatched intent, target-current dominance, all
      four refresh-intent phases, and the fail-closed fallback.
- [ ] Human output and `doctor --json` expose the specified stable state/schema, stdout/stderr split,
      additive `{ok,checks,integrationSummary}` shape, `deliveryComplete`, authorization result, and
      0/1/2 exits; refusal preserves classifier state and pending runs never advance an intent.
- [ ] Activation makes zero activation-side mutation under `CODEX_THREAD_ID`, any quick form,
      `--no-interactive`, CI, non-TTY/piped I/O, decline, or EOF; only a fresh external real-TTY
      version-specific assertion obtains a one-process permit, without claiming liveness proof.
- [ ] Successful activation preserves enabled/disabled state, verifies full physical payload parity,
      passes the exact 5-second/64-KiB fixture-backed H3 command/schema contract, and requires `/hooks`
      plus a new task.
- [ ] Failure injection at every explicit activation phase produces an exact phase/recovery message and
      an idempotent gated retry; any post-command failure is broken/retry and does not promise N survives.
- [ ] Trust spies prove activation performs no hook-trust read, write, copy, or approval operation; no
      path alias lets N-reviewed commands execute N+1 bytes.
- [ ] Explicit downgrade delivery yields pending rather than activation; installed-newer without the
      exact 128-bit-ID receipt fails closed; successful activation/deletion order is crash-safe.
- [ ] First-fixed→pre-contract rollback is refused before mutation even with registration and consent;
      fixed→fixed rollback requires matching binary hash/sidecar/probe and intent-schema support;
      mismatch, tamper, probe failure, pre/post-swap interruption, and rerun behavior are tested.
- [ ] `intent-target-current` recovery requires a fresh assertion, restores/reverifies enabled state,
      parity, and H3, then clears the journal without add/remove; bad intents can only be safely
      quarantined and reclassified before a new authorization decision.
- [ ] Sync-only contains no observer, classifier, authorization, plugin query, or plugin mutation path;
      spies prove those calls remain zero. It exits 0 regardless of activation state and is nonzero only
      for a real sync failure with sync-specific diagnostics.
- [ ] POSIX and Windows manifests/commands satisfy the same refusal, verification, and recovery contract.
- [ ] Post-release dogfood records N task → update → resume/compact on N → retire/setup → `/hooks`
      review → genuinely new N+1 task, with commands, versions, exit codes, and doctor JSON.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `893595f780d3967144fed7c89db71303a5ffe6549505da11fff9c4dd9a948177`
- **Reviewer:** /root/design_gate_sync_exception
- **Reviewed at:** 2026-07-12T17:16:37.000Z
<!-- genie-design-review:end -->
