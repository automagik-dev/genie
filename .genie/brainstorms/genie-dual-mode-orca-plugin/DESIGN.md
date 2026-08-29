# Design: Genie dual-mode Orca plugin — Option A

| Field | Value |
|-------|-------|
| **Slug** | `genie-dual-mode-orca-plugin` |
| **Date** | 2026-08-29 |
| **WRS** | 100/100 |

## Problem

Genie currently treats its per-repository SQLite board and git-tracked roadmap as the lifecycle authority,
but an Orca user needs one Orca-owned lifecycle that is safe to invoke from a Genie-owned plugin without
shell execution, terminal injection, private host APIs, or a competing local store. This must preserve the
supported standalone experience, retire the obsolete Genie MCP service, and make a failed Orca integration
explicit rather than silently returning to local lifecycle state.

## Scope

### IN

- A schema-validated global `orchestration.mode` in `<GENIE_HOME>/config.json` with exactly
  `standalone` (the backwards-compatible default) and `orca`; install, update, rollback, uninstall, and
  explicit mode switching preserve existing user-owned configuration through the repository's backup-first,
  idempotent lifecycle patterns.
- A central mode resolver used before every writable Genie lifecycle entrypoint. In Orca mode it rejects
  `openDb()` before SQLite open/create/schema migration and rejects roadmap sync/export/write before any
  `roadmap.json` write; `task`, `board`, and every former MCP write path surface one typed, actionable
  refusal. Standalone continues to own its existing board/task database and roadmap behaviour.
- A new Genie-owned Orca plugin payload plus Orca marketplace entry. Its sole lifecycle transport is a
  closed TypeScript allowlist of official public `orca orchestration` verbs: `run-create`, `run-list`,
  `run-show`, `run-use`, `task-create`, `task-list`, `task-update`, `worker-start`, `worker-show`,
  `worker-read`, `worker-release`, `send`, `check`, `reply`, `ask`, `gate-create`, `gate-list`, and
  `gate-resolve`.
- Per-verb typed input schemas that construct argv internally, serialize allowed structured values only where
  the documented CLI requires JSON, append a final mandatory `--json`, and reject unknown flags, raw argv,
  shell fragments, terminal handles as destinations, and every unlisted verb. The plugin never invokes
  `dispatch`, including `dispatch --inject`; it never calls a terminal-send surface, internal RPC, or an
  Orca private host API.
- A bounded no-shell execution adapter: deterministic executable resolution chooses a validated
  `ORCA_CLI_COMMAND` supplied by the host when present, otherwise `orca-ide` on Linux, `orca.exe` on
  Windows, and `orca` on macOS; it performs no second-candidate fallback after selection. It captures capped
  stdout/stderr, kills on a fixed timeout, parses exactly the returned JSON envelope, and exposes typed
  `unsupported_platform`, `executable_unavailable`, `timeout`, `output_limit`, `process_exit`,
  `malformed_json`, `unexpected_response`, and `readback_mismatch` errors without treating any as success.
- Mutation safety: every mutator requires a successful Orca JSON mutation receipt; entity-creating/changing
  receipts are immediately re-read through the matching allowlisted public read verb and checked against the
  returned identifier and requested immutable fields. `send`, `reply`, and resolution operations retain the
  bounded receipt as their operation proof when the public CLI offers no entity read-back. The plugin stores
  no lifecycle cache, retry ledger, or fallback queue: Orca's Run/Task/Dispatch records are the only source
  of lifecycle state.
- Retirement of `genie mcp`, its server/tool/launcher wiring, and only Genie-owned MCP registrations after
  the standalone CLI and Orca plugin paths have parity coverage. A retired invocation fails with a stable,
  documented deprecation error; it never launches a hidden compatibility MCP server.
- Versioned distribution: release file inventory, plugin manifest, Orca marketplace, tarball verification,
  installer/updater/rollback/uninstaller integration, ownership checks, mode-aware doctor output, and concise
  contributor/user documentation including operational receipts and recovery boundaries.

### OUT

- Forking Orca; shipping or depending on a private typed host API; waiting for or contributing to upstream
  Ideas discussion 17239. That discussion is advisory input only.
- Shell strings, `exec`/`spawn` with `shell: true`, terminal input injection, `dispatch --inject`, terminal
  send, undocumented RPC, direct Orca database access, or any second Genie lifecycle/board/roadmap store in
  Orca mode.
- Migrating or deleting existing `.genie/genie.db`, `.genie/roadmap.json`, user boards, or Orca Run/Task/
  Dispatch records. Mode changes alter authority for future commands only.
- Requiring Linear, an obsolete named model, old v6 skill-prototype routing, telemetry, a daemon, or a
  background synchronizer.
- Arbitrary third-party commands, arbitrary executable paths, remote orchestration servers, or a general
  process-execution API for plugins.

## Approach

Introduce one explicit global mode decision and enforce it at the lowest write-capable Genie seam, then make
the Orca plugin a narrow adapter over the already public `orca orchestration ... --json` CLI contract. The
mode barrier comes first, so an Orca-mode process cannot accidentally create, migrate, write, sync, or export
the old local authority while a new plugin is being installed or while its executable is unavailable. The
plugin is not a reimplementation of Orca orchestration: it translates validated extension requests into a
finite list of structured argv vectors, reports Orca receipts/read-backs, and stops on errors.

The rejected alternatives are: the staged v6 design's typed host API (unavailable and contrary to Felipe's
selection); a shell command string (injection boundary); `dispatch --inject` or terminal-send (terminal
injection and unsupervised lifecycle); internal RPC/direct database access (unstable private boundary); a
local task mirror or fallback board (two sources of truth); and an Orca fork/upstream wait (unneeded delivery
dependency). Ideas discussion 17239 confirms this smallest public-CLI shape but cannot delay it.

## Simplicity Case

- **Simplest complete design:** two explicit modes, one fail-closed Genie guard, and one plugin adapter whose
  command table is compiled into the package. Orca remains lifecycle authority in Orca mode; Genie retains
  its present local authority in standalone mode.
- **Added machinery:** a mode resolver is required to mechanically prevent accidental local writes; a finite
  argv schema table is required because plugin input may be user-originated; bounded process output/timeouts
  and mutation read-back are required to make a CLI boundary reliable and auditable; installation transition
  records reuse the existing Genie lifecycle facilities because user-owned configuration must survive
  interrupted updates.
- **Deferred until measured:** remote/multi-server routing, workflow scheduler policy, configurable command
  allowlists, retry queues, command-result caches, and a native Orca API adapter. Reconsider native transport
  only after Orca ships a stable public plugin API with parity tests; reconsider retries only after a measured
  transient-error pattern that receipts/read-back cannot resolve.
- **Complexity removed:** no daemon, polling loop, synchronization protocol, new lifecycle database, local
  fallback, generic process runner, feature flag matrix, or upstream fork.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | `standalone` is default; `orca` is an explicit global config value. | Existing installs remain working without migration or inferred environment mode. |
| 2 | The mode guard executes before `openDb()` and every roadmap write boundary. | Command-level hiding cannot prevent indirect writable opens or sync side effects. |
| 3 | Orca mode refuses local lifecycle commands instead of reading or falling back. | One lifecycle authority is an invariant, not a best-effort preference. |
| 4 | The plugin's compiled allowlist is the entire command capability; `dispatch` is absent. | A positive finite boundary is reviewable and mechanically excludes terminal injection. |
| 5 | Plugin inputs become argv only through verb-specific schemas, and the adapter owns the final `--json`. | No caller can append flags, remove JSON mode, or turn data into a shell program. |
| 6 | Use `spawn`/equivalent with `shell: false`; platform resolution makes one selection and never falls through. | This prevents injection and avoids silently targeting a different Orca runtime. |
| 7 | Receipts plus immediate public-CLI read-back confirm durable mutations. | Exit zero alone is insufficient evidence for an external lifecycle mutation. |
| 8 | MCP is removed in a parity-first follow-on after mode/plugin tests land. | Its wide ownership should not obscure the safety boundary or break standalone CLI behaviour. |
| 9 | Mode-aware lifecycle installation owns only Genie payload/registration/config entries and uses backup-first CAS-like transitions. | Updates, rollback, uninstall, and mode switches must preserve user files and never remove Orca records. |
| 10 | Discussion 17239 is cited as advisory compatibility evidence, not a dependency. | The accepted product decision and current public CLI are sufficient to deliver. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Orca plugin hosts may not permit child-process execution despite the current worker environment. | High | Probe through the packaged plugin against a real Orca runtime; report typed unsupported environment and never substitute host APIs or local state. |
| 2 | CLI grammar or JSON envelope changes. | High | Pin engine compatibility in the manifest, centrally test each allowlisted argv/response contract, and fail closed on unrecognized envelopes. |
| 3 | A missed writable Genie path writes in Orca mode. | High | Guard central open/write seams, add negative fixtures for DB creation/schema and roadmap bytes, and independently review all `openDb`/roadmap writer call sites. |
| 4 | Process hangs or returns excessive/partial output. | Medium | Fixed timeout, kill, byte cap, one JSON envelope parse, and typed diagnostics with no retry queue. |
| 5 | Installer or uninstaller adopts/removes user-owned plugin data. | High | Existing ownership proofs, backups, idempotency fixtures, and a policy that only Genie-created registrations/payload paths are removable. |
| 6 | MCP removal reaches more clients than expected. | Medium | Inventory registrations first, retire only proven Genie-owned entries, retain standalone CLI parity, and ship a documented deprecation refusal. |
| 7 | Existing staged v6/Corpo Leve work is accidentally incorporated. | Medium | Every PR starts at current `origin/dev`; dirty checkout remains evidence and the plan explicitly rejects its non-authoritative assumptions. |

## Success Criteria

- [ ] With an isolated `GENIE_HOME`, fresh and existing repositories in `standalone` execute all supported
  board/task and roadmap behaviours unchanged, including success, error exit code, stderr, and idempotency
  fixtures for the new configuration surface.
- [ ] In explicit `orca` mode, attempts that would reach `openDb()` fail before DB creation/schema migration
  and task/board/MCP write routes; roadmap sync/export/write attempts leave `roadmap.json` byte-identical and
  return the documented typed refusal.
- [ ] The packaged plugin exposes no generic command runner and tests prove every emitted command is an
  allowlisted `orca orchestration` argv vector ending in `--json`, launched with no shell; all prohibited
  terms/surfaces (`dispatch`, `--inject`, terminal-send, internal RPC) are absent from executable paths.
- [ ] Each supported command has schema, success, unknown-argument, malformed JSON, non-zero, timeout,
  output-limit, executable-resolution, and receipt/read-back tests. Mutating operations prove their receipt
  and the corresponding public CLI read-back or documented receipt-only exception.
- [ ] A real supported-platform Orca smoke proves plugin-to-public-CLI communication; an unavailable or
  incompatible runtime returns a bounded typed failure and creates no Genie lifecycle state.
- [ ] `genie mcp` and Genie-owned MCP wiring are retired with a stable diagnostic, while standalone CLI
  behaviour and supported skills remain working; no hidden MCP compatibility server starts.
- [ ] Install, update, rollback, uninstall, and both mode switches are repeatable in isolated homes; they
  preserve boards/roadmap/configuration and all non-Genie Orca data, restore from a failed transition, and
  leave payload/manifests/release tarballs version-consistent.
- [ ] Every PR targets `automagik-dev/genie:dev`, has focused TDD evidence, independent review on the exact
  commit, PR-attached CI, and the repository full gate; no PR is merged or release mutated without Felipe.

## Delivery DAG and Review Strategy

The authoritative WISH will encode these shallow groups; each is an independently reviewable PR and uses a
fresh clean worktree based on its declared dependency's current `origin/dev` head. The first group writes no
runtime code and establishes the reviewable contract.

1. **P0 — Option-A design and WISH**: this design, independent design review/evidence, template-scaffolded
   WISH, independent plan review/evidence, and contributor docs for the policy. It gates all feature work.
2. **P1 — mode guard**: config schema/resolver plus pre-open DB and roadmap-write barriers with isolated
   `GENIE_HOME` fixtures. It depends on P0 and can merge independently.
3. **P2 — Orca plugin core**: new plugin/marketplace package, closed command schemas, no-shell runner,
   resolution, parse/taxonomy, receipts/read-backs, and adapter unit/real-Orca smoke. It depends on P0 and
   can run in parallel with P1.
4. **P3 — MCP retirement**: delete/retire the server, launchers, and proved-owned registrations while keeping
   standalone CLI parity. It depends on P1 and P2 so there is already a safe Orca alternative and a central
   mode barrier.
5. **P4 — lifecycle packaging and docs**: install/update/rollback/uninstall/mode-switch transitions, doctor,
   release inventory/tarball checks, and user/contributor documentation. It depends on P2 and P3.

The verified canonical-roadmap hash repair from the dirty source checkout is useful but unrelated to this
feature contract. It may be recreated as a tiny independent `fix(roadmap)` PR from clean `origin/dev`, with
its own focused tests and review; it neither blocks nor joins these PRs. The unrelated Khal rebrand cleanup
is not adopted.

For each code group, the engineer writes a focused failing test first, implements only the matching contract,
runs the narrow test, then runs `bun install --frozen-lockfile`, `bun run check`, and the affected release or
smoke tests. A separate read-only reviewer inspects the immutable commit; no engineer self-reviews. PR CI is
created against `dev` and monitored through its attached checks; full release/tarball validation stays in P4.

## Next Step

An independent reviewer must evaluate this design, return the exact reviewed-content SHA-256, and the
orchestrator must persist and verify that evidence before creating the WISH.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** PENDING
- **Reviewed content SHA-256:** PENDING
- **Reviewer:** PENDING
- **Reviewed at:** PENDING
<!-- genie-design-review:end -->
