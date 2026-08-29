# Design: Genie dual-mode Orca plugin — Option A

| Field | Value |
|-------|-------|
| **Slug** | `genie-dual-mode-orca-plugin` |
| **Date** | 2026-08-29 |
| **WRS** | 100/100 |

## Problem

Genie's repository SQLite database and git-tracked roadmap are currently its lifecycle authority. In Orca
mode, Orca must instead be the single lifecycle authority, reached only through Orca's documented public CLI.
The integration must not create an injection surface, depend on private host APIs, preserve the retired MCP
architecture, or maintain a local mirror that can diverge. At the same time, existing users who do not use
Orca must retain today's standalone behavior.

This design is authoritative for Option A. The dirty `v6/corpo-leve` checkout and its staged artifacts are
historical evidence only. Its typed-host-API, Linear, and named/obsolete-model assumptions are not adopted.

## Scope

### IN

- A global, schema-validated `orchestration.mode` in `<GENIE_HOME>/config.json` with exactly `standalone`
  and `orca`. `standalone` is the backwards-compatible default; entering `orca` is always explicit.
- One central mode resolver and two fail-closed barriers in Orca mode:
  1. a **database pre-open barrier** that refuses before per-repository lifecycle SQLite is opened, created,
     migrated, or written; and
  2. a **roadmap pre-write barrier** that refuses before roadmap sync, export, replacement, or any other
     write can change `.genie/roadmap.json`.
- Coverage of all writable entrypoints, including indirect `task`, `board`, sync/export, and former MCP
  paths. A missed caller cannot bypass the low-level barriers.
- A Genie-owned Orca plugin whose complete lifecycle transport is `orca orchestration <verb> ... --json`,
  launched as an argv vector through the platform process API with shell evaluation disabled.
- A compiled positive allowlist of public orchestration verbs and verb-specific input/response schemas.
- Deterministic Orca runtime resolution, bounded execution, JSON receipts, mutation read-backs, typed errors,
  and operator-actionable diagnostics.
- Parity-first retirement of `genie mcp`, the Genie MCP server/tools/launchers, and only registrations proven
  to be Genie-owned.
- Plugin manifests, marketplace metadata, install/update/rollback/uninstall and mode-switch behavior,
  `doctor` reporting, release inventory/tarball validation, and user/contributor documentation.

### OUT

- A typed Orca host API, internal RPC, private host calls, direct Orca database access, or an Orca fork.
- Shell command strings, `shell: true`, raw argv supplied by a caller, terminal input injection,
  `orca orchestration dispatch`, `dispatch --inject`, or any terminal-send equivalent.
- A local fallback when Orca is selected; a second lifecycle store, cache, queue, retry ledger, task mirror,
  or roadmap mirror; and background synchronization between Genie and Orca.
- Migrating or deleting existing Genie databases, roadmaps, boards, or Orca Run/Task/Dispatch records. Mode
  changes select authority for future operations; they do not rewrite history.
- Requiring Linear, telemetry, a daemon, a named model, v6 prototype skill routing, or an upstream Orca idea.
- A generic process runner, caller-selected executable path, arbitrary flags, remote orchestration protocol,
  or configurable command allowlist.

## Approach

Implement authority selection before integration. Every process resolves the mode once through a shared
resolver, but every dangerous low-level seam still enforces the resolved mode. In `standalone`, current
database and roadmap behavior is unchanged. In `orca`, local lifecycle reads and writes that imply local
authority return one stable `local_lifecycle_disabled_in_orca_mode` error before filesystem mutation. The
Orca plugin then translates validated operations into a finite public-CLI argv grammar and treats Orca's
JSON response as the external authority.

The plugin is an adapter, not an orchestration implementation. It holds no lifecycle state. A successful
process exit without a valid receipt is failure; a valid mutation receipt whose read-back disagrees is also
failure. Transport failure never switches mode and never invokes Genie local state.

## Public CLI boundary

The initial capability table is closed and versioned with the plugin. Each row names the only accepted
public CLI verb and its post-mutation proof. Verbs absent from the table are unavailable even if the
installed Orca version supports them.

The adapter accepts exactly the semantic inputs below. Required inputs are unbracketed; bracketed inputs are
optional. The emitted flag column is exhaustive: the adapter owns the executable, the `orchestration`
prefix, argument order, and one final `--json`; callers cannot supply any other flag or positional value.

| Public verb | Accepted semantic inputs | Exact emitted flags, in order | Post-mutation proof |
|-------------|--------------------------|-------------------------------|---------------------|
| `run-create` | `objective` | `--objective <text>` | `run-show --id <receipt.runId>` |
| `run-list` | `[limit]`, `[cursor]` | `[--limit <limit:1..100>] [--cursor <cursor>]` | Validated read envelope |
| `run-show` | `id` | `--id <run-id>` | Validated identified read envelope |
| `run-current` | none | none | Validated identified read envelope containing the invoking terminal's current Run binding |
| `run-use` | `id` | `--id <run-id>` | `run-current` and verify both the requested Run ID and the requested invoking-terminal binding |
| `task-create` | `spec`, `[title]`, `[deps]`, `[parent]` | `--spec <text> [--task-title <text>] [--deps <task-id-array>] [--parent <task-id>]` | `task-list`, locate `receipt.taskId`, and compare immutable fields |
| `task-list` | `[status]`, `[ready]`, `[brief]` | `[--status <task-status>] [--ready] [--brief]` | Validated read envelope |
| `task-update` | `id`, `status`, `[result]` | `--id <task-id> --status <task-status> [--result <task-result>]` | `task-list`, locate the requested ID, and compare status/result |
| `worker-start` | `task`, `agent`, `[model]`, `[effort]`, `[timeoutMs]` | `--task <task-id> --worktree current --agent <agent> [--model <model-id> [--effort <effort>]] [--timeout-ms <timeout-ms:250..600000>]` | `worker-show --dispatch <receipt.dispatchId>` |
| `worker-show` | `dispatch` | `--dispatch <dispatch-id>` | Validated identified read envelope |
| `worker-read` | `dispatch`, `[source]`, `[cursor]`, `[limit]` | `--dispatch <dispatch-id> [--source <worker-source>] [--cursor <cursor>] [--limit <limit:1..100>]` | Validated bounded read envelope |
| `worker-release` | `dispatch` | `--dispatch <dispatch-id>` | `worker-show --dispatch <requested-id>` and verify the public released/retained terminal disposition |
| `send` | `subject`, `[body]`, `[type]`, `[priority]`, `[threadId]`, `[payload]` | `--subject <text> [--body <text>] [--type <message-type>] [--priority <priority>] [--thread-id <thread-id>] [--payload <send-payload>]` | Validated bounded mutation receipt; receipt-only exception because the allowed public subset has no stable message-by-ID read |
| `check` | `[ack]`, `[unread]`, `[peek]`, `[all]`, `[types]`, `[wait]`, `[timeoutMs]` | `[--ack <delivery-id>] [--unread\|--peek\|--all] [--types <message-type-csv>] [--wait [--timeout-ms <timeout-ms:250..600000>]]` | Validated bounded read envelope |
| `reply` | `id`, `body` | `--id <message-id> --body <text>` | Validated bounded mutation receipt; receipt-only exception because the allowed public subset has no stable message-by-ID read |
| `ask` | exactly one of `question` or `resume`, `[options]`, `[timeoutMs]` | `--question <text>\|--resume <message-id> [--options <option-csv>] [--timeout-ms <timeout-ms:250..600000>]` | Validated answer/pending receipt; recovery resumes the same message ID |
| `gate-create` | `task`, `question`, `[options]` | `--task <task-id> --question <text> [--options <option-array>]` | `gate-list --task <requested-task>`, locate `receipt.gateId`, and compare question/options |
| `gate-list` | `[task]`, `[status]` | `[--task <task-id>] [--status <gate-status>]` | Validated read envelope |
| `gate-resolve` | `id`, `resolution`, `task` | `--id <gate-id> --resolution <text>` (`task` is proof context and is not emitted) | `gate-list --task <task-id>`, locate the requested gate ID, and compare resolved status/resolution |

The placeholders above name these closed, versioned scalar and structured domains; they are not open extension
points:

- Every Run, Task, Dispatch, Delivery, Message, Thread, and Gate ID is 1-128 ASCII characters matching
  `[A-Za-z][A-Za-z0-9_-]*`. A cursor is 1-512 printable ASCII characters, excluding whitespace, control
  characters, a leading `-`, and shell metacharacters. A model ID uses the same cursor grammar with a 128-byte
  maximum. Limits are integers from 1 through 100; timeouts are integers from 250 through 600,000 milliseconds.
- `<text>` means normalized UTF-8 with no NUL or unpaired surrogate: objective/spec/body/result summary/resolution
  are 1-16,384 bytes, title/subject/question are 1-512 bytes, and option/phase/path values are 1-256 bytes.
  Optional text, when present, cannot be empty. Boolean fields are actual booleans, never string coercions.
- Task status is exactly `pending | ready | dispatched | completed | failed | blocked`; gate status is exactly
  `pending | resolved`; message type is exactly `status | dispatch | worker_done | merge_ready | escalation |
  handoff | question | decision_gate | heartbeat`; priority is exactly `low | normal | high | urgent`; worker
  source is exactly `auto | transcript | terminal`; agent is exactly `claude | codex | cursor | droid | gemini |
  grok | opencode`; and effort is exactly `low | medium | high | xhigh`. `check.types` is a unique, non-empty
  subset of the message-type domain, serialized in caller order as CSV. `ready`, `brief`, `wait`, and exactly one
  of `unread | peek | all` are booleans; `timeoutMs` is accepted only with `wait` for `check`.
- `deps` is a unique array of 0-64 Task IDs. Ask options are 1-10 unique option strings; gate options are a JSON
  array with the same domain. `result` is either absent or the exact object `{ summary, artifacts? }`, where
  `summary` is bounded result-summary text and `artifacts` is a unique array of 0-32 bounded path values.
  `send.payload` is either absent or the exact object `{ taskId?, dispatchId?, phase?, outcome?, filesModified?,
  reportPath? }`: IDs use their domains, `phase` is bounded phase text, `outcome` is `succeeded | failed`,
  `filesModified` is a unique array of 0-128 bounded path values, and `reportPath` is one bounded path value.
  Payload requires at least one property; extra properties and JSON `null`, numbers, nested objects, or arrays
  other than the two named arrays are rejected. All JSON objects reject duplicate keys and all structured
  values must serialize to at most 32 KiB.
- `worker-start.effort` requires `model`; `ask` accepts exactly one of `question` or `resume`, and options only
  with `question`. Every array is copied after validation and has the per-item bounds above; sparse arrays,
  duplicate entries, non-string elements, and extra object fields are invalid.

`dispatch`, `dispatch-show`, terminal handles as message destinations, `worker-stop`, `worker-abandon`,
`worker-retain`, `reset`, and every other unlisted verb are outside the plugin. Adding a verb requires a
design amendment, schema/argv/response tests, threat review, and a new plugin compatibility version.

For each listed verb, a discriminated TypeScript input schema accepts only documented semantic fields. The
adapter constructs `["orchestration", verb, ...validatedArguments, "--json"]` internally. Structured field
values are JSON-serialized only for flags whose documented CLI grammar requires JSON. Unknown fields,
unknown flags, positional spillover, values containing a flag in place of data, raw argv, command strings,
and a caller-provided `--json` are rejected before process launch. The adapter appends exactly one final
`--json` and never interpolates values into a shell program.

Contract tests cover every row and must negatively prove rejection before spawn of malformed IDs/cursors/text,
out-of-range limits/timeouts, unknown enum members, duplicate/out-of-domain array members, sparse or oversized
arrays, malformed JSON, duplicate JSON keys, `null`, wrong JSON scalar types, excess nesting/size, and missing or
extra `result`/`send.payload` fields. They also reject all terminal flags
(`--terminal`, terminal handles, `--format`), setup/placement flags (`--setup`, `--worktree` from callers,
`--name`, `--repo`, `--base-branch`), routing/impersonation flags (`--on`, `--to`, `--run`, `--from`,
`--dispatch-capability`, `--takeover-legacy`), executable selection or wrapper inputs, raw argv/command
strings, recovery-only `--retry-request`, caller-supplied `--json`, and every unknown flag or field. Values
are also tested against flag-shaped substitution. The sole emitted `--worktree current` is an adapter
constant for `worker-start`, never caller input or a general placement surface.

## Runtime, receipts, and failure contract

Runtime resolution is deterministic and resolved once per invocation:

1. use the host-provided `ORCA_CLI_COMMAND` only when it is a single validated executable token (not an argv
   string, shell fragment, relative traversal, or wrapper plus flags);
2. otherwise select `orca-ide` on Linux outside an Orca-managed terminal, `orca.exe` on Windows, or `orca`
   on macOS and Orca-managed terminals; and
3. do not try a second candidate after selection fails.

The packaging spike must verify the actual plugin host exposes safe child-process execution. If it does not,
Option A fails with `unsupported_environment`; it must not substitute a typed host API, internal RPC, or local
fallback. Runtime discovery and supported-platform policy are documented in one module and manifest range.

Execution uses the platform's spawn-equivalent with `shell: false`, a fixed timeout, a fixed combined output
cap, explicit environment inheritance policy, and termination followed by bounded reap. stdout must contain
exactly one valid Orca JSON envelope; stderr is bounded diagnostic context and never parsed as success.
Secrets and unbounded payload bodies are redacted from logs and error objects.

Mutations require all of the following:

1. exit status zero within the deadline;
2. a schema-valid JSON success envelope containing an operation/entity identifier;
3. for create/change operations with a public read path, an immediate allowlisted read-back matching that
   identifier and requested immutable fields; and
4. a normalized receipt returned to the caller with verb, Orca identifiers, runtime/version metadata, and
   timestamps, but no second-store persistence.

The named read-back probes are `run-current` after `run-use`, `gate-list --task` after `gate-resolve`, and
`worker-show` after `worker-release`; their response schemas must expose enough public state to prove the
requested effect. In particular, `run-current` must return the requested Run ID and a coordinator terminal
identity equal to both the binding reported by `run-use` and the runtime-attested invoking terminal; `run-show`
alone is not proof of terminal binding. If a supported Orca compatibility range lacks one of those public fields,
that mutation is unsupported for that range unless a narrow design amendment documents why no public read exists
and permits a receipt-only exception for that verb. Today the only receipt-only mutations are `send` and `reply`, whose
allowed public subset has no stable message-by-ID read. Mutations are never retried automatically because a
timeout can hide a committed mutation. Recovery names the exact allowed public read command that can
establish state before another mutation, or identifies the documented receipt-only ambiguity.

The stable error taxonomy is:

- `unsupported_platform` / `unsupported_environment`
- `executable_unavailable` / `incompatible_cli_version`
- `invalid_operation` / `invalid_argument`
- `timeout` / `output_limit`
- `process_exit`
- `malformed_json` / `unexpected_response`
- `missing_receipt` / `readback_mismatch`
- `local_lifecycle_disabled_in_orca_mode`

Every error includes the safe operation name, phase, retry-safety classification, and recovery hint. It does
not include an executable search fallback, raw secrets, or an instruction to switch silently to standalone.

## Dual-mode authority barriers

The database barrier belongs below command routing, immediately before the first writable/opening SQLite
primitive. In Orca mode it prevents file creation, WAL/SHM creation, schema inspection that migrates, and
implicit initialization. Read-only code that relies on the local lifecycle DB is also refused because serving
stale local state would imply competing authority.

The roadmap barrier belongs at the final common write seam and is also checked before any sync/export
calculation with side effects. In Orca mode tests snapshot existence and bytes before calls and prove no file,
temporary file, rename, lock, or timestamp change occurs. Both barriers are defense in depth: entrypoints
return friendly errors, while the low-level seams make omissions safe.

Mode switches are explicit, validated, backup-first, atomic, and idempotent. Switching to Orca preflights the
packaged plugin and compatible CLI before committing config. Switching to standalone requires explicit user
intent and does not import Orca state. A failed preflight leaves the prior config and authority unchanged.

## MCP retirement and lifecycle sequencing

MCP retirement is the final implementation change. It occurs only after standalone lifecycle preservation,
Orca mode barriers, plugin packaging and real-runtime smoke, install/update/rollback/uninstall and mode-switch
fixtures, release inventory and every supported tarball check, and operator/contributor documentation have
landed and are green. Its slim PR removes only the server, tools, launchers, and registrations with Genie
ownership proof, updates the already-landed migration documentation, and leaves release mechanics to the
preceding packaging PR. An old `genie mcp` invocation returns a stable deprecation diagnostic and non-zero
exit; it does not start a compatibility server. Upgrade and rollback fixtures prove that unrelated MCP
registrations and user configuration survive.

Install and update stage payloads, verify versions and inventory, preflight the selected mode, then atomically
activate. Rollback restores the prior Genie-owned payload/config snapshot. Uninstall removes only owned files
and registrations and never deletes lifecycle data from either authority. Plugin and marketplace versions
match `package.json`; stable remains the default channel and every supported release tarball is built and
inspected before promotion.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | `standalone` is the default; `orca` is explicit. | Existing installs do not change authority because Orca happens to be present. |
| 2 | Enforce Orca mode before DB open and roadmap write. | Command hiding alone cannot stop indirect initialization or sync side effects. |
| 3 | Refuse local lifecycle reads as well as writes in Orca mode. | Stale reads present a competing source of truth. |
| 4 | Use a compiled subset of official `orca orchestration` argv. | A finite positive boundary is reviewable and excludes generic execution. |
| 5 | Always use no-shell spawn and adapter-owned final `--json`. | Callers cannot append flags or turn data into a program. |
| 6 | Resolve one runtime candidate and never fall through. | Failure cannot silently target a different installation or trust boundary. |
| 7 | Require receipts and public read-back where available. | Exit zero alone does not prove the intended durable mutation. |
| 8 | Never auto-retry ambiguous mutations. | A timeout may have occurred after Orca committed the operation. |
| 9 | Keep no plugin lifecycle store or local fallback. | Orca is the sole lifecycle authority in Orca mode. |
| 10 | Retire MCP only after replacement parity is demonstrated. | Sequencing protects standalone users while eliminating the obsolete surface. |

## Simplicity case

- **Simplest complete design:** two modes, two low-level barriers, and one finite CLI adapter. Orca owns its
  state; standalone Genie owns its existing state.
- **Required machinery:** schemas prevent injection; bounded execution prevents hung/oversized responses;
  receipts and read-backs prevent false success; backup-first transitions preserve user-owned config.
- **Deferred until measured:** remote routing, configurable allowlists/timeouts, retries, caches, native APIs,
  schedulers, and synchronization. A future native Orca API is reconsidered only after it is public, stable,
  and passes the same contract suite.
- **Removed complexity:** no daemon, polling loop, generic runner, mirror database, fallback board, migration
  protocol, Linear bridge, or model matrix.

## Success criteria

- [ ] In isolated `GENIE_HOME` fixtures, absent and explicit `standalone` modes preserve all current task,
  board, and roadmap success/error/idempotency behavior.
- [ ] In `orca` mode, every lifecycle DB route fails before DB/WAL/SHM creation or migration; fixtures prove
  no local lifecycle file appears or changes.
- [ ] In `orca` mode, roadmap sync/export/write routes return the typed refusal and leave existence, bytes,
  metadata, temp files, and locks unchanged.
- [ ] Every emitted process invocation is an allowlisted `orca orchestration` argv vector ending in exactly
  one `--json`, uses `shell: false`, and cannot accept raw argv, unknown flags, `dispatch`, `--inject`, a
  terminal-send surface, internal RPC, or a private API.
- [ ] Each allowlisted verb has schema, exact argv, success envelope, non-zero exit, malformed/unexpected
  JSON, timeout, output-cap, resolution, receipt, and applicable read-back tests; negative argv fixtures for
  every row reject terminal, setup/placement, routing/impersonation, executable override, raw-argv, recovery,
  caller-`--json`, and unknown inputs before spawn.
- [ ] Public contract probes specifically prove `run-use` with `run-current` (requested Run ID and attested
  invoking-terminal binding), `gate-resolve` with `gate-list`
  plus `--task`, and `worker-release` with `worker-show`; a missing public proof field makes that mutation
  incompatible unless a later narrow design amendment documents the absence and receipt-only exception.
- [ ] A packaged-plugin smoke against a real supported Orca runtime creates and reads back a disposable Run/
  Task flow; cleanup uses only allowed public operations. An unavailable/incompatible runtime creates no
  Genie lifecycle state and returns a bounded typed error.
- [ ] Timeout-after-commit tests prove there is no automatic mutation retry and diagnostics direct the
  operator to a read-back before another mutation.
- [ ] `genie mcp` and Genie-owned MCP wiring are retired with a stable non-zero diagnostic; standalone CLI
  parity remains green and no hidden MCP compatibility server starts.
- [ ] Fresh install, update, interrupted update, rollback, uninstall, and both mode switches are repeatable
  and preserve user config, existing Genie data, non-Genie registrations, and all Orca records.
- [ ] Manifests, marketplace, release inventory, `VERSION`, `package.json`, and every supported tarball are
  version-consistent; `doctor` reports mode, resolved runtime, compatibility, and recovery without mutation.
- [ ] Each implementation PR targets `automagik-dev/genie:dev`, follows TDD, passes focused tests plus
  `bun run check`, receives independent review on the exact commit, and has attached CI evidence.

## Independently shippable PR decomposition

Each PR starts from then-current `origin/dev`, has one owner, and is independently reviewable. Dependencies
are shallow; no PR mixes the dirty v6 evidence or unrelated roadmap/Khal changes.

1. **A0 — authoritative design (this PR):** add only this `DESIGN.md`; run design/template validation and
   obtain independent design review before creating a WISH. No PR is opened until that review is authorized.
2. **A1 — mode schema and authority barriers:** config/resolver, DB pre-open guard, roadmap pre-write guard,
   typed diagnostic, and standalone/Orca negative fixtures. Depends only on approved A0.
3. **A2 — closed Orca CLI adapter:** schemas, argv table, runtime resolution, bounded runner, errors,
   receipts/read-backs, and hermetic fake-process tests. Depends only on approved A0 and can proceed beside A1.
4. **A3 — plugin payload and real-runtime smoke:** manifests/marketplace, adapter wiring, compatibility probe,
   and disposable Run/Task smoke. Depends on A2; does not own install transitions.
5. **A4 — lifecycle preservation and transitions:** standalone parity plus install/update/rollback/uninstall,
   mode switching, ownership-preserving fixtures, and `doctor`. Depends on A1 and A3; does not remove MCP or
   change release inventory.
6. **A5 — packaging and release artifacts:** version-consistent manifests/marketplace, release inventory, and
   build/inspection of every supported tarball. Depends on A3 and A4; does not remove MCP or rewrite docs.
7. **A6 — operator and contributor documentation:** mode selection, recovery, compatibility, upgrade,
   rollback, and planned MCP-retirement guidance. Depends on A4 and A5; documentation only.
8. **A7 — MCP retirement:** remove the Genie MCP runtime and proved-owned registrations, retain the stable
   retired diagnostic, update only retirement-specific documentation, and rerun standalone/release parity.
   Depends on A1 through A6 and is independently revertible; no lifecycle, packaging, or release mechanism is
   introduced in this PR.

For code PRs, write a failing focused test first, implement the minimum contract, run the narrow suite, then
run `bun install --frozen-lockfile`, `bun run check`, affected release/smoke tests, and PR CI. An engineer's
self-check is not independent review: a separate read-only reviewer evaluates the immutable commit and cites
its SHA. Fixes receive a fresh review; release promotion remains a separate explicit authorization.

## Risks and assumptions

| # | Risk or assumption | Severity | Mitigation / falsifier |
|---|--------------------|----------|-------------------------|
| 1 | The packaged plugin host may forbid child processes. | High | A3 probes the real host; fail `unsupported_environment`, never change transport. |
| 2 | Orca CLI grammar or envelopes drift. | High | Manifest compatibility range, exact contract fixtures, live smoke, fail closed on unknown shapes. |
| 3 | A writable Genie path bypasses mode routing. | High | Guard low-level seams and independently inventory all DB/roadmap callers in A1 review. |
| 4 | Timeout hides a committed mutation. | High | No automatic retry; return ambiguity plus the public read-back recovery command. |
| 5 | Install/uninstall adopts or removes user-owned state. | High | Ownership proof, backups, atomic transitions, isolated-home fixtures, narrow deletion inventory. |
| 6 | MCP retirement breaks an unrecorded client. | Medium | Inventory first, parity gate retirement, retain explicit diagnostic and rollback path. |
| 7 | Runtime resolution reaches the wrong Orca installation. | Medium | One documented platform choice, validate host override, no candidate fallback, report resolved version. |
| 8 | Dirty v6/Corpo Leve assumptions leak into delivery. | Medium | Every PR starts clean from `origin/dev`; design rejects typed host API, Linear, and named models. |

## Next step

An independent reviewer must review this exact design and return SHIP/FIX-FIRST/BLOCKED plus the reviewed
content SHA-256. Only after the orchestrator authorizes review, persists valid evidence, and verifies the
digest may it open this documentation PR or create the implementation WISH.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** PENDING
- **Reviewed content SHA-256:** PENDING
- **Reviewer:** PENDING
- **Reviewed at:** PENDING
<!-- genie-design-review:end -->
