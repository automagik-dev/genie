# Design: ACP correctness and opt-in direct mode

| Field | Value |
|---|---|
| **Slug** | `mikro-acp-correctness-direct-mode` |
| **Date** | 2026-08-31 |
| **WRS** | 100/100 |

## Problem

ACP can turn timeout, cancellation, provider, empty-response, budget, or validation failures into false success and can mutate failed turns non-transactionally. Operators also need an explicit one-completion direct path without changing loop defaults or the ACP capability surface.

## Scope

### IN

- Replace answer-shaped root aborts with one exact success/error union consumed by every root caller.
- Select ACP execution only with prompt-scoped `MIKRO_ACP_MODE=loop|direct`; unset means `loop`, and every other exact value fails before provider invocation.
- Add a direct-specific request builder and exactly one bounded provider completion with no REPL, tools, recursion, retry, forced-final call, or direct-to-loop fallback.
- Freeze criteria, `VALIDATE.md`, structured-output, timeout/cancellation, token/cost, iteration, and depth behavior.
- Persist only accepted ACP turns through clone → sibling temp → atomic replace → in-memory swap.
- Prove nine exact local and exact-SHA remote ACP journeys without changing initialize, capability, or session wire shape.
- Deliver prefix-safe commits: root result contract → direct/error boundary → transactional store → protocol/read-back gate.

### OUT

- Changing the default, YAML `acp.mode`, ACP Session Modes advertisement, `session/set_mode`, wire-protocol mode selection, direct-to-loop fallback, tools/recursion in direct mode, context-root behavior, or best-effort persistence on non-ACP callers.

## Root execution contract

After a caller has selected a mode and loaded/validated configuration, the root entry point returns `Promise<RootRunResult>` and does not encode a failure in `answer`, `budgetHit`, or thrown provider text. Programmer invariant violations may still throw; all expected root-runtime outcomes below must be values. ACP selector and configuration-load failures happen before root invocation and use the separate ACP-boundary union defined below, so they never fabricate provider/model/budget metadata.

```ts
type RunMode = "loop" | "direct";
type RunErrorCode =
  | "cancelled"
  | "timeout"
  | "setup"
  | "provider"
  | "empty_response"
  | "max_tokens"
  | "max_cost"
  | "max_iterations"
  | "max_depth"
  | "accounting_incomplete"
  | "validation";

type RunUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalCost: number;
  llmCalls: number;
};

type RunBudgetState = {
  maxTokens: number | null;
  maxCost: number | null;
  maxIterations: number | null; // null in direct mode
  maxDepth: number | null;      // null in direct mode
  observedTokens: number;       // inputTokens + outputTokens, all in-universe calls
  observedCost: number;         // all in-universe provider-reported cost
  observedIterations: number;   // root provider calls; direct is 0 or 1
  observedDepth: number;        // root is 0; deepest child actually entered
  accountingComplete: boolean;  // false means some started spend is unknowable
};

type RunMeta = {
  mode: RunMode;
  provider: string;
  model: string;
  elapsedMs: number;
  usage: RunUsage;
  budget: RunBudgetState;
};

type RootRunSuccess = RunMeta & {
  ok: true;
  answer: string;
  references: string[];
  validation: "not_configured" | "passed";
};

type RootRunError = RunMeta & {
  ok: false;
  answer?: never;
  references?: never;
  error: {
    code: RunErrorCode;
    phase: "setup" | "completion" | "budget" | "validation";
    message: string;
    retryable: boolean;
    limit?: number;
    observed?: number;
    cause?: { name: string; message: string }; // setup/provider only; no stack on wire
    validationErrors?: string[];               // validation only
    accountingScope?: "provider_call" | "child_subtree"; // accounting_incomplete only
  };
};

type RootRunResult = RootRunSuccess | RootRunError;
```

`max_iterations`, `max_depth`, and validation shape failures are not retryable. `cancelled` is caller-directed and not retryable by the current turn. `timeout`, `setup`, `provider`, `empty_response`, `max_tokens`, `max_cost`, and `accounting_incomplete` are marked retryable because a later independently initiated turn may change environment, input, provider health, or limits. `accounting_incomplete` is nevertheless terminal and fail-closed for the current run: it means a started provider call supplied no usage or a hard-killed recursive process could not supply a complete subtree envelope. Its metadata contains only known usage, sets `accountingComplete:false`, identifies the unknown scope, and never substitutes zero or estimated spend. Root `setup` starts only after validated config and resolved provider/model exist (for example, provider-client or request setup); ACP config discovery, read, parse, and validation failures are `config_setup` boundary errors instead. No error carries a candidate/partial answer.

The root code-to-phase mapping is exact; callers and protocol tests assert this table rather than inferring a phase from control flow:

| `error.code` | `error.phase` |
|---|---|
| `setup` | `setup` |
| `cancelled`, `timeout`, `provider`, `empty_response` | `completion` |
| `max_tokens`, `max_cost`, `max_iterations`, `max_depth`, `accounting_incomplete` | `budget` |
| `validation` | `validation` |

### Terminal precedence and latching

One terminal state is latched to stop new work. Cleanup may replace that latch only with higher-precedence `accounting_incomplete` when started spend cannot be known; it never resumes work. Execution within each process is serialized: before every local provider start or child-process start, that process checks its own accrued ledger and the limits/deadline it owns; immediately after the one started operation settles, it merges the returned usage and re-checks before later work. A parent does not issue live permits to descendant provider calls. Instead, while no sibling or parent provider call is active, it may admit one child with a single hierarchical lease containing the parent's then-remaining cost and token allowances, remaining depth, and the root's immutable absolute `deadlineEpochMs`. The child owns admission and accounting for its complete subtree under that lease. The parent waits, accepts one complete subtree envelope, merges it exactly once, and only then considers later work.

1. Incomplete accounting wins: a started provider call without reported usage or a child that cannot return a valid complete subtree envelope is `accounting_incomplete`. This is the sole cleanup-time override: a hard kill cannot be reported merely as cancellation/timeout because its spend is unknown.
2. Otherwise, an explicit caller cancellation observed before success is committed wins over every in-flight outcome, including a simultaneous timer/provider rejection.
3. Otherwise, a reached wall-clock deadline wins over provider/setup/empty/budget/validation outcomes. If cancellation and deadline are observed in the same event-loop turn, cancellation wins.
4. Otherwise, setup or provider failure is classified by where it occurred.
5. Otherwise, a response whose visible text is empty after `trim()` is `empty_response`.
6. Otherwise, budget failures win in fixed order `max_cost` → `max_tokens` → `max_depth` → `max_iterations`; the first already-latched breach is retained across later checks.
7. Otherwise, `VALIDATE.md` failure is `validation`.
8. Only the remaining path is success.

The root computes `deadlineEpochMs` once at invocation from its configured timeout; descendants receive that unchanged absolute value rather than a fresh duration and derive their local remaining timer from it. The deadline includes selector-independent setup and all loop/direct provider work. The root accepts an `AbortSignal`; cancellation or deadline aborts the active provider request and signals the one active recursive child. Cooperative cleanup waits up to the implementation's fixed `CHILD_ABORT_GRACE_MS` for that child to stop new admissions, settle its active descendant/provider, and return one valid complete envelope; if it does, the parent merges the envelope once before returning the already-latched cancellation/timeout. When the grace expires, the parent terminates the child process tree, escalates to a hard kill after the fixed `CHILD_TERM_GRACE_MS`, and bounds its final reap wait. A hard-killed, malformed, or silent child may have incurred unreported spend: the parent does not fabricate or merge an envelope, sets `accountingComplete:false`, and returns terminal `accounting_incomplete` with `accountingScope:"child_subtree"`. There is no provider or child-process start after a local terminal state is latched, no parent/sibling work while a child lease is outstanding, and no forced-final call after loop exhaustion.

## Direct request and completion contract

Direct mode uses a dedicated `buildDirectRequest`, not `buildSystemPrompt` and not raw `SYSTEM.md` alone. It creates exactly these inputs:

1. A system message beginning with `config.system` byte-for-byte.
2. If `config.criteria` exists, append `\n\n## Output Criteria\n\nFollow these criteria in your answer:\n` plus the criteria byte-for-byte. The loop-only phrase “when providing your FINAL answer” is not used.
3. If `config.validate` exists, append a direct-only schema section containing its raw schema block and the instruction “Return only JSON matching this schema.” It must not mention `FINAL`, `FINAL_VAR`, the REPL, tools, or retries.
4. One user message containing the effective prior-turn conversational query followed by the actual loaded context: string context is included verbatim; list context is rendered deterministically in existing item order as `--- <path> ---\n<content>`; absent context adds no context section. Direct cannot receive metadata in place of content because it has no REPL/storage query path.
5. The provider/model, thinking configuration, cache configuration where the provider supports it, and `config.output.schema` are passed exactly as resolved for loop mode. No Mikro tool definitions or provider tools are supplied.

Captured-request tests compare provider/model/options, the raw system prefix, criteria bytes, prior-turn/query bytes, context bytes/order, and structured-output schema. They also assert that loop-only stop-protocol, custom-tool, storage/REPL, `FINAL`, and recursion instructions are absent from direct requests.

Direct performs one provider request. A non-empty provider response is the candidate answer without rewriting or stripping. `config.output.schema` remains provider-enforced. `VALIDATE.md` is independently checked once after completion with the existing trim/single-fence JSON normalization; if both schemas exist, both contracts apply. A failed check returns `validation` with validation errors, discards the candidate, and makes no retry. `CRITERIA.md` is prompt guidance only and has no post-completion classifier. Direct reports `observedIterations: 1`, `observedDepth: 0`, and direct iteration/depth limits as `null`.

## Budget, iteration, depth, and exhaustion semantics

### Serialized hierarchical accounting

The root reports one accounting universe, but ownership is hierarchical rather than a live cross-process root permit service. Each process owns a local ledger for provider calls it starts directly. A parent may have only one operation active: one local provider call or one child lease. At child admission it snapshots a lease with `maxTokens` and `maxCost` equal to the parent's positive remaining declared allowances (or `null`), `maxDepth` reduced for the child, and the unchanged root `deadlineEpochMs`. The child owns those limits for its whole subtree, may issue one further serialized lease using its own remaining values, and returns exactly one complete envelope containing its subtree-only `RunUsage`, deepest entered depth, and success/error. The parent does not mutate its ledger while the child is active; it validates and merges that envelope exactly once before inspecting the child outcome or starting anything later.

Included calls are loop and direct root completions; every `llm_query` item; every item of `llm_query_batched`; `web_search`; `fetch_url`; `generate_image`; every provider call made by an `rlm_query` or `rlm_query_batched` child; and the same categories recursively at every descendant depth. `RunUsage.llmCalls` increments once at actual provider start, regardless of success, empty output, provider rejection, cancellation, timeout, or later candidate discard.

Excluded because they do not start a provider are REPL execution, `pg_search`, `pg_slice`, `pg_time`, `pg_count`, `pg_query`, request construction, validation, persistence, and a provider-gated tool request rejected before invocation. Cache-read/cache-write/reasoning tokens remain visible in their dedicated `RunUsage` fields and provider cost, but `maxTokens` counts only reported input plus output tokens so cache tokens are not counted twice. Generated image/media bytes and local child-process CPU are not tokens; any provider-reported image charge is still included in `totalCost`. Calls made outside a root run, such as config discovery, are outside this result's ledger; benchmark comparison arms each enter the root contract and receive their own complete ledger.

Every included provider call, at any process level, uses this executable sequence without an exact pre-dispatch tokenizer:

1. **Admit from accrued state:** on the serialized local path, re-check the local terminal latch, propagated cancellation, absolute root deadline, accrued reported cost, accrued reported input-plus-output tokens, root-iteration allowance when this is a root completion, and depth when this is a child spawn. If accrued cost or tokens are already at/above the local declared ceiling, refuse the start. A child may be admitted only when no local provider or sibling child is active and both remaining declared allowances, when configured, are positive.
2. **Cap provider output:** compute `remainingTokens = maxTokens - observedTokens` when a token ceiling exists. Pass the provider an explicit output `maxTokens` equal to `min(existing request/model output cap, remainingTokens)`; with no declared token ceiling, retain the existing request/model cap. If the resulting cap is not positive, return `max_tokens` before network dispatch. This contract deliberately does not claim knowledge of serialized input tokens: the provider's input usage is known only after settlement.
3. **Start and account:** increment `llmCalls`, start exactly one provider request, and require its settled result—success or error—to include provider-reported usage. Merge reported input tokens, output tokens, cache/reasoning fields, and reported cost before classifying the result. Already-started spend is never rolled back because its candidate is discarded or another terminal state is latched. Missing usage is not recorded as zero and is not estimated; it sets `accountingComplete:false` and terminates as `accounting_incomplete` with `accountingScope:"provider_call"`.
4. **Post-check:** after a complete merge, observe cancellation and deadline first, then provider/empty outcome, then `max_cost` → `max_tokens` → `max_depth` → `max_iterations`. Reaching or crossing a configured cost/token ceiling latches that budget code and discards the candidate. Re-check before validation, returning a tool result, admitting a child, or starting another provider call.

`maxTokens` is cumulative provider-reported input plus output tokens across the accounting universe. Because input tokens are unknown at admission, one admitted serialized provider call may make its local ledger exceed the remaining declared token allowance even though output was capped to that allowance; the post-check fails `max_tokens`, and serialization prevents any later call. A subtree envelope may therefore exceed its lease by at most its one final admitted provider call, after which the parent merges it and fails closed. `maxCost` remains cumulative provider-reported cost: the pre-check blocks starts once accrued cost is at/above the ceiling, while unknown call cost permits overshoot by at most the one serialized in-flight provider call. Direct uses the same accrued admission, output cap, required usage, and post-check.

Both ordinary `llm_query_batched` and recursive `rlm_query_batched` change from `Promise.all` concurrency to deterministic serialization in prompt-index order. For index `i`, admit and await exactly one local provider request or child lease, merge its complete accounting, and run terminal checks before considering `i+1`. A terminal outcome stops the batch and zero later indices start. An explicitly non-terminal child error may produce its failed-tool item and then permit the next indexed child. No sibling cancellation or simultaneous-terminal arbitration remains.

The design was reconciled against the live provider-call inventory at rebased base `d8aea5ccfd91a9f09251e7eee8c09892197a03d7`:

| Live path | Post-change accounting action |
|---|---|
| `src/rlm.ts` root `llmComplete` | Included; accrued-state admission, explicit remaining output cap, required usage merge, and post-check around each loop root completion. |
| `src/rlm.ts` forced-final `llmComplete` | Removed; exhaustion returns `max_iterations`, so this provider start no longer exists. |
| `src/llm.ts` `llmCompleteSimple` used by `llm_query` | Included per request with the local ledger sequence. |
| `src/llm.ts` `llmCompleteBatched` used by `llm_query_batched` | Included per prompt; replace `Promise.all` with prompt-order serialization. |
| `src/llm.ts` `web_search`, `fetch_url`, `generate_image` `llmComplete` branches | Included individually; unsupported-provider branches remain excluded because they start no provider. |
| `src/llm.ts` `rlmQuery` / `rlmQueryBatched` child-process branches | Admit one hierarchical lease with remaining limits and absolute deadline; serialize batch children; require and merge one complete subtree envelope. |
| Recursive child/grandchild root and tool calls | Child owns its subtree ledger and recursively applies the same local sequencing and lease contract. |
| `src/benchmark.ts` raw direct `llmComplete` comparison arms | Replace with direct root entry so each arm has a complete root ledger and exact error union. |
| New ACP direct completion | Included as the sole direct root provider request. |

No other `handleLLMRequest` branch starts a provider: the five `pg_*` branches are local storage operations and unknown/provider-gated errors return before invocation.

- Loop `maxIterations=N` permits at most `N` root provider calls, including validation retries. A valid accepted final from call `N` succeeds. If call `N` does not yield an accepted final, return `max_iterations`; do not make an `N+1` forced-final call.
- Root depth is `0`. A child at depth `d+1` may start only when `maxDepth` is null or `d+1 <= maxDepth`. A denied child start returns `max_depth` without spawning. Direct has no depth budget because it cannot recurse.
- Any cost/token/depth breach ends the whole root run as the corresponding error. It cannot be converted into a best-effort success. Iteration and depth limits are not silently copied into direct mode.

## Caller mappings

Successful loop callers preserve their existing answer, output, footer/stats, and session transcript shapes. Every caller must switch on `ok`; none may inspect answer prose.

| Caller | Success | Root error |
|---|---|---|
| CLI | Existing text/JSON/stream output and exit `0`; existing CLI session artifact is saved. | Exit `1`; save no session. Text writes `[<code>] <message>` to stderr and no answer to stdout. JSON writes the exact `RootRunError` once to stdout. Stream writes one `{type:"error", error, meta}` terminal JSONL event and no `final` event. CLI session-save failure remains best-effort and does not change an already successful non-ACP run. |
| Cache warmup (`src/cli.ts` cache command) | Switch on `result.ok`; only `ok:true` prints `mikro: cache warmup complete` and the provider/model/token/TTL/cost footer, then returns with exit `0`. | On `ok:false`, print `[<code>] <message>` to stderr, print no completion/footer, set exit status `1`, and return. Empty response, exhaustion, provider/setup failure, and every other root error are failures; no catch or answer-shape check may relabel them as a primed cache. |
| MCP | Existing content, `structuredContent`, footer, transcript append, and `isError:false`. | Return tool content `[<code>] <message>`, the existing session id in `structuredContent`, and `isError:true`; append no turn. A pre-session/setup failure uses the existing text-only `isError:true` result. |
| Batch | Preserve the existing successful per-question JSONL line byte shape. | Emit one `{question,error,stats}` line where `error` is the exact root error object and `stats` contains partial usage/iterations; continue with the next independent question. `completed` counts successes only; aggregate adds `failed` and exits `1` after emitting the aggregate if any item failed. The batch-wide cost stop still prevents starting later questions. |
| Cost/Oolong benchmark | Record the existing benchmark row only when both comparison arms succeed. | Abort on the first failed arm, print `[<code>] <message>` with question id to stderr, emit no partial totals/result document, and exit `1`; a failed run is never scored as an answer. |
| Recursive child | Child `--output json` serializes one exact, complete subtree `RootRunResult`. Parent accepts `ok:true` only as an `rlm_query` answer and merges its usage once. | Parent merges a valid complete child envelope exactly once, then applies the terminal/non-terminal classification below. Missing/malformed output, missing usage, or hard kill is terminal `accounting_incomplete`; no envelope is fabricated. Only an explicitly non-terminal child result from a complete envelope becomes a recoverable failed-tool result. Child error JSON or stderr is never a successful answer. A depth denial occurs before process spawn. |
| ACP | Buffer answer-bearing updates, persist, then flush the accepted answer and return `{stopReason:"end_turn"}`. Progress/tool updates may remain live. | `cancelled` returns `{stopReason:"cancelled"}`, emits no later answer chunk, and persists nothing. ACP-boundary `invalid_mode` is JSON-RPC `-32602`; ACP-boundary `config_setup`, persistence failure, and every non-cancellation root error are JSON-RPC `-32603`. Each carries `data.mikro=<AcpTurnError>`, emits no answer chunk, and persists no turn. |

For ACP, a cancellation notification is idempotent. A cancellation for a non-active or different session is a no-op. Cancellation aborts the actual root/provider signal rather than only closing the event drain; after complete cooperative accounting, the prompt resolves `stopReason:"cancelled"`, not as an ordinary JSON-RPC error. If cancellation requires a hard kill or provider usage is missing, accounting integrity wins and ACP returns the normal non-cancellation JSON-RPC mapping for `accounting_incomplete`. Disconnect uses the same path and cannot persist or continue background model/child work.

### Recursive child terminality and settlement

A parent admits at most one recursive child at a time. The lease carries positive remaining token/cost allowances, remaining depth, the unchanged root `deadlineEpochMs`, and cancellation propagation. It is a one-time ownership transfer for the duration of that child: the child—not the root—serially admits provider calls and grandchildren against its subtree ledger. The parent performs no provider call, child spawn, or batch sibling while the lease is outstanding. Cooperative completion is a valid single stdout envelope containing the exact child `RootRunResult`, complete subtree-only usage/cost, and `accountingComplete:true`; the parent validates it and merges it once before any outcome handling or later work.

The terminal child codes are `max_cost`, `max_tokens`, `max_depth`, and `accounting_incomplete`. Root cancellation propagated into a child is terminal as root `cancelled`; reaching the shared absolute deadline is terminal as root `timeout`. After a complete envelope merge, the parent re-runs cancellation, deadline, cost, and token checks in root precedence. A child budget failure or a merged parent ceiling breach latches the corresponding root failure and starts no later work.

On cancellation or deadline, the child must cooperatively stop admitting work, propagate the signal to its sole active provider/grandchild, settle it, and return a complete envelope within `CHILD_ABORT_GRACE_MS`. If it does, the parent merges once and returns the cancellation/deadline outcome. If cooperative settlement fails, the parent uses the bounded terminate/hard-kill/reap sequence defined above. Since hard-killed subtree spend may be unknown, there is no synthetic error envelope and no zero-filled usage: known parent usage remains, `accountingComplete` becomes false, and the current run fails closed as `accounting_incomplete`. No later provider, child, validation, success, or persistence work starts.

The explicitly non-terminal child codes are `setup`, `provider`, `empty_response`, `validation`, and `max_iterations`, plus a child-local `timeout` only when `deadlineEpochMs` has not been reached and the root abort signal has not fired. Only a valid complete envelope with one of those codes may become a structured recoverable failed-tool result. Child `cancelled` is not recoverable without a separately documented child-local cancellation API, which is out of scope. A malformed envelope, missing usage, missing cost accounting, abnormal exit without a complete envelope, or hard kill is always `accounting_incomplete`, never a recoverable provider/setup result.

## ACP mode selection

At the start of every `session/prompt`, before config loading, request building, provider invocation, event streaming, or store mutation, read `process.env.MIKRO_ACP_MODE` again:

- `undefined` → `loop`
- exact `"loop"` → `loop`
- exact `"direct"` → `direct`
- `""`, whitespace-only, padded values, different case, or any other value → `invalid_mode`

There is no trimming, case folding, startup cache, YAML precedence, ACP request parameter, capability advertisement, or fallback.

Selector and config loading are owned by the ACP prompt boundary, before `rlmLoop`/direct root invocation:

```ts
type AcpBoundaryError =
  | {
      ok: false;
      error: {
        code: "invalid_mode";
        phase: "selector";
        message: string;
        retryable: false;
      };
    }
  | {
      ok: false;
      error: {
        code: "config_setup";
        phase: "setup";
        message: string;
        retryable: true;
        cause: { name: string; message: string }; // no stack on wire
      };
    };
```

`invalid_mode` uses `phase:"selector"`, `retryable:false`, and JSON-RPC `-32602`. A config discovery/read/parse/validation failure uses `code:"config_setup"`, `phase:"setup"`, `retryable:true`, a sanitized `cause`, and JSON-RPC `-32603`. Neither boundary error has `RunMeta`, because no provider/model or root budget exists yet. The boundary catches and converts these expected failures before the root union is entered; zero provider calls, updates, validation work, or store mutation follow either error.

## Transactional ACP persistence

A model answer is not an accepted ACP turn until persistence succeeds. Persistence failure therefore fails the prompt with JSON-RPC `-32603`; `persistence` is an ACP-boundary code, not a root execution code:

```ts
type AcpPersistenceError = {
  ok: false;
  error: {
    code: "persistence";
    phase: "persistence";
    message: string;
    retryable: true;
    cause: { name: string; message: string };
  };
};
type AcpTurnError = RootRunError | AcpBoundaryError | AcpPersistenceError;
```

The JSON-RPC error carries `data.mikro=<AcpTurnError>`. The candidate answer and answer-bearing updates are discarded. This is intentionally stricter than CLI session-save behavior.

For an accepted root success, `appendTurn` performs exactly:

1. Deep-clone the current `StoredSession`; cap and append the original user query plus accepted answer only to the clone, apply `MAX_TURNS`, and update the clone timestamp.
2. Serialize the clone and write it to a unique sibling temp file in the same directory as the final session file.
3. Atomically rename/replace the temp file over the final path.
4. Immediately, with no intervening `await` or fallible work, replace `SessionState.record` with the clone.

The live record is never mutated in place. Temp creation/write/close/rename is enclosed in cleanup that unlinks the temp on every failure; missing-temp cleanup is ignored, but the original error is retained. Any failure before successful replace leaves original disk bytes and in-memory turns unchanged. After replace, the synchronous in-memory assignment is the non-failing commit completion; no fallible work runs between them. Only then may ACP flush buffered answer chunks and return `end_turn`. Fault-injection gates cover clone/serialize, temp open/write/close, and rename failures, assert byte-for-byte disk equality and deep-equal in-memory state, and assert no `*.tmp` remains.

## Prefix-safe delivery and rollback

The commits are ordered dependencies, not independently revertible changes:

1. root result contract and all existing caller translations;
2. direct builder, selector, cancellation, and ACP error boundary;
3. transactional ACP store and buffered-answer commit ordering;
4. protocol golden, nine journeys, documentation, generated artifacts, and exact-SHA read-back.

Every commit and every delivered prefix must build and pass its focused gate. If commit `k` fails, roll back only the failing suffix `k..n` in reverse order; retain the already-correct prefix `1..k-1`. Never retain a later commit without its required prefix and never claim arbitrary middle-commit reverts are safe.

## Nine exact ACP journeys

Each journey captures outbound JSON-RPC frames, provider request count/body, update sequence, returned stop/error, store bytes, in-memory turns, temp-file set, and process exit. Dynamic ids/timestamps are normalized only in the golden comparator.

1. **Unset → loop success:** start with `MIKRO_ACP_MODE` absent; initialize → `session/new` → prompt; assert the loop provider fixture reaches an accepted final, `stopReason:"end_turn"`, one persisted turn, and the captured loop request remains the existing successful baseline.
2. **Explicit loop → loop success:** set exact `loop` before prompt; run the same transcript and assert journey 1's provider requests, updates, result, and stored turn are identical after normalization.
3. **Direct → one completion:** set exact `direct`; prompt once; assert exactly one provider request, direct captured-request contract, one answer chunk only after persistence, `end_turn`, and zero REPL/tool/recursive events or child processes.
4. **Invalid selector matrix:** for `""`, `" "`, `" direct"`, `"direct "`, `"DIRECT"`, `"Loop"`, and `"bogus"`, prompt and assert JSON-RPC `-32602` carrying `invalid_mode`, zero provider requests/updates/store writes, and byte/deep-equal disk and memory.
5. **Environment changes in one process:** one session and process runs prompts with env absent, then `direct`, then `loop`, then invalid; assert mode/request counts `loop`, `direct`, `loop`, failure respectively and that only the first three turns persist.
6. **Terminal outcome matrix:** deterministic fixtures separately trigger ACP config read/parse/validation failure, root cancellation, timeout, post-config setup/provider rejection, three/one terminal empty response as applicable to loop/direct, max-cost, max-token, max-iteration, max-depth, provider missing usage, malformed/missing child envelope, cooperative child completion, bounded child hard kill, and `VALIDATE.md` failure. Assert the exact phase mapping: `setup→setup`; `cancelled|timeout|provider|empty_response→completion`; `max_tokens|max_cost|max_iterations|max_depth|accounting_incomplete→budget`; `validation→validation`. Inventory fixtures exercise root, `llm_query`, ordinary `llm_query_batched`, `web_search`, `fetch_url`, `generate_image`, `rlm_query`, recursive `rlm_query_batched`, and a grandchild provider call. For each provider path, assert accrued-state refusal, output `maxTokens` capped to the current remaining allowance, reported input-plus-output merge, `llmCalls`, one admitted-call maximum token overshoot, missing-usage fail-closed behavior, and candidate discard at a ceiling. Batch fixtures assert strict prompt-index start/settlement order for both ordinary and recursive paths. Recursive fixtures prove lease contents (remaining cost/tokens/depth plus unchanged `deadlineEpochMs`), child-owned subtree admission, one complete envelope merged once before later work, cooperative cancellation settlement, bounded terminate/hard-kill/reap, no fabricated hard-kill envelope, terminal latching, and zero later starts; each explicitly non-terminal child code returns a recoverable failed-tool result only from a complete envelope. Assert no forced-final call, no answer chunk/store mutation; cancellation with complete accounting returns `stopReason:"cancelled"`, while hard-kill/missing-usage cancellation returns `accounting_incomplete` through the specified JSON-RPC error.
7. **Restart + `session/load`:** complete and persist one accepted turn, stop the ACP process, start a new process with the same store, initialize → `session/load` → prompt; assert the provider request contains the prior turn exactly once and the second accepted turn atomically persists.
8. **Unchanged protocol transcript:** golden initialize/authenticate/`session/new`/`session/load`/prompt transcript against the pre-change baseline; assert protocol version, capability object, session response shapes, absence of Session Modes/`session/set_mode`, and stdout framing are unchanged apart from normalized ids/timestamps and the already-specified prompt outcomes.
9. **Exact-SHA remote identity:** build/install and launch the remote artifact from the reviewed commit SHA (never a moving branch/tag), record package version plus commit SHA, verify artifact/source hashes against the local reviewed SHA, then rerun journeys 1–8 with the same fixtures and golden/read-back assertions. Any identity mismatch fails before functional claims.

## Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Direct inherits loop-only instructions or drops real context | High | Dedicated builder plus captured-request positive and negative assertions. |
| Timeout/cancellation races provider completion or forced final | High | Latched precedence, shared `AbortSignal`, fake clock, and zero-post-terminal-call assertions. |
| Budget overshoot is mistaken for accepted success | High | Accrued-state admission, remaining output cap, required post-call usage, candidate discard, and explicit one-serialized-call token/cost overshoot. |
| Hard-killed child spend is reported as known | High | Bounded cooperative/terminate/hard-kill sequence; absent complete envelope becomes fail-closed `accounting_incomplete` with no synthetic usage. |
| Persistence failure leaks an answer or mutates memory | High | Buffer answer updates; clone/temp/replace/swap; fault injection and byte/deep-equality checks. |
| Mode leaks into ACP capabilities | High | Exact unchanged protocol golden and no mode methods/fields. |
| Ordered commits are reverted out of dependency order | Medium | Prefix gates and reverse suffix rollback only. |

## Success criteria

- [ ] `RootRunResult` matches the exact union, precedence, metadata, and mappings above for CLI, cache warmup, MCP, batch, benchmark, recursive child, and ACP; ACP selector/config failures use the metadata-free boundary union rather than invalid root metadata.
- [ ] Cancellation aborts real work; ACP returns `stopReason:"cancelled"` after complete cooperative accounting, while missing usage or hard kill returns fail-closed `accounting_incomplete`; timeout/cancellation races make no later provider call.
- [ ] Direct captured requests satisfy the builder contract, perform exactly one provider completion, and emit zero REPL/tool/recursive work.
- [ ] Hierarchical accounting covers root, all provider-backed loop tools, recursive children, and descendants: each process serializes local work, leases one child its remaining cost/token/depth plus unchanged absolute deadline, receives one complete subtree envelope, and merges once before later work.
- [ ] Both ordinary and recursive batch paths execute in prompt order; provider admission uses current accrued tokens, caps output `maxTokens` to the remaining declared allowance, merges reported input plus output after settlement, permits at most one admitted-call token overshoot, and treats missing usage as terminal `accounting_incomplete`.
- [ ] Cooperative children return complete accounting before the parent continues; bounded hard kill never fabricates an envelope or spend and fails closed with incomplete accounting.
- [ ] Every root code has the exact phase in the mapping table, and the journey matrix asserts every code.
- [ ] Criteria, `VALIDATE.md`, structured output, token/cost, iteration/depth, and exhaustion behavior match the frozen semantics above.
- [ ] Loop successful output/protocol/session journeys remain compatible; every root error exits/maps honestly and persists no turn.
- [ ] ACP persistence is clone → temp → atomic replace → memory swap; every injected pre-replace failure leaves disk and memory unchanged and cleans temp files; persistence failure fails the turn before answer delivery.
- [ ] All nine local journeys pass, and exact-SHA remote identity reruns the same assertions.
- [ ] Each commit prefix builds and passes its focused gate; rollback guidance is prefix-safe reverse suffix removal.

## Next step

After this FIX loop is validated, the orchestrator may send the amended design to a separate reviewer. This fixer performs no review.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `88854b36a3987fffd06b4b17d0d2c2a51c585418cd9ed03c646f4fcdf51dac79`
- **Reviewer:** `openai-codex:gpt-5.6-sol-900k`
- **Reviewed at:** `2026-09-01T05:32:35Z`
<!-- genie-design-review:end -->
