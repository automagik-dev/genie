# DRAFT: Codex plugin update handoff

**Status:** Ready
**Started:** 2026-07-12
**Renamed from:** `sessionstart-hook-reliability` after the live root cause proved broader than H3
**Parent context:** the hook-contract half of
[`always-on-genie`](../always-on-genie/DRAFT.md); worktree isolation remains independent.

## WRS

`WRS: ██████████ 100/100`

Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅

## Problem

`genie update` can advance and prune a versioned Codex plugin cache while an open or resumed Codex
task still holds resource paths into that generation, causing hooks, skills, MCP, or other plugin
resources to disappear underneath the task.

## Live evidence

- 2026-07-12, immediately after `genie update`: Codex reported `SessionStart hook (failed)` and only
  `error: hook exited with code 1`.
- The resumed process retained Genie skill/hook paths rooted at Codex cache `5.260711.6`; update
  installed `5.260712.1` and the host removed the `.6` directory.
- Replaying a retained `.6` script path deterministically produces Node `MODULE_NOT_FOUND` and exit 1.
- Replaying the exact installed `.1` H3 command from both the canonical payload and Codex cache emits
  valid additional context and exits 0. The new script is healthy; cache turnover broke its predecessor.
- Current `.1` convergence deliberately avoids an explicit remove/reinstall, but calls
  `codex plugin add`; the live host advanced the registration and pruned the old cache inside that
  command. Treating `plugin add` as safe for live task paths is the failed assumption.
- The current process also advertises `genie:*` skill paths under the deleted `.6` cache, proving the
  boundary affects the plugin resource root rather than SessionStart semantics alone.

## Installation audit after update

| Surface | Verified state | Disposition |
|---------|----------------|-------------|
| CLI/release | `5.260712.1`; installed binary and stable manifest matched | Healthy |
| Codex plugin on disk | enabled `.1`; canonical payload and cache byte-identical (114 files) | Healthy new generation |
| Current Codex process | retained deleted `.6` resource paths | This design |
| Current `.1` H3 | realistic replay exits 0 with valid context | Smoke becomes activation evidence |
| Hook trust | stored review predates `.1` definition | Explicit `/hooks` review remains mandatory |
| User-tier Codex skills | `1/23` current; same-name personal copies preserved | Separate ownership policy |
| Codex role agents | 7 present, ownership inventory absent; 6 match and reviewer differs | Separate adoption policy |
| Claude | disabled plugin remains `.6`; user-tier skills `0/22` current | Separate runtime follow-up |

## Scope

### IN

- Make cross-version Codex plugin activation a separate explicit phase from signed Genie binary and
  canonical payload delivery. Normal `genie update` must not call the cache-advancing plugin command
  across a version boundary and must exit with an action-required code after successful delivery.
- Leave registered generation N present and unmutated by delivery paths until an authorized setup;
  after canonical N+1 replaces its comparator, report N as `present-unverified`, not integrity-verified.
- Put normal/post-delivery/already-current update, downgrade/rollback, install, every setup/quick form,
  and refresh recovery behind one read-only observer, pure classifier, and typed authorization gate.
- Prevent binary rollback from restoring a pre-contract updater by requiring a digest-bound protocol-1+
  capability sidecar/probe before any swap; activation consent cannot waive this floor.
- Refuse activation with zero activation-side mutation under `CODEX_THREAD_ID`, `--quick`,
  `--no-interactive`, CI, or piped/non-TTY stdin/stdout. Only external real-TTY setup plus a fresh
  N→T retirement assertion can obtain a one-process permit; the assertion is not liveness proof.
- Preserve enabled/disabled state, verify the new physical cache, run the exact bounded H3 smoke, and
  print `/hooks` plus new-task actions. Hook trust remains opaque: no reads, writes, copies, or approval.
- Add deterministic fixtures for update N→N+1 with an old generation in use, explicit activation,
  current-version idempotency, interrupted activation recovery, and missing-cache diagnosis.
- Update operator documentation so one path answers what changed, why activation is pending, and the
  exact safe next action.

### OUT

- Copying, restoring, retaining, symlinking, or garbage-collecting Codex-owned plugin cache generations.
- Detecting or killing every live Codex process; explicit activation is the human trust/liveness boundary.
- Automatically trusting changed hooks or bypassing `/hooks` review.
- Promising seamless resume of retired N tasks after explicit N+1 activation. That requires a
  Codex-host generation lease and is a separate upstream enhancement.
- Changing H4/H6 policy semantics, MCP behavior, or skill content.
- Adopting user-owned skills/role agents, repairing Claude convergence, always-on identity payloads,
  or worktree isolation.
- Implementing any fix during this brainstorm.

## Approaches considered

### A. Two-phase delivery and activation (recommended)

Deliver the signed Genie binary and canonical plugin payload during `genie update`, but defer a
cross-version Codex `plugin add`. The existing explicit `genie setup --codex` becomes the activation
boundary after tasks are closed. This uses Codex's cache owner for mutation, preserves the active
generation until operator consent, and requires no Genie cache manager.

### B. Retain previous cache generations

Copy or restore old generations after Codex prunes them, then garbage-collect later. Rejected: it
creates a second cache owner, cannot eliminate the removal window, needs liveness tracking Genie does
not possess, and expands trust/provenance obligations.

### C. Stable launcher outside the plugin cache

Point hook commands at `~/.genie` and use `${PLUGIN_ROOT}` only as fallback. Rejected as the primary
solution: it protects executable hooks but not skills/MCP/other retained paths, and weakens the
reviewed-definition-to-versioned-payload binding.

### D. Documentation-only restart rule

Tell users to close tasks before every update. Rejected: the product can avoid the destructive call
by construction, while documentation alone reproduces today's opaque failure on the first missed step.

### E. Host-owned immutable generation leases

Codex pins each task to immutable N, activates N+1 for new tasks, and garbage-collects N only after
authoritative leases release. This is the ideal seamless-continuity contract and the three lenses'
long-term recommendation. It is OUT of this Genie-only wish because Codex owns cache/session liveness;
TTL, version-count, PID, or mtime heuristics cannot prove a resumable task is dead.

## Decisions

1. **One gate, one permit.** Every entry path uses the same pure classifier; only external real-TTY
   `setup --codex` or the manually accepted Codex step of full setup can mint a process-local permit.
2. **Delivery is not activation.** Normal/post-delivery/already-current update and install may deliver
   or sync but never activate. Pending exits 2; broken/indeterminate exits 1; current exits 0.
3. **Quick and automation never consent.** `CODEX_THREAD_ID`, every `--quick` form,
   `--no-interactive`, CI, and non-TTY/piped I/O refuse before any activation-side mutation.
4. **Direction carries no implicit authority.** Explicit channel downgrade writes a minimal receipt
   bound to from-version, target, canonical digest, and channel; it still needs setup consent.
   Installed-newer without a matching receipt fails closed. Binary rollback is binary-only.
5. **Pending is derived; destructive recovery is journaled.** The intent phases are `planned`,
   `command-started`, `removal-observed`, and `ambiguous-absent`. After command start, failure is
   broken/retry and N is not promised to survive.
6. **Codex owns its cache and trust.** Genie uses supported CLI commands and performs no cache surgery
   or hook-trust read/write/copy/approval; host leases remain upstream/OUT.
7. **Installed behavior gates success.** Safe full parity, enabled-state restoration, and the exact H3
   smoke must pass before clearing the intent and requiring `/hooks` plus a new task.
8. **Rollback preserves the gate inductively.** A backup is restorable only when its SHA-256-bound,
   no-shell capability probe matches its sidecar, reports protocol >=1, and supports any live intent
   schema. First-fixed→pre-contract refuses before mutation; later fixed→fixed may proceed.
9. **Intent is untrusted input.** Validate registration versions before comparison and validate every
   intent field/binding. Invalid/stale intent grants only safe quarantine authority, followed by a
   fresh observation and authorization decision.

## Final state table

The first matching row wins and the fallback makes classification total. “Setup” below always means a
fresh permit from the external real-TTY gate; refusal returns authorization-required exit 2 with zero
mutation while preserving the underlying classified state.

| State | Exit | Mutation authority | Recovery/result |
|---|---:|---|---|
| `query-failed` | 1 | None | Repair Codex query |
| `registration-version-invalid` | 1 | None | Missing/invalid version is not absent or comparable |
| `unsafe-cache-symlink` | 1 | None | Operator repairs through Codex; never follow/surgery |
| `unsafe-cache` | 1 | None | Operator repairs unsafe root/topology |
| `intent-invalid` | 1 | Quarantine only | Corrupt/unsupported schema grants no recovery authority |
| `intent-mismatch` | 1 | Quarantine only | Stale from/target/digest/direction/command/receipt grants none |
| `intent-target-current` | 2 | Setup, no add/remove | Fresh assertion; enabled/parity/H3 recheck, clear journal |
| `intent-ambiguous-absent` | 1 | Setup | Gated supported-CLI reconcile; N unknown |
| `intent-removal-observed` | 1 | Setup | Continue add/verify; N is gone |
| `intent-command-started` | 1 | Setup | Query and idempotently reconcile; N unknown |
| `intent-planned` | 2 | Setup | Fresh assertion, then resume before first command |
| `registration-absent` | 2 | Setup | Explicit install/activation |
| `cache-missing` | 1 | Setup | Supported reinstall only |
| `payload-mismatch` | 1 | Setup | Fail closed; supported repair then parity |
| `pending-downgrade-explicit` | 2 | Setup | Name N/T and assert retirement |
| `installed-newer` | 1 | None | Explicit channel delivery must create matching receipt |
| `activation-pending` | 2 | Setup | N is present-unverified; retire→setup→hooks→new task |
| `current` | 0 | None | No mutation |
| `snapshot-inconsistent` | 1 | None | Total fail-closed fallback |

Intent schema/binding validation is exact: validated from/target versions, canonical digest, derived
direction, allowed command, phase-compatible registration, and exact receipt binding. A bad safe
Genie-owned intent can only be atomically quarantined by a journal-only permit; a new snapshot and
authorization decision are then mandatory. Target-current dominates phase/current rows and finalizes
without a cache-advancing command.

Pending reruns create/advance no intent and repeat stable state/action values. Consent refusal is an
authorization result, not a changed classifier state. Exit 2 always includes `deliveryComplete`.
`doctor --json` preserves existing `{ok,checks}` and additively emits
`integrationSummary:{schemaVersion:1,codexPlugin:{...}}` with classifier state, authorization,
action-required, delivery-complete, and recovery; stderr is only for unmodeled process failure.

Downgrade receipts contain a CSPRNG 128-bit `receiptId` as 32 lowercase hex characters, copied exactly
into downgrade intents and validated with from/target/digest/channel. Success deletes intent then the
matching receipt; a crash leaves no reusable authority.

Fresh-binary `--post-delivery-converge` may classify but has no permit; its parent maps pending to exit
2. Legacy `--sync-only` is separate: it never queries or mutates plugin registration/cache, exits 0
regardless of activation state, and is nonzero only when agent sync itself fails.

H3 is the sole current `SessionStart` hook: spawn
`node <physical-T>/scripts/session-context.cjs` without a shell, with a 5 s timeout and 64 KiB output
cap. Child cwd and JSON `cwd` are the same temp repo containing one `activation-smoke` DRAFT wish;
sanitized environment sets `PLUGIN_ROOT` and unsets CI/thread/update variables. Require exit 0, empty
stderr, and exact context `slug=activation-smoke status=DRAFT groups=1 criteria=0/1 blocked=false`.
Only the temp fixture may be written; no workspace/cache/trust/network/Codex side effects are allowed.

## Lens synthesis

- **Simplifier/architecture:** mutable stable launchers and Genie-owned cache retention violate the
  immutable reviewed-generation boundary; use host leases or an honest restart contract.
- **Operator/DX:** H3-only diagnostics are insufficient; update must distinguish delivered, pending,
  activated, and broken states and must never print an all-green footer when warnings exist.
- **Deployer/supply-chain:** old reviewed bytes must never alias to new bytes; without host liveness,
  automatic GC is unsound. The Genie-only design therefore owns no cache retention or cleanup.

## Risks and assumptions

- **Operator ignores pending activation:** update output and doctor must keep the state visible and
  actionable without claiming the plugin is current.
- **External-terminal activation while tasks remain open:** Genie cannot prove global liveness; the
  fresh retirement confirmation is an operator assertion and transaction authority, not proof. If the
  operator later resumes N, recovery is `/hooks` review plus a new task.
- **Canonical payload and installed plugin temporarily differ:** this is deliberate and diagnosable;
  old cache stays intact until activation.
- **Codex changes plugin CLI/cache behavior:** physical pre/post verification and fixtures fail closed;
  Genie still does not assume ownership of the host cache.
- **Activation fails after a plugin command starts:** the host may already have pruned N; the durable
  phase reports broken/retry and recovery uses the gated supported CLI, never a preservation claim.
- **Pending N lacks its old comparator:** doctor reports safe presence only; fixture before/after
  evidence proves Genie did not mutate it without claiming runtime integrity.
- **User-tier skills and role-agent warnings remain:** they are genuine but use a different ownership
  mechanism and must not inflate this wish.
- **Claude uses a different plugin protocol:** no shared cache abstraction is introduced.

## Success criteria

- Every normal/post-delivery/already-current update, downgrade/rollback, install, setup/quick, sync,
  and intent-recovery path reaches one pure classifier/gate; activation mutators require its permit.
- Given registered N and canonical N+1, delivery/install paths invoke no cache-advancing command,
  report N `present-unverified`, and fixture snapshots prove those commands did not mutate N.
- Update installs and verifies the signed delivery, prints `Codex activation pending`, installed and
  target versions, and the exact `retire tasks → genie setup --codex → /hooks → new task`
  sequence, then exits 2 so automation cannot claim full convergence.
- Pure truth-table tests cover every state above; human/JSON output obeys the stable schema and 0/1/2
  contract, and pending reruns are idempotent.
- Registration versions are validated before comparison; corrupt/unsupported and stale/mismatched
  intents grant no recovery authority; target-current finalization uses fresh consent and no add/remove.
- Activation refuses with zero activation-side mutation under thread, quick, noninteractive, CI,
  piped/non-TTY, decline, or EOF; a fresh external real-TTY assertion is never treated as liveness proof.
- Successful setup preserves enabled state, verifies parity, passes the exact 5 s H3 schema, and then
  requires `/hooks` plus a new task. Post-command failures are broken/retry through the four-phase intent.
- Trust spies prove no hook-trust read/write/copy/approval. Explicit downgrade receipt, installed-newer
  refusal, binary-only rollback, `--post-delivery-converge`, and legacy sync-only semantics are tested.
- A first fixed release refuses its pre-contract backup before mutation even with registration/consent;
  later rollback passes only with matching digest/sidecar/probe and compatible intent schema. Tamper,
  probe failure, interruption, and rerun fixtures prove the floor.
- An update→resume regression fixture reproduces the old missing-module failure against the pre-fix
  policy and proves the retained task continues to resolve generation N under the new policy.
- H4/H6 trust remains explicit: changed definitions are never auto-approved or inspected by activation,
  and operator-facing text requires `/hooks` review plus a new task.

## Follow-up boundaries

1. **Managed-surface ownership reconciliation:** user-tier skill collisions and missing role-agent
   inventory need an adoption/preview policy.
2. **Claude convergence truth:** disabled `.6` plugin plus stale direct skill fanout needs reconciliation
   against existing `agent-sync` / `routing-delivery-fix` scope before creating new work.
3. **Codex host generation leases:** immutable per-task generation pinning plus authoritative release/GC
   would later replace the retirement boundary with seamless continuity.

## Investigation log

- Complete: binary/plugin/cache inventory and source-to-cache byte parity.
- Complete: retained `.6` process paths versus deleted cache; missing-module reproduction.
- Complete: exact `.1` H3 replay from canonical and cache roots (exit 0).
- Complete: current update state machine and live Codex plugin CLI surface inspected.
- Complete: simplifier/architecture, operator/DX, and deployer/supply-chain lens review; synthesis above.
