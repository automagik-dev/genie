# mikro SDK — Overview

The mikro SDK lets you build **declarative, observable, resumable AI
agents** from a folder of markdown + tool plugins. It sits alongside the
existing mikro CLI (`mikro "query"`) — the CLI path keeps running the
recursion engine in `src/rlm.ts` unchanged, while the SDK exposes a
finer-grained, programmatic surface for consumers who want to drive the
loop from their own code.

## Layer diagram

```
┌────────────────────────────────────────────────────────┐
│ Consumer code  (genie, brain, your app)                │
└─────────────────────────▲──────────────────────────────┘
                          │   runAgent(config) → EventStream
                          │
┌─────────────────────────┴──────────────────────────────┐
│ Driver seam (IterationDriver)                          │
│  • rlmDriver()       — live LLM via llmCompleteSimple  │
│  • your own async*   — canned / tests / custom         │
└─────────────────────────▲──────────────────────────────┘
                          │
┌─────────────────────────┴──────────────────────────────┐
│ runAgent wire (src/sdk/agent.ts)                       │
│  emits AgentStart → IterationStart → (Message |        │
│        ToolCallBefore → ToolCallAfter)* → EmitDone |   │
│        Error → IterationOutput → SessionClose          │
│  runs: permission chain, validate retry, session ckpt │
└─┬─────────▲─────────▲─────────▲──────────▲─────────────┘
  │         │         │         │          │
  ▼         │         │         │          │
┌────┐  ┌───┴──┐  ┌───┴────┐ ┌──┴─────┐ ┌──┴──────┐
│Ev. │  │Sess. │  │Permis- │ │Validate│ │Metrics  │
│SDK │  │API   │  │sion    │ │prim.   │ │recorder │
│(12 │  │+File │  │hooks   │ │+retry  │ │(depth-  │
│type│  │Store │  │chain   │ │once    │ │aware)   │
└────┘  └──────┘  └────────┘ └────────┘ └─────────┘
```

## Design principles

**Additive SDK surface.** SDK capabilities live under `mikro.sdk.*` and
consumers opt in. The default MCP backend also uses the shared declared-tool
loaders and REPL bridge; the ad-hoc `mikro "query"` path remains compatible.

**Pluggable seams.** When SDK and default-backend behavior meet existing mikro
pieces (LLM transport, the REPL), they share loaders and resolver
contracts. The REPL tool bridge is additive to the existing LLM-request path.

**Events as the observability contract.** The 10 wish-spec event types
(plus session lifecycle) are the sole surface consumers subscribe to.
Anything else — metrics, per-depth accounting, retry hints — rides on
existing event payloads as optional fields. `ALL_AGENT_EVENT_TYPES`
stays small.

**Env-gated live tests.** CI runs deterministic hermetic tests only.
Live LLM smokes + Python protocol tests gate on env vars
(`GEMINI_API_KEY`, `python3 --version`) so they degrade to SKIP rather
than FAIL when the environment isn't there.

**Backcompat is policy, not aspiration.** The existing `mikro "query"`
CLI is byte-for-byte identical to pre-SDK behaviour. The CLI cutover to
use `runAgent()` is a deliberately separate slice.

## Module map

| path | role |
|---|---|
| `src/sdk/events.ts` | Event type union + `makeEvent`, `iso`, `isAgentEvent`, `ALL_AGENT_EVENT_TYPES`, `WISH_SPEC_EVENT_TYPES`. |
| `src/sdk/emitter.ts` | Async-iterator `EventStream` + `createEmitter()`. |
| `src/sdk/session.ts` | `SessionState`, `SessionStore`, `createFileSessionStore`, `resumeAgent`, `pauseAgent`. |
| `src/sdk/permissions.ts` | `PermissionHook`, `runPermissionChain`, `composeHooks`, `ALLOW`. |
| `src/sdk/validate.ts` | `parseValidateMd`, `validateAgainstSchema`, `shouldRetry`, `buildRetryHint`. |
| `src/sdk/agent.ts` | `runAgent`, `AgentConfig`, `IterationDriver`, `IterationStep`, `ToolResolver`. |
| `src/sdk/rlm-driver.ts` | `rlmDriver` + `formatRlmPrompt` + `RlmDriverConfig` — bridges `llmCompleteSimple` into `IterationDriver`. |
| `src/sdk/agent-spec.ts` | `AgentSpec`, `parseAgentSpec`, `loadAgentSpec`, `resolveAgentPath`. |
| `src/sdk/tool-registry.ts` | `ToolRegistry`, `ToolSchema`, `createToolRegistry`, `toolRegistryAsResolver`, `UnknownToolError`, `ToolHandler`. |
| `src/sdk/tool-loader.ts` | `loadPluginTools` (`.mjs` / `.js`), sidecar schema loading, `resolvePluginPath`, `MissingPluginError`, `InvalidPluginError`. |
| `src/sdk/python-plugin.ts` | `loadPythonPlugins`, sidecar schema loading, `resolvePythonScript`, `makePythonPluginHandler`, `PythonPluginError`, `PythonPluginTimeoutError`. |
| `src/sdk/metrics.ts` | `IterationMetrics`, `createMetricsRecorder`. |

Public entry: `import { sdk } from "mikro"`.

## `rlmDriver()` tool contract

With `tools` omitted, `rlmDriver()` uses its legacy one-shot path. Supplying
`tools: { registry, expose? }` opts into multi-turn native function calling,
where every function offered to the model must have a `ToolSchema`. File-backed
plugins get that schema from neighboring `tools/<name>.schema.json` files
loaded by `loadPluginTools` or `loadPythonPlugins`.

Construction synchronously throws the exported `NoExposableToolsError` when
zero tools remaining after `expose` have schemas. The error names schema-less
handlers and points to the migrations: add a sidecar, call
`registry.register(name, handler, schema)`, or omit `tools` when one-shot
execution is intentional. There is no schema-less fallback once `tools` is
supplied.

## Completion failures and accounting

The Pi dependency family is pinned to `1.0.2`. `LLMCompletionError` from
`src/llm.ts` reports `error`, `aborted`, or `length`; partial text from these
stops is not a successful answer. Transport retries default to three;
`maxRetries: 0` disables them.

Failure `usage` is optional. Missing provider evidence is unknown, not a
zero-token receipt; an explicitly reported zero remains zero. Native tool
loops include observed prior turns in their one terminal failure receipt.
`runAgent()` emits that receipt even when cancellation stops further
messages, tools, or `EmitDone`, and closes the session as aborted.
Account the failure receipt once. REPL IPC already accounts its direct
failed subcalls; a root catch must not account those again.

Settled recursive-batch child receipts are merged before completion callbacks,
including when cancellation prevents queued children from starting. Completed
receipts count once; killed children without receipts remain unknown.

MCP failures with incomplete coverage expose `observed_usage` JSON containing
unrounded `subtotal` token/cost observations, `coverage: "partial"`, and
`totals: null`. They deliberately omit the normal numeric complete-run footer:
the frozen host parser must not treat a paid subtotal as a complete bill.
Failures without any receipt expose no fabricated numeric accounting.

Consumers using Pi streaming directly must call `streamLLMCompletion()`
rather than raw `runtime.streamSimple()` to retain provider-reported failure
usage, including packets received before SDK normalization. Provider
diagnostics redact configured credentials, including trimmed header values.
For a selected custom provider using `apiKeyFile`, diagnostics are omitted rather
than re-reading its credential to sanitize a reflected response. Stop reason and
observed usage remain available.

## RLM finalization and REPL recovery

`FINAL(name)` and `FINAL_VAR(name)` resolve an existing Python variable.
`FINAL("text")` stays literal; arbitrary expressions are not evaluated.
Missing variables and ellipsis produce repair feedback.

The last root model turn requests finalization within `maxIterations`; there is
no extra forced completion after the cap. Declared `output.schema` and
`VALIDATE.md` both apply. Validation retries require remaining iteration,
validation, cost/token, and deadline room. A terminal rejected payload retains
its answer and `validation_failed` flag; MCP classifies it as a failed tool
response without another model turn. Exhaustion without any final is an error.

`rlmLoop()` throws the public `RLMRunError` when iteration, cost, or token
exhaustion leaves no complete final, or a root completion fails terminally.
Its `iterations` counts actual root model turns; optional `usage` snapshots
cumulative observed root and IPC calls once, including a reported failed packet.
The original completion error remains its `cause`. `usageComplete: false`
identifies a subtotal, not a full bill. No observed calls means no usage receipt.
The legacy MCP adapter preserves this error through the existing
`BackendRunError`/`observed_usage` failure boundary. Cancellation retains the
existing timeout answer but exposes only any observed partial subtotal, never
a complete numeric footer or fabricated zero receipt. Neither path makes
another completion.

The public `REPLTimeoutError` means the block ran once, the old child was killed
and awaited, and a new child restored the original context and tools. All
user-created variables are lost, and the timed-out block is never replayed.
Generation-scoped cancellation discards late LLM/tool replies. Failed restart or
expired enclosing deadline is terminal. `RLMOptions.signal` supplies caller
cancellation, and `LLMRequestHandler` receives the generation's abort signal.
An explicit `stop()` or newer `start()` invalidates an in-flight recovery;
retirement cannot resurrect a subprocess after the newer lifecycle completes.


## Manual source selection with JEV

`extractWithJev()` in `src/jev.ts` is a separate manual API, not an ordinary
agent or MCP hook. Supply an explicit full endpoint, API key, versioned model
or documented `jev-latest` / `jev-preview` alias, sanitized `state`, and bounded
candidate `{ id, text, source }` records. There is no default endpoint,
automatic routing, retry, or cache.

One POST carries `{ state, model, questions }`. Choice includes abstention;
optional Noul and Score questions share the same request. The result retains
the actual versioned model, validated answers/probabilities, observed token
usage, and the exact locally selected candidate or explicit abstention.
Candidate source references stay local. Optional `sourceSnapshot` is cloned
and frozen locally, never transmitted; without it, the frozen snapshot is
the exact serialized state sent on the wire. Serialization hooks and getters
are evaluated once for that wire state and fallback provenance.

The caller must sanitize state and candidate text before transmission.
Transport, cancellation, HTTP, and response-schema failures are typed
`JevExtractionError` failures, not successful empty selections.

## When to use the SDK vs the CLI

**Use the CLI (`mikro "query"`)** when:
- You're running an ad-hoc query against a markdown-configured agent
  directory and you want the canonical mikro iteration loop.
- You need tight compatibility with the existing `mikro.yaml`
  configuration surface.
- You don't need per-iteration observability or programmatic control.

**Use the SDK (`sdk.runAgent(...)`)** when:
- You're embedding agent execution in another program (genie, brain,
  a service) and need to iterate events directly.
- You want to checkpoint + resume sessions across process restarts.
- You need permission hooks, per-depth metrics, or validate with
  retry-hint feedback.
- You're authoring tests that exercise agent behaviour without a live
  LLM (canned `IterationDriver`).

## Real consumers

The SDK's first production consumer is `khal-os/brain`, which wires
three bridge drivers (L1 triage, L2 preservation, L3 audit) into
`sdk.runAgent()`. As of 2026-04-22:

- **L1 triage** — a `single-step` agent routed through
  `sdk.runAgent()` shows **30/30** match vs the legacy pi-ai path
  over a 30-window multimodal slate. First dogfood ship of the SDK
  foundation.
- **L2 preservation** — a `loop` agent with brain-mutation tools
  (`brain_search`, `brain_get`, `brain_write`, `brain_propose`,
  `validate`) shipped **at the measured variance ceiling** on a
  24-window slate. Baseline×baseline and baseline×bridge match rates
  are statistically indistinguishable, which is the cleanest
  possible SHIP signal for bridge fidelity.
- **L3 audit** — sampled self-audit bridge shipping in a separate
  slice; same `IterationDriver`-wrapper pattern.

Brain's bridge lives at `src/agent/mikro-bridge.ts` — a 400-line
adapter that wraps the legacy pi-agent loop as a single outer
iteration of `sdk.runAgent()`. Consumers migrating an existing
agent to the SDK can use it as a reference: the approach preserves
the underlying loop's retry / validation / stop-reason semantics
exactly and lets the SDK wire events, permissions, and session
checkpointing around it without rewriting internals.

Evidence artefacts (metadata only; the brain repo is
Stéfani-private and its conversation data never leaves that repo):

- `brain-lab/mikro-sdk-bridge-report/<YYYY-MM-DD>/SHIP-decision.md`
- `brain-lab/mikro-sdk-bridge-report-l2/<YYYY-MM-DD>/report.md`

These ship as shape (match rate, stop-reason distribution, cost and
latency deltas) without any per-window content.

## Schema stability

`schema_version: 1` and `tools_api: 1` are the only fields the SDK
has ever shipped. Both are production-validated across three
consumer bridges. Future bumps will introduce parallel versions
before deprecating v1 — existing bridges will keep loading without
change.

## Further reading

- [`docs/events.md`](./events.md) — the 12-event catalogue + usage.
- [`docs/tool-authoring.md`](./tool-authoring.md) — writing `.mjs`,
  `.js`, and `.py` tool plugins.
- [`docs/agent-yaml-schema.md`](./agent-yaml-schema.md) — the
  `agent.yaml` reference.
- [`examples/`](../examples/) — three runnable example agents with
  smoke tests. See also the production example in khal-os/brain's
  `.agents/{triage,preservation,audit}/` directories.
