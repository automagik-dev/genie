# Design: Orchestration CLI truth

| Field | Value |
|---|---|
| **Slug** | `mikro-orchestration-cli-truth` |
| **Date** | 2026-08-31 |
| **WRS** | 100/100 |

## Problem

Mikro advertises an ignored `--parallel` batch option and has an incomplete `--log` journey whose output can be missing calls, partial accounting, terminal evidence, or a durable flush at process exit. The CLI must reject removed concurrency before dispatch and provide a frozen, query-only JSONL contract with deterministic failure and cancellation semantics.

## Scope

### IN
- Remove `--parallel` from help, parser options, `CliOptions`, `BatchOptions`, `--schema`, batch execution, docs, tests, generated output, and compatibility prose.
- Reject raw argv tokens `--parallel` and `--parallel=<anything>` in every position before `parseArgs({ strict: false })`, command resolution, settings/config/provider loading, context reads, or batch work. The separated spelling is rejected from the flag token alone, so its following token can never leak into positionals.
- Keep `--log <path>` query-only, matching current `src/schema.ts`. After parsing and command resolution but before global settings or command dispatch, reject `--log <path>` and `--log=<path>` for every command other than `query`.
- Freeze the JSONL event vocabulary and exact row shapes below, wire currently dormant root-call/subcall/normal-REPL producers, add one failure terminal event, and await logger open, writes, terminal emission, and close.
- Give the query supervisor sole signal ownership, propagate cancellation through the complete query tree, and freeze SIGINT/SIGTERM exits as 130/143.
- Add local and exact-SHA remote-dev read-backs for argument rejection, success, provider failure, returned timeout, empty response, cancellation, validation fail-open, setup failure, logger failures, and REPL/root/subcall/final activity.

### OUT
- Parallel scheduling, a deprecation window, Mikro-owned 429 policy, synthetic #13 reproduction, a logging database, log rotation, or extending `--log` to commands without current code support.
- Changing the deliberate `VALIDATE.md` fail-open policy.

## Approach

### 1. Pre-dispatch argv gates

The first operation in `main()` scans the untouched `process.argv.slice(2)`. Any token equal to `--parallel` or beginning `--parallel=` writes one stable removed-option diagnostic with sequential-batch guidance and exits 2. This gate is independent of token position and runs before `parseArgs`; therefore all of these reject identically with zero settings/config/provider/context/batch work:

- `mikro --parallel 2 batch questions.txt`
- `mikro batch --parallel 2 questions.txt`
- `mikro batch questions.txt --parallel 2`
- `mikro --parallel=2 batch questions.txt`
- `mikro batch questions.txt --parallel=2`

After parsing determines the command, presence of `values.log` with `command !== "query"` writes one stable query-only diagnostic and exits 2 before global settings load or switch dispatch. This applies in every placement and to every non-query command, including `cache`, `batch`, `init`, `config`, `doctor`, `help`, `version`, and `schema`; no command-specific work runs.

### 2. Frozen JSONL contract

Every persisted row has exactly these common fields: `event: string`, `run_id: string`, and an ISO-8601 `timestamp: string`. Event-specific fields are snake_case. Unknown fields are not emitted. The accepted event vocabulary and payloads are:

- `run_start`: required `query`, `model`; optional `tools_level`, `context_type`.
- `cache_init`: required `content_hash`, `session_id`, `estimated_tokens`.
- `llm_call`: required `iteration`, `input_tokens`, `output_tokens`, `cost`, `time_ms`; optional `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `response_model`.
- `llm_subcall`: required `request_type`, `prompts_count`, `input_tokens`, `output_tokens`, `cost`, `time_ms`.
- `child_start`: required `child_correlation_id`, `prompt_preview`, `depth`.
- `child_end`: required `child_correlation_id`, `input_tokens`, `output_tokens`, `cost`, `llm_calls`, `time_ms`; optional `child_run_id`, `is_error`, `error_message`.
- Normal `repl_exec`: required `iteration`, `code_length`, `time_ms`, `has_error`, `has_final`.
- Crash-recovery `repl_exec`: required `crash_recovery: true`, `code_length`, `original_error`; it deliberately remains a distinct historical row shape and does not synthesize `iteration`, `time_ms`, `has_error`, or `has_final`.
- Successful `run_end`: required `iterations`, `total_tokens`, `total_cost`, `time_ms`, `budget_hit`, `answer_length`; optional `validation_failed`, which is emitted only as literal `true`.
- Failed `run_error`: required `error_kind`, `error_message`, `iterations`, `total_tokens`, `total_cost`, `time_ms`, `budget_hit`; `signal` is required only when `error_kind === "cancelled"`.

The literal and closed `run_error.error_kind` enum is:

```text
"provider" | "timeout" | "empty_response" | "cancelled" | "setup" | "logger" | "internal"
```

Null/omission rules are compatibility-frozen:

- `run_end.budget_hit` and `run_error.budget_hit` are always present and are `string | null`; no budget reason is `null`.
- Optional scalar fields are omitted when unavailable; they are not emitted as `null`.
- Historical `child_end.child_run_id` and `child_end.error_message` rows may contain either `null` or an omitted field and remain valid input for consumers. New writes canonicalize unavailable values to omission. No other field permits `null`.
- `validation_failed: false` is never emitted. A schema miss after the allowed retry remains a successful, usable answer represented by `run_end(validation_failed: true)` and exit 0; it never produces `run_error`.
- Existing crash-recovery `repl_exec` rows are preserved rather than normalized. Tests pin both members of the `repl_exec` union.

A successfully closed logged query has exactly one terminal row, and that row is last: `run_end` or `run_error`, never both. A setup failure after logger open may have `run_error` as its first and final row because `run_start` requires config/model data that setup may not produce.

The currently declared but unwired events become real contracts:

- Pass `logger` and the zero-based `iteration` into every root `llmComplete()` call so each accepted root response emits one `llm_call` before any dependent REPL event.
- Emit one aggregate `llm_subcall` from each non-recursive IPC `llm_query`/batched request after its usage is known. Recursive `rlm_query` remains represented by `child_start`/`child_end`, not a duplicate `llm_subcall`.
- Pass `logger` into `REPL.start()` so crash recovery remains observable, and emit the normal `repl_exec` row at each orchestration-owned execution site, including `FINAL_VAR` resolution.

### 3. Exact outcome, precedence, and exit contract

Classification uses one precedence list, evaluated by the query supervisor before terminal commit:

1. A received process signal wins. The first of SIGINT/SIGTERM is frozen; later signals are ignored by the idempotent shutdown path.
2. A logger open/write/end failure wins over every non-signal application outcome because a command must not claim complete logging it cannot prove.
3. A failure before the loop is ready (Python/scaffold/config/context/storage/REPL setup) is `setup`.
4. An abort whose first abort cause is the query deadline is `timeout`, including a provider rejection caused by that deadline.
5. A normal loop return with `budgetHit === "empty_responses"` is `empty_response`.
6. A throw at a root or non-recursive provider boundary is `provider`.
7. Any other uncaught query-orchestration failure is `internal`.

The complete outcome table is:

| Outcome | Terminal row | Exit | Notes |
|---|---|---:|---|
| Ordinary answer | `run_end` | 0 | Includes normal REPL final and direct root final. |
| Cost/token/iteration forced final | `run_end` | 0 | `budget_hit` carries the reason or `null`; this is a usable answer. |
| VALIDATE.md schema miss after retry/forced final | `run_end`, `validation_failed: true` | 0 | Deliberately fail-open. |
| Provider throws/rejects | `run_error(provider)` | 1 | Uses the latest committed partial accounting snapshot. |
| Loop returns timeout sentinel | `run_error(timeout)` | 1 | Returned timeout is not success. |
| Three-empty-response abort | `run_error(empty_response)` | 1 | `budget_hit: "empty_responses"`. |
| SIGINT | `run_error(cancelled)`, `signal: "SIGINT"` | 130 | First signal owns the result. |
| SIGTERM | `run_error(cancelled)`, `signal: "SIGTERM"` | 143 | First signal owns the result. |
| Query setup throws after logger open | `run_error(setup)` | 1 | Zero/partial snapshot as available. |
| Unexpected orchestration throw | `run_error(internal)` | 1 | Closed fallback classification. |
| Logger open/write/end fails | Logical `run_error(logger)` | 1 | Diagnostic is mandatory; see logger failure boundary below. |
| Removed `--parallel` or non-query `--log` | No log is opened | 2 | Pre-dispatch usage rejection; zero command/provider work. |

Logger I/O is the one physical limit on terminal persistence: if opening fails there is no writable log, and if a write/end fails the same failed stream cannot prove a durable `run_error(logger)`. The supervisor still classifies the logical outcome as `logger`, prints a stable stderr diagnostic, exits 1 (unless a signal owns 130/143), and never reports the file as a valid completed log. Tests assert this explicitly rather than inventing a terminal row that storage could not persist.

### 4. Partial-accounting ownership

`runQuery()` owns one mutable `RunAccountingSnapshot` from before setup through shutdown:

```ts
interface RunAccountingSnapshot {
  iterations: number;
  totalTokens: number;
  totalCost: number;
  budgetHit: string | null;
}
```

It starts at `{ iterations: 0, totalTokens: 0, totalCost: 0, budgetHit: null }`. `rlmLoop()` receives a synchronous `onAccountingSnapshot(snapshot)` callback and publishes a copied cumulative snapshot after each iteration is entered, after each root usage merge, after each child/subcall usage merge, and whenever `budgetHit` changes. Only provider responses whose usage was received and committed are counted. `runQuery()` stores the newest copy; logger rows are never the accounting source of truth. Success uses the returned result, while provider/setup/internal/cancel/logger failure uses this owned snapshot. This exact ownership makes partial totals available even when `rlmLoop()` never returns.

### 5. Signal ownership, cancellation, and flush

For a query only, `runQuery()` installs the sole process-level SIGINT/SIGTERM handlers. `PgStorage` and all query-owned children run in managed mode and must not install handlers or call synchronous `process.exit()`; they expose awaited cancellation/cleanup instead.

The supervisor creates one external `AbortController` and passes its signal into `rlmLoop()`. The loop composes it with its deadline while retaining the first abort cause. Cancellation propagates to root provider calls, non-recursive IPC subcalls, recursive child processes, pending REPL execution/recovery, and storage work. Child process groups receive termination and are awaited; REPL, storage, observability, and emitter cleanup each remain idempotent.

All completion paths call one memoized `finish(outcome): Promise<number>`. The first call owns the terminal outcome; concurrent catches, signal handlers, and cleanup calls receive the same promise. `finish` snapshots accounting, attempts exactly one terminal event, awaits the logger's single `close()`, removes signal handlers, and only then assigns `process.exitCode`. It never calls synchronous `process.exit()`. A second signal cannot emit another terminal row, close twice, or replace the frozen 130/143 result.

### 6. Logger durability and error behavior

Replace constructor-side implicit open with an awaited factory/open step. Event methods return promises and serialize writes. A write resolves only after its callback succeeds (and drain completes when required); `close()` is memoized and resolves only after `end`/`finish`. Stream `open`, callback, `error`, `end`, and premature `close` failures reject visibly. Calls after terminal commit or close reject as programmer errors. No-log mode keeps the same async interface as resolved no-ops.

The shipped CLI writes user output only after terminal emission and successful close. Therefore an immediate read after process exit is the durability oracle, not a sleep or polling loop.

### Path ownership boundary

The child wish owns exact allowlists across `src/logger.ts`, query orchestration/LLM/REPL/storage cancellation call sites, `src/cli.ts`, `src/schema.ts`, `src/batch.ts`, focused CLI/logger/batch tests, README/CLI/events/changelog prose, and generated build counterparts. It owns shared CLI/schema/docs paths only in its serialized wave.

## Simplicity Case

- **Simplest complete design:** delete one false flag; finish one existing JSONL file contract.
- **Added machinery:** one closed failure enum, one supervisor-owned accounting snapshot, one cancellation controller, and awaited logger operations are the minimum needed for truthful terminal evidence.
- **Deferred until measured:** multi-command logging and parallel scheduling require separate use cases.
- **Complexity removed:** ignored success, positional leakage, competing signal handlers, partial logs, and inferred failures.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Raw-argv `--parallel` rejection precedes `parseArgs({ strict: false })` | Removing the parser entry alone leaks the separated value into positionals. |
| 2 | Parsed `--log` is rejected for every non-query command before dispatch | Schema and implementation remain query-only. |
| 3 | Existing rows, including crash-recovery `repl_exec`, remain compatible | Consumers can read historical files; new null/omission behavior is explicit. |
| 4 | `run_error` has seven literal kinds and validation is not one of them | Validation remains deliberately fail-open. |
| 5 | `runQuery` owns snapshots via a synchronous loop callback | Partial totals survive throws without making the logger an accounting database. |
| 6 | Query supervisor alone owns signals and terminal commit | Cancellation, cleanup, and 130/143 become deterministic and idempotent. |
| 7 | Logger open/write/end are awaited and failures invalidate completion | Process exit cannot race or falsely certify buffered evidence. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Removed flag becomes query/batch positional input | High | Raw-token tests cover both spellings and every placement with zero dispatch spies. |
| 2 | Overlapping timeout/provider/signal failures classify differently | High | Table-driven precedence tests freeze first abort cause and signal priority. |
| 3 | A throw loses partial usage | High | Snapshot callback tests throw after root and child usage commits and assert terminal totals. |
| 4 | Competing storage handlers bypass flush | High | Managed-storage signal test asserts one owner, one terminal, one close, and no synchronous exit. |
| 5 | Stream failure is hidden or creates duplicate finals | High | Injected open/write/end/error tests assert visible failure and terminal/close idempotence. |
| 6 | Historical rows become unreadable | Medium | Fixture tests pin normal/crash `repl_exec` plus null/omitted `child_end`. |
| 7 | Declared call events stay unwired | Medium | Root, IPC subcall, recursive child, and REPL ordering tests require each distinct producer. |

## Validation and read-back oracles

### Focused local checks

- Local candidate gate: `npm run build` then `npm test` must pass before the focused matrices below run. Retain the focused baseline `node --test dist/tests/schema.test.js dist/tests/batch.test.js dist/tests/session.test.js`; the full shared-runtime suite supplements rather than replaces it.
- Shipped CLI raw-argv matrix asserts both `--parallel` forms in prefix/infix/suffix placements: exit 2, exact sequential guidance, no logger open, and zero settings/provider/context/batch calls.
- Query-only matrix asserts `--log path` and `--log=path` reject on `cache`, `batch`, and at least `doctor` (plus representative help/schema cases): exit 2 and zero command work.
- Success read-back parses every line immediately after exit, verifies exact allowed fields/order, one root `llm_call`, exercised `llm_subcall`/children, normal and crash-recovery `repl_exec` fixtures, and exactly one final `run_end`.
- Failure matrix covers provider throw, returned timeout, empty response, setup throw, internal throw, SIGINT, and SIGTERM; it asserts literal kind, precedence, partial totals, one terminal row, one cleanup, one close, and exits 1/130/143 as specified.
- Validation oracle forces both retry exhaustion and forced-final schema misses and asserts `run_end(validation_failed: true)`, usable output, and exit 0.
- Logger open oracle injects open failure and asserts exit 1, exact stderr, no provider work, and no claim of a valid log.
- Logger write oracle injects failure before and during terminal write and asserts logical `logger`, exit 1, no duplicate terminal attempt, and no success claim.
- Logger end oracle injects `end`/`finish`/premature-close failure and asserts logical `logger`, exit 1, one close attempt, and visible stderr.
- Logger success oracle awaits exit, immediately reads the file once, parses every complete JSONL line, and observes the sole terminal row last; no sleeps/retries are permitted.

### Exact-SHA remote-dev read-back

Record local candidate SHA/tree, remote ref, CI `headSha`, installed remote HEAD, build/test output, and log artifacts. Equality must hold before and after the journey. On that exact installed candidate, run `npm run build` then `npm test` before retaining and running the focused remote-dev matrix: removed-flag and non-query-log rejection, one successful query, one provider failure, and one cancellation. Read each JSONL file immediately after exit and verify the same terminal/exit invariants. Any build or full-test failure, SHA mismatch, missing line, unparsable row, absent terminal, extra terminal, or logger error fails the gate.

## Success Criteria

- [ ] Both `--parallel` forms in all placements reject before parse/dispatch with exit 2 and sequential guidance; no query or batch runs.
- [ ] Both `--log` forms reject on every non-query command before command work; schema/help/docs advertise query-only support.
- [ ] Rows match the exact frozen union, including historical crash-recovery `repl_exec` and null/omitted compatibility rules.
- [ ] Root `llm_call`, non-recursive `llm_subcall`, recursive child events, normal/crash REPL activity, and the terminal row appear in execution order when exercised.
- [ ] Every outcome follows the literal enum, precedence, terminal mapping, and exit table; `validation_failed` remains `run_end` + exit 0.
- [ ] Thrown failures and cancellation report the latest supervisor-owned partial accounting snapshot.
- [ ] One signal owner propagates cancellation, cleanup/terminal/close are idempotent, flush is awaited, and SIGINT/SIGTERM exit 130/143.
- [ ] Open/write/end failure oracles fail visibly without claiming a valid completed log; successful immediate read-back parses all rows and finds exactly one final terminal.
- [ ] The local candidate gate passes `npm run build` followed by `npm test`, then retains and passes the focused baseline and all focused rejection, outcome, accounting, cancellation, logger, and read-back matrices.
- [ ] The exact-SHA remote-dev gate proves installed/candidate identity before and after, passes `npm run build` followed by `npm test` on that installed candidate, then retains and passes focused rejection, success, failure, cancellation, and immediate read-back checks.

## Next Step

After an independent review of this DESIGN returns SHIP and its evidence verifies, run `wish` for `mikro-orchestration-cli-truth` only.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `c949c9ebe57f0f08e96f060ab9a199f470eef6a7f000194edea2078cf3a26139`
- **Reviewer:** `openai-codex:gpt-5.6-sol-900k`
- **Reviewed at:** `2026-08-31T21:58:27Z`
<!-- genie-design-review:end -->
