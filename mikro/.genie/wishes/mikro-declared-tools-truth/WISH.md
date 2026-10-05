# Wish: Declared tools truth — `tools:` runs on the default backend, carries a schema, or is advertised UNAVAILABLE

| Field | Value |
|-------|-------|
| **Status** | VERIFIED_DEV — merged to `dev` at `b3d4a31` via [PR #149](https://github.com/automagik-dev/mikro/pull/149) on 2026-09-03; not yet promoted to `main` |
| **Slug** | `mikro-declared-tools-truth` |
| **Date** | 2026-09-03 |
| **Author** | Felipe |
| **Appetite** | medium |
| **Branch** | `wish/mikro-declared-tools-truth` |
| **Repos touched** | automagik-dev/mikro |
| **Design** | [DESIGN.md](../../brainstorms/mikro-declared-tools-truth/DESIGN.md) |

## Summary

A microagent that declares `tools:` in `agent.yaml` runs tool-less on the default `mikro mcp` backend with no warning, and on the SDK path its file-loaded tools carry no schema, so `rlmDriver` silently degrades to one-shot and the agent fabricates instead of calling what it declared (brain handoff M1 and M2, verified at `14bf5e8`). This wish makes declared tools callable from the legacy REPL through a `tool_request` bridge, gives file-loaded tools a sidecar schema, makes `rlmDriver` throw instead of silently switching modes, and advertises any unresolvable, reserved, or colliding tool name as `UNAVAILABLE` at discovery through the same path the model-pin check already uses.

## Scope

### IN

- Sidecar `tools/<name>.schema.json` (exact `ToolSchema` shape: top-level keys ⊆ {`description`, `parameters`}; `description` a string; `parameters` a plain object whose `type`, if present, is `"object"`, with nested keys passed through untouched; `{}` valid) attached by `loadPluginTools` and `loadPythonPlugins`; malformed sidecar throws `InvalidPluginError` naming file and reason; path resolvers `resolvePluginPath` / `resolvePythonScript` exported.
- `rlmDriver` throws `NoExposableToolsError` at construction when `tools` is supplied and zero tools remain after `expose`; message names schema-less handlers and the next step; pinned fallback test and the `rlm-driver.ts` JSDoc/header comments rewritten.
- REPL `tool_request` / `tool_response` IPC pair mirroring `llm_request` / `llm_response`, registered through a new `REPL.onToolRequest(handler: ToolResolver)` setter that mirrors `onLLMRequest` (instance state, so crash recovery keeps it); injected Python global `call_tool` registered in `_globals`, `_restore_reserved`, and Python `RESERVED_NAMES`; invariant that a `tool_request` never rejects the enclosing `execute`. The REPL itself emits no events.
- Exported Node reserved-name constant `REPL_RESERVED_NAMES` (Python `RESERVED_NAMES`, including `call_tool`, ∪ non-underscore top-level `def` names of the three battery files) with a parity test that reads those files; `defaultReplTimeoutMs()` exported.
- `LegacyMikroBackend.run` loads `agent.spec.tools` into a per-run registry, passes a `ToolResolver` through new optional `RLMOptions.tools`, loads Python plugins with `timeoutMs: Math.max(1, defaultReplTimeoutMs() - PLUGIN_TIMEOUT_MARGIN_MS)` (exported constant, 1 000 ms), and appends one `def <name>(**kwargs)` stub per tool to `config.tools`. `rlm.ts` wraps the resolver so bridged `ToolCallBefore` / `ToolCallAfter` events are emitted with the loop's `sessionId`/`selfTag`, `iteration: 0`, and `tool: <name>`, nested inside the `tool: "repl"` pair.
- Discovery-time `validateAgentTools` (scoped to `backend: mikro`) checking file resolution (resolvers imported from the loader modules directly, `missing` ⇔ `resolvePluginPath(...).path === null && resolvePythonScript(...) === null`, no import or spawn), reserved names (`REPL_RESERVED_NAMES`), and collisions with `loadConfig(cwd).tools` names, i.e. `<cwd>/.mikro/TOOLS.md`; `Microagent.modelProblem` replaced by a single `Microagent.unavailable` fragment (cause plus remedy, e.g. `missing tools: ghost — add tools/ghost.{mjs,js,py} to <dir> or remove the declaration, then retry.`); `describeAgent`, startup stderr, and `tools/call` refusal keep their existing prefixes and one branch each; the model remedy sentence moves out of `describeAgent` into the fragment `validateAgentModels` writes.
- Every microagent description (both the UNAVAILABLE and the normal branch of `describeAgent`, never `GENERIC_DESCRIPTION`) ends with `Backend: <mikro|prime|prime-sdk>. Tools: a, b, c.` or `Tools: none declared.`
- Docs: extend `docs/tool-authoring.md`, update `docs/agent-yaml-schema.md`, `README.md` (`tools` row and `mikro mcp` UNAVAILABLE paragraph), `docs/events.md` plugin-shape paragraph, `docs/sdk-overview.md`; add `examples/agents/hello-world/tools/greet.schema.json`; CHANGELOG `### Changed (SDK public API)` and `### Added` entries under `[Unreleased]`.

### OUT

- Host-shipped agent roots, registration API, origin namespace, shadow warnings (M3, `mikro-host-agent-roots`).
- Native function-calling inside the legacy engine; the REPL remains the only dispatch surface on the default backend.
- Any second schema channel (named `schema` export, Python `describe` handshake, `{name, schema}` entries in `agent.yaml`).
- Positional-argument stubs, streaming tool output, a per-tool timeout knob, sandboxing, exactly-once dispatch across REPL crash recovery, live iteration or session id in bridged `ToolContext`.
- RTK schema; `rtk` declared without `tools/rtk.*` on the default backend is `missing`.
- Documenting `backend:` as a settable `agent.yaml` field; any `prime` / `prime-sdk` behaviour change beyond picking up sidecar schemas through the shared loaders.
- Editing the `mikro-prime-081-reconciliation` ledger (CAP-20 / CAP-21 re-observation belongs to that design's own process).
- Handoff items M4–M10 (provider error truth, FINAL hygiene, batch isolation, stats, citations, budget, compat docs).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Bridge tools into the REPL via a `tool_request` IPC pair; no driver switch on the default backend. Bridged events nest inside the `tool: "repl"` pair; `incrToolCalls` counts REPL executions only. | Smallest change that makes declared tools callable while keeping the RLM engine and its semantics; the `llm_request` bridge (`src/repl.ts:444-466`) is the proven template. |
| 2 | Sidecar `tools/<name>.schema.json` is the single schema channel, shaped exactly like `ToolSchema`, `parameters.type` required to be `object` when present. | One parser, one test, works for `.mjs`/`.js`/`.py`; `prime-sdk` gets schemas for free through the shared loaders. |
| 3 | `rlmDriver` with `tools` and zero exposed schemas throws `NoExposableToolsError` at construction, with the next step in the message. | Passing `tools` states intent to dispatch; silent one-shot is the M2 bug; checking after `expose` matches what the model receives (`src/sdk/rlm-driver.ts:242-258`). |
| 4 | Unresolved, reserved, and `TOOLS.md`-colliding names are found at discovery and carried in one `Microagent.unavailable` sentence (replacing `modelProblem`) with a per-cause remedy; scoped to `backend: mikro`. Reserved set is one exported Node constant pinned by a parity test that reads the Python files. | `tools/list` must never advertise a guaranteed-degraded tool; one field keeps three rendering sites at one branch each; the Node constant is the single source the probe reads. |
| 5 | Stubs are `def <name>(**kwargs)` with a docstring from the sidecar description and parameter names; no sidecar → `"(arguments undocumented — pass keyword arguments)"`. | Keyword arguments map 1:1 onto the JSON object every handler already receives; `buildCustomToolsSection` already renders name plus docstring. |
| 6 | Handler errors surface as Python `RuntimeError`; results are JSON-round-tripped; a `tool_request` never rejects the enclosing `execute`. | Any bridge failure escaping `processMessages` would end the whole run (`src/repl.ts:471-477`, `src/rlm.ts:940, 1151-1183`). |
| 7 | Description suffix `Backend: … Tools: …` is derived from the spec, not a load attempt. | `tools/list` runs per request; resolution truth is already in `unavailable`; the handoff asks for the backend explicitly. |
| 8 | `rlmLoop` receives a `ToolResolver`, not a registry; `iteration` is `0` for bridged calls. | `ToolResolver` (`src/sdk/agent.ts:166-170`) and `toolRegistryAsResolver` already exist and handle unknown tools; the other two call sites pass `0`. |
| 9 | Python plugins on the default backend load with a timeout strictly below the REPL execute timeout; `.mjs` handlers own their deadline via `ctx.signal`. | At defaults both are 30 s and the REPL timer starts first, so the plugin timeout could never fire and a slow tool would SIGKILL the REPL and fail the run. |
| 10 | Bridged handlers are at-least-once per code block; crash recovery unchanged. | Recovery already replays the failed block; stated and documented rather than hidden. |

## Simplicity Case

- **Simplest complete design:** sidecar schema read by the two existing loaders; `rlmDriver` throws instead of silently switching modes; legacy backend loads declared tools, generates one `**kwargs` stub per tool into the existing `config.tools` channel, and the REPL gains one request/response pair that calls back through the existing `ToolResolver` type; discovery marks unresolved names UNAVAILABLE through the existing rendering path; description gains one sentence.
- **Added machinery:** the `tool_request`/`tool_response` message pair (required: the REPL is the only place the model can act on the default backend, and Node owns the handlers); the reserved-name and collision checks (required: a stub named `FINAL` breaks termination, `context` overwrites the loaded context, a `TOOLS.md` duplicate silently wins or loses; each is a set lookup at discovery); one option value (`timeoutMs` below the REPL timeout) passed to an existing loader parameter. No new config key, env var, backend, retry, or fallback flag.
- **Deferred until measured:** named `schema` export for `.mjs` (trigger: a consumer files an issue reporting sidecar friction); positional-argument stubs (trigger: traces show a model calling a bridged tool positionally in ≥ 2 packs); a per-tool timeout knob (trigger: a measured plugin call in brain's packs needing more than the REPL execute timeout); live iteration in bridged `ToolContext` (trigger: a consumer's `ToolCallBefore` handler needs it); exactly-once dispatch across REPL recovery (trigger: a pack with a non-idempotent tool observes a replay); RTK schema (trigger: an agent needing `rtk` via native function-calling).
- **Complexity removed:** no dual schema channels, no silent one-shot branch when tools were requested, no backend auto-selection, no per-agent "strict tools" option, no parallel `toolProblem`/`modelProblem` branches, no registry type inside `rlm.ts`, no new durable state (registry is per-run in memory; a `tool_response` is consumed inside the same `execute` that produced its request).

## Dependencies

**depends-on:** none
**blocks:** mikro-host-agent-roots, mikro-sdk-compat-contract

## Success Criteria

- [x] Hermetic: an agent dir with `tools/echo.mjs` + `tools/echo.schema.json` run through `LegacyMikroBackend` with the `loop` seam yields a `config.tools` entry `echo` whose stub docstring contains the sidecar description, and `RLMOptions.tools` is a defined resolver.
- [x] Hermetic (group 3): a started `REPL` with `onToolRequest` set executes `echo(x=1)` and returns `{"x": 1}`; a throwing handler, a non-JSON-serializable result, and an unregistered name each yield a Python `RuntimeError` while `execute` resolves normally and the REPL stays alive.
- [x] Hermetic (group 4): through the exported `bridgeToolResolver` wrapper, `ToolCallBefore`/`ToolCallAfter` carry `tool: "echo"` and the right `ok` on the supplied emitter, emitted between `execute` and its settlement (the interval the `tool: "repl"` pair spans in `rlmLoop`); the inner resolver receives the supplied abort signal.
- [x] Hermetic (group 4, the hermetic realization of design criterion 3): a bare `REPL` started with the backend-generated stub `config.tools` code and `onToolRequest(toolRegistryAsResolver(registry))`, where the registry was filled by `loadPythonPlugins` with the backend's exported timeout value, turns a `.py` plugin that sleeps past that value into a `RuntimeError` in the execute result while the REPL stays alive; separately, a loader spy through the `loop` seam pins that the backend passes `timeoutMs` equal to `Math.max(1, defaultReplTimeoutMs() - PLUGIN_TIMEOUT_MARGIN_MS)` and `> 0`. No live model is required.
- [x] Hermetic: an agent declaring `ghost` with no `tools/ghost.*` lists with a description starting `UNAVAILABLE — "…" cannot run: missing tools: ghost` and containing the remedy, and `tools/call` returns `isError` whose text contains the same `unavailable` fragment behind its own `mikro <name> cannot run: ` prefix; an identical `backend: prime-sdk` agent is unaffected; agents declaring `FINAL` and `context` are UNAVAILABLE with the reserved-name reason; a name present in `TOOLS.md` is UNAVAILABLE with the collision reason; a model-pin failure still renders through the same field with the model remedy.
- [x] Hermetic: `REPL_RESERVED_NAMES` equals Python `RESERVED_NAMES` (which now includes `call_tool`) ∪ the non-underscore top-level `def` names read from `python/batteries.py`, `python/gemini_batteries.py`, `python/pg_batteries.py`.
- [x] Hermetic: every microagent description, available or UNAVAILABLE, ends with `Backend: <name>. Tools: …` matching the spec; `GENERIC_DESCRIPTION` is unchanged.
- [x] Hermetic: `loadPluginTools` and `loadPythonPlugins` attach a sidecar schema for `.mjs` and `.py`; a malformed sidecar (non-object, unknown key, `parameters.type` not `object`) throws `InvalidPluginError` naming the file and the reason; `{}` is accepted.
- [x] Hermetic: `rlmDriver({ tools: { registry } })` with a schema-less handler throws `NoExposableToolsError` naming the handler and the next step; `expose` selecting only schema-less handlers also throws; omitting `tools` still yields the two-step one-shot run.
- [ ] Live (documented in `docs/tool-authoring.md`, not CI): the handoff M1 repro (`mikro mcp --dir ~/workspace/repos/brain`, `tools/call mikro_ask-maestro`) shows at least one `ToolCallBefore` for a declared tool in `--verbose`/`--log` output.
- [x] Repository gate: `npm run check && npm run build && npm test` pass; every doc location under Scope IN is updated; CHANGELOG entries present.

## Execution Strategy

### Wave 1 (parallel — disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 2 — multi-file loaders (+1), no other factors; deterministic tests exist (`sdk-tool-loader`, `sdk-python-plugin`) (+1 for two plugin languages) | `engineer-standard` / medium | Sidecar schema in both loaders, validation, exported resolvers |
| 2 | engineer | 2 — public SDK contract change (+1 multi-package: `.d.ts` consumers), prior pinned test rewritten (+1 prior rework) | `engineer-standard` / medium | `NoExposableToolsError` in `rlmDriver`, expose-aware, JSDoc, test rewrite |
| 3 | engineer | 5 — stateful IPC protocol across Node and Python (+2 stateful, +1 multi-package), execute-settlement invariant is orchestration-like (+2) | `engineer-complex` / high | REPL `tool_request` bridge via `onToolRequest` setter, `call_tool` global, reserved constant + parity test, timeout export (no events) |

### Wave 2 (parallel — both depend on wave 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 4 | engineer | 4 — wires loaders, resolver, timeout and stub generation into `rlmLoop` (+2 orchestration, +2 stateful REPL lifecycle) | `engineer-complex` / high | `RLMOptions.tools` + event-emitting wrapper, legacy backend loads tools, stubs, plugin timeout margin, `loaders` seam |
| 5 | engineer | 3 — discovery probe plus `modelProblem` → `unavailable` rename across four `server.ts` sites and one test (+2 routing/lifecycle, +1 prior rework) | `engineer-standard` / high | `validateAgentTools`, `unavailable` field, description suffix |

### Wave 3 (sequential — depends on waves 1–2)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 6 | engineer | 3 — docs and changelog with subjective acceptance (+2), example asset (+1) | `engineer-standard` / medium | Docs, README, events, sdk-overview, example sidecar, CHANGELOG |

Aggregate gate after wave 3 (repository-documented, run once on the integrated branch): `npm run check && npm run build && npm test`.

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high;
**4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an
independent `final-gate` at the highest justified effort. Each runtime maps
these to its matching native roles (such as the `genie_*` profiles where
installed). Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 1: sidecar-schema

**Goal:** Both file loaders attach a validated `tools/<name>.schema.json` sidecar and export their path resolvers.

**Deliverables:**
1. `src/sdk/tool-loader.ts`: read `<dir>/tools/<name>.schema.json` beside the resolved plugin; validate (top-level keys ⊆ {`description`, `parameters`}; `description` string; `parameters` plain object whose `type`, if present, is `"object"`; nested keys such as `properties`/`required` pass through untouched; `{}` allowed); pass as third argument to `registry.register`; throw `InvalidPluginError(name, sidecarPath, reason)` on malformed content; export `resolvePluginPath` with its current return shape (`{ path, tried }`).
2. `src/sdk/python-plugin.ts`: same sidecar read and validation for `.py`; export `resolvePythonScript` with its current return shape (`string | null`). Share one sidecar reader between the two loaders (single exported helper in `tool-loader.ts`). Do not touch `src/sdk/index.ts` (owned by group 2); consumers import from the loader modules directly, as `src/mcp/backends/prime-sdk.ts:132-134` does.
3. `tests/sdk-tool-loader.test.ts`, `tests/sdk-python-plugin.test.ts`: sidecar attached and visible via `registry.describe(name)`; absent sidecar registers schema-less; each malformed shape throws `InvalidPluginError` naming the file and reason; `{}` accepted.
4. `src/mcp/backends/prime-sdk.ts:696-697`: the comment "The loaders attach no schema today" is updated to say the permissive object is the fallback when no sidecar is present (comment only; no behaviour change).

**Acceptance Criteria:**
- [x] `registry.describe("echo")` equals the sidecar content for a `.mjs` and a `.py` plugin.
- [x] Malformed sidecars (non-object, unknown top-level key, `parameters` not an object, `parameters.type` present and not `"object"`) throw `InvalidPluginError` whose message contains the sidecar path and the reason; `{ "parameters": { "properties": {} } }` is accepted.
- [x] `resolvePluginPath` and `resolvePythonScript` are exported and accept exactly `{mjs,js}` and `{py}` respectively.
- [x] `prime-sdk` backend tests (`tests/prime-sdk-backend.test.ts`) still pass unchanged.

**Validation:**
```bash
# Focused: the two loader suites plus prime-sdk (consumer of the loaders); build is required because tests run from dist.
npm run check && npm run build && node --test dist/tests/sdk-tool-loader.test.js dist/tests/sdk-python-plugin.test.js dist/tests/sdk-tool-registry.test.js dist/tests/prime-sdk-backend.test.js
```
Scope rationale: SDK loader behaviour with deterministic unit coverage; boundaries reached are the registry and the one existing consumer, both included.

**depends-on:** none

---

### Group 2: rlm-driver-loud

**Goal:** `rlmDriver` refuses to run silently one-shot when tools were requested.

**Deliverables:**
1. `src/sdk/rlm-driver.ts`: new exported `NoExposableToolsError` (extends `Error`, `name` set); thrown from `rlmDriver` construction when `config.tools` is present and the exposed schema set (after `expose`) is empty; message: `rlmDriver: tools supplied but no exposed tool has a schema (handlers without schema: a, b). Add tools/<name>.schema.json next to each plugin, call register(name, handler, schema), or omit \`tools\` to run one-shot.`; JSDoc at `:7-11`, `:100-103`, `:278-280` rewritten.
2. `src/sdk/index.ts`: export `NoExposableToolsError`.
3. `tests/sdk-rlm-driver-tools.test.ts`: the test at `:105` rewritten to pin the throw (message names the handler and next step); new case for `expose` selecting only schema-less handlers; existing case for omitted `tools` (one-shot) retained.

**Acceptance Criteria:**
- [x] `rlmDriver({ tools: { registry } })` with a schema-less handler throws `NoExposableToolsError` synchronously at construction.
- [x] `rlmDriver({ tools: { registry, expose: ["x"] } })` where `x` lacks a schema throws.
- [x] `rlmDriver({})` still yields the two-step one-shot run.
- [x] No remaining source or JSDoc text claims a one-shot fallback for schema-less tools (`grep -n "falls back to\|fall back to\|one-shot mode for safety" src/sdk/rlm-driver.ts` is empty; the current JSDoc at `:102-103` wraps across lines, which is why the phrase-level grep is used).

**Validation:**
```bash
npm run check && npm run build && node --test dist/tests/sdk-rlm-driver-tools.test.js dist/tests/sdk-rlm-driver.test.js dist/tests/sdk-agent.test.js && ! grep -n "falls back to\|fall back to\|one-shot mode for safety\|has at least one schema" src/sdk/rlm-driver.ts
```
Scope rationale: public SDK contract change with a pinned test; the driver suites and `sdk-agent` (which constructs drivers) are the reached boundaries.

**depends-on:** none

---

### Group 3: repl-tool-bridge

**Goal:** The REPL can call back into a Node `ToolResolver` from Python without ever rejecting the enclosing `execute`.

**Deliverables:**
1. `src/repl.ts`: new `REPL.onToolRequest(handler: ToolResolver): void` setter mirroring `onLLMRequest` (`src/repl.ts:111`; instance state, not a start option, so crash-recovery restart keeps it); in `processMessages`, handle `{"type":"tool_request","tool","args"}`: call the handler as `(tool, args, signal)` where `signal` is the abort signal the REPL already holds for the current execute (or a never-aborted signal if none), JSON-round-trip the result, reply `{"type":"tool_response","ok":true,"result"}`; every failure path (handler throw of any value, non-serializable result, send failure, no handler registered) replies `ok:false` with a string `error`; wrap so no throw escapes into `_waitForExecuteResult`. The REPL emits no events; event emission is group 4's wrapper in `rlm.ts`. Export `defaultReplTimeoutMs`. Export `REPL_RESERVED_NAMES` next to `BATTERY_FUNCTION_NAMES`: Python `RESERVED_NAMES` ∪ non-underscore top-level `def` names of `python/batteries.py`, `python/gemini_batteries.py`, `python/pg_batteries.py`.
2. `python/llm_bridge.py`: `call_tool(name, kwargs)` sending one `tool_request` line under `_ipc_lock` and blocking on `tool_response`; raises `RuntimeError(error)` on `ok:false`.
3. `python/repl_server.py`: `call_tool` added to `RESERVED_NAMES`, to `_globals`, and to `_restore_reserved`; `tool_response` routed like `llm_response`.
4. `tests/repl-tool-bridge.test.ts` (new, starts a real REPL like `tests/rtk-integration.test.ts`): success round-trip, throwing handler, non-serializable result, handler that rejects with `UnknownToolError` (what `toolRegistryAsResolver` does for an unregistered name), no handler registered, REPL alive after each.
5. `tests/repl-reserved-names.test.ts` (new): parity test reading `python/repl_server.py` `RESERVED_NAMES` and the `^def ` lines of the three battery files, asserting equality with `REPL_RESERVED_NAMES`, and asserting `call_tool` is a member.

**Acceptance Criteria:**
- [x] `execute('echo(x=1)')` with a handler returning its args yields `{"x": 1}` in the execute result.
- [x] Throwing handler, BigInt result, `UnknownToolError` rejection, and no handler registered each produce a Python `RuntimeError` in the execute result; `execute` resolves; a subsequent `execute` on the same REPL succeeds.
- [x] `REPL_RESERVED_NAMES` equals the file-derived set and contains `call_tool` (parity test).
- [x] `defaultReplTimeoutMs` is exported.

**Validation:**
```bash
npm run check && npm run build && node --test dist/tests/repl-tool-bridge.test.js dist/tests/repl-reserved-names.test.js dist/tests/rtk-integration.test.js dist/tests/recursion-bridge.test.js dist/tests/rlm-stop-protocol.test.js
```
Scope rationale: shared runtime protocol change in `repl.ts` and the Python server; focused suites cover the new pair, and the existing REPL-protocol suites (`rtk-integration`, `recursion-bridge`, `rlm-stop-protocol`) guard the `llm_request` path and stop protocol the change sits beside. Full gate runs at the aggregate step.

**depends-on:** none

---

### Group 4: legacy-backend-tools

**Goal:** `LegacyMikroBackend` loads declared tools and exposes them to the REPL loop as `**kwargs` stubs.

**Deliverables:**
1. `src/rlm.ts`: new optional `RLMOptions.tools?: ToolResolver`; new exported `bridgeToolResolver(resolver, emitter, { sessionId, selfTag, signal })` that returns a `ToolResolver` emitting `ToolCallBefore` before and `ToolCallAfter` after each call (`sessionId`, `...selfTag`, `iteration: 0`, `tool: <name>`, `ok`, `durationMs`, `result` or `error`) with the same shape as the `tool: "repl"` pair at `src/rlm.ts:932-947`, and which ignores the signal the REPL passes and calls the inner resolver with the supplied `signal`; `rlmLoop`, when `tools` is set, builds the wrapper with `selfCorrelationId`, `selfTag`, and `abortController.signal` (`src/rlm.ts:479, 541`, so a run timeout interrupts a bridged `.mjs` handler, realizing the design's "`ctx.signal` is the run abort signal") and registers it with `repl.onToolRequest(...)` right after `new REPL()`; nothing else in the loop changes. That one-line registration is covered by the live criterion and QA, not hermetically.
2. `src/mcp/backends/legacy.ts`: export `PLUGIN_TIMEOUT_MARGIN_MS = 1_000`; `run(agent, …)` builds a fresh `createToolRegistry()`, calls `loadPluginTools` and `loadPythonPlugins(…, { timeoutMs: Math.max(1, defaultReplTimeoutMs() - PLUGIN_TIMEOUT_MARGIN_MS) })` for `agent.spec.tools`, builds the resolver with `toolRegistryAsResolver`, generates one `ToolDef { name, code }` stub per loaded tool (`def <name>(**kwargs): """<sidecar description; parameter names>""" return call_tool("<name>", kwargs)`; generic docstring when no sidecar), appends stubs to `config.tools` after `TOOLS.md` entries, and passes `tools` into `rlmLoop` options. Add an optional `loaders` test seam to `LegacyMikroBackendOptions` (defaults to the real `loadPluginTools`/`loadPythonPlugins`) so tests can spy on the `timeoutMs` value.
3. New `tests/legacy-backend-tools.test.ts` (leave `tests/backend-contract.test.ts` unchanged): via the `loop` seam, assert the `config.tools` entry, docstring content, and defined resolver; via the `loaders` seam, assert the `timeoutMs` value; via a bare `REPL` started with the backend-generated stub code and `onToolRequest(toolRegistryAsResolver(registry))` with a registry filled by the real `loadPythonPlugins` at that `timeoutMs`, assert a sleeping `.py` plugin yields `RuntimeError` and the REPL stays alive; via a bare `REPL` with `onToolRequest(bridgeToolResolver(resolver, emitter, …))`, assert the bridged events and `ok` flags are emitted on the supplied emitter between the test's `execute` call and its settlement (the interval the `tool: "repl"` pair spans in `rlmLoop`), and that an aborted `signal` reaches the inner resolver.

**Acceptance Criteria:**
- [x] Success criterion 1 (stub + docstring + defined resolver) passes through the `loop` seam.
- [x] Success criterion "hermetic realization of design criterion 3" (sleeping Python plugin → `RuntimeError`, REPL alive; spy shows `timeoutMs === Math.max(1, defaultReplTimeoutMs() - PLUGIN_TIMEOUT_MARGIN_MS)` and `> 0`) passes.
- [x] Bridged `ToolCallBefore`/`ToolCallAfter` for `tool: "echo"` are emitted by `bridgeToolResolver` with correct `ok` on the supplied emitter between `execute` and its settlement; the inner resolver receives the supplied `signal`.
- [x] `rlmLoop` without `tools` behaves exactly as before (existing `rlm-*` and `backend-contract` suites unchanged and passing).

**Validation:**
```bash
npm run check && npm run build && node --test dist/tests/legacy-backend-tools.test.js dist/tests/backend-contract.test.js dist/tests/rlm-setup-failure.test.js dist/tests/rlm-stop-protocol.test.js dist/tests/sdk-python-plugin.test.js
```
Scope rationale: shared core (`rlm.ts`) touched additively; focused new suite plus the existing loop and backend contract suites cover the reached boundaries; full gate at the aggregate step.

**depends-on:** sidecar-schema, repl-tool-bridge

---

### Group 5: mcp-unavailable-truth

**Goal:** `tools/list` never advertises a default-backend agent whose declared tools cannot run, and every description states backend and tool set.

**Deliverables:**
1. `src/mcp/agents.ts`: `Microagent.modelProblem` renamed to `unavailable?: string`, holding only the cause-plus-remedy fragment (e.g. `missing tools: ghost — add tools/ghost.{mjs,js,py} to <dir> or remove the declaration, then retry.`; `"FINAL" is a reserved REPL name — rename the tool and its file.`; `"x" collides with a TOOLS.md tool — rename one of them.`; for models, the existing problem text followed by `Fix the agent's model: pin or declare the provider in config, then retry.`).
2. `src/mcp/server.ts`: `validateAgentModels` writes its fragment (now including the model remedy) into `unavailable`; new `validateAgentTools` (scoped `backend ?? "mikro"`, runs after `validateAgentModels`, first cause wins) checks each declared name with `resolvePluginPath`/`resolvePythonScript` imported directly from `../sdk/tool-loader.js` / `../sdk/python-plugin.js` (`missing` ⇔ both return no path; no import, no spawn), against `REPL_RESERVED_NAMES` from `../repl.js`, and against the names in `loadConfig(cwd).tools` (`<cwd>/.mikro/TOOLS.md`, the same config `validateAgentModels` already loads at `:606-615`; when `loadConfig` throws, the collision set is empty and the missing/reserved checks still run); the three renderers keep their existing prefixes (`UNAVAILABLE — "<name>" cannot run: ` in `describeAgent`, the stderr line, `mikro <name> cannot run: ` in `tools/call`) and read only `unavailable`; the hardcoded model remedy at `:189` is removed from `describeAgent`; `describeAgent` appends the `Backend: <backend>. Tools: a, b.` / `Tools: none declared.` suffix in both branches; `GENERIC_DESCRIPTION` is untouched.
3. `tests/mcp-agents.test.ts`, `tests/custom-providers.test.ts` (rename at `:337-345`), new cases for `ghost`, `FINAL`, `context`, `TOOLS.md` collision (fixture writes `<cwd>/.mikro/TOOLS.md`), `prime-sdk` unaffected, suffix on every agent in both branches, `GENERIC_DESCRIPTION` unchanged.

**Acceptance Criteria:**
- [x] Success criterion 4 (all UNAVAILABLE causes, `prime-sdk` unaffected, model-pin still rendered) passes.
- [x] Success criterion 6 (suffix on every description) passes.
- [x] `grep -n modelProblem src tests` is empty.

**Validation:**
```bash
npm run check && npm run build && node --test dist/tests/mcp-agents.test.js dist/tests/custom-providers.test.js dist/tests/backend-contract.test.js dist/tests/prime-backend.test.js dist/tests/prime-sdk-backend.test.js && ! grep -rn "modelProblem" src tests
```
Scope rationale: MCP discovery and rendering; the agent and provider suites cover the renamed field, and the three backend suites confirm non-default backends are unaffected.

**depends-on:** sidecar-schema, repl-tool-bridge

---

### Group 6: docs-changelog

**Goal:** Every documented statement about declared tools, the driver contract, and UNAVAILABLE matches the shipped behaviour.

**Deliverables:**
1. `docs/tool-authoring.md` (extend): intro at lines 3-6 and `args` comment at line 15 updated; sections "Sidecar schema" (the `ToolSchema` interface verbatim, one complete `echo.schema.json`, the validation rule), "Calling bridged tools from the REPL" (`**kwargs`, `RuntimeError`, at-least-once on recovery, `ctx.signal` reach, `.mjs` handlers own their deadline), "Reserved names", "Timeouts on the default backend" (`MIKRO_REPL_TIMEOUT_MS`; the plugin `timeoutMs` at line 86 is set below it by the backend), "How tools reach the model on each backend" (why keyword arguments, why RTK is `missing`, ESM import cache), one supply-chain line, and the M1 live-repro how-to.
2. `docs/agent-yaml-schema.md`: comment at lines 74-76 and `tools` row at line 116; UNAVAILABLE rule; one line that the description reports the executing backend and `mikro` is the default.
3. `README.md`: `tools` row at line 207; `mikro mcp` UNAVAILABLE paragraph at lines 900-906 gains missing-tools/reserved/collision causes and the `Backend:/Tools:` suffix.
4. `docs/events.md:244-260`: plugin-shape paragraph points at `tool-authoring.md`.
5. `docs/sdk-overview.md`: `rlmDriver` contract change and `NoExposableToolsError`.
6. `examples/agents/hello-world/tools/greet.schema.json` added; `tests/example-hello-world.test.ts` asserts it loads.
7. `CHANGELOG.md` `[Unreleased]`: bold-led `### Changed` entry labelled `(SDK public API)` naming `NoExposableToolsError` (old fallback, new throw, migration) and `### Added` entry naming `tools/<name>.schema.json`, the REPL tool bridge, and the MCP UNAVAILABLE causes.

**Acceptance Criteria:**
- [x] Each listed file contains the listed content (content-contract greps below).
- [x] No doc still states that schema-less `tools` falls back to one-shot.
- [x] `examples/agents/hello-world` loads with its sidecar attached.

**Validation:**
```bash
grep -q "schema.json" docs/tool-authoring.md && grep -q "Reserved names" docs/tool-authoring.md && grep -q "MIKRO_REPL_TIMEOUT_MS" docs/tool-authoring.md && grep -q "mikro mcp" docs/tool-authoring.md \
&& grep -q "UNAVAILABLE" docs/agent-yaml-schema.md \
&& grep -q "missing tools" README.md && grep -q "Backend:" README.md \
&& grep -q "tool-authoring.md" docs/events.md \
&& grep -q "NoExposableToolsError" docs/sdk-overview.md \
&& grep -q "NoExposableToolsError" CHANGELOG.md && grep -q "schema.json" CHANGELOG.md \
&& test -f examples/agents/hello-world/tools/greet.schema.json \
&& ! grep -rn "falls back to one-shot\|fall back to one-shot" docs README.md \
&& npm run build && node --test dist/tests/example-hello-world.test.js dist/tests/examples-agents-recipes.test.js
```
Scope rationale: documentation and one example asset; content-contract greps plus the example suites that load the changed example.

**depends-on:** sidecar-schema, rlm-driver-loud, repl-tool-bridge, legacy-backend-tools, mcp-unavailable-truth

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: with brain's packs checked out, `mikro mcp --dir ~/workspace/repos/brain` lists `mikro_ask-maestro` with a `Backend: mikro. Tools: …` suffix and no `UNAVAILABLE` prefix; `tools/call` on it shows at least one `ToolCallBefore` for a declared tool in `--verbose` output and the answer no longer invents file names.
- [x] Integration: an agent dir with a deliberately missing `tools/ghost.mjs` shows `UNAVAILABLE — … missing tools: ghost …` in `tools/list` and `tools/call` returns `isError` with the same text; the same dir with `backend: prime-sdk` is listed normally. Proven after merge on `dev@b3d4a31`: MCP stdio `tools/list` advertised the missing-tool remedy and `tools/call` returned `isError: true`; the prime-sdk exception remains pinned by the green 878-test repository suite. See post-merge verification below.
- [x] Regression: `examples/agents/hello-world` and an agent with no `tools:` behave exactly as on `14bf5e8` through `mikro mcp`; `mikro query` without agents is unaffected; `npm test` on the merged `dev` is green. Proven after merge on `dev@b3d4a31`: the no-spend MCP execution seam dispatched `greet` through the declared-tool resolver, the no-tools and generic-query paths received no resolver, and 878/878 tests passed. See post-merge verification below.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| A bridged handler outliving the REPL execute timeout SIGKILLs the REPL and fails the run, losing REPL state. | Medium | Python plugins load with a timeout strictly below the REPL timeout (Decision 9); `.mjs` handlers documented as owning their deadline; `MIKRO_REPL_TIMEOUT_MS` named in docs; per-tool knob deferred. |
| `rlmDriver` contract change breaks a consumer relying on schema-less `tools` falling back to one-shot. | Medium | Named error with next step; CHANGELOG `(SDK public API)` entry; JSDoc in the published `.d.ts` rewritten; the one known consumer requested the change. |
| Brain's declared tools may include host-registered in-process names with no `tools/*` file; they will show UNAVAILABLE until M3 lands. | Medium | Explicitly accepted; `mikro-host-agent-roots` owns it. |
| Gemini code-execution paths run outside the REPL and never see bridged tools. | Low | Same limitation TOOLS.md tools have today; documented. |
| Discovery probe and loaders disagree on extensions. | Low | Both call the same exported resolvers; group 5 tests load what the probe accepts. |
| A side-effecting tool runs twice when the REPL crashes mid-block and recovery replays it. | Low | Stated (Decision 10) and documented; exactly-once deferred. |
| `modelProblem` → `unavailable` rename misses a site. | Low | Group 5 validation greps `src` and `tests` for the old name. |
| This wish is planned against `14bf5e8` on `main`; the index's delivery admission (clean B0/P0, exclusive `dev`) still governs when and where it integrates. | Low | `work` cuts the wave base from `genie context --wish` after APPROVED; branch targets `dev` per repository practice; no execution authority is inferred from this document. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — round 1 — 2026-09-03T01:19:57Z — SHIP

- **Reviewer:** review-subagent/plan/mikro-declared-tools-truth (read-only subagent); advisory questioner lens ran in parallel.
- **Target:** `.genie/wishes/mikro-declared-tools-truth/WISH.md` at HEAD `14bf5e8c51637adea53aeae3a450a1b919b1783e` (staged, uncommitted).
- **Commands:** `grep -n "TODO\|{{" WISH.md` → empty; `design-review-evidence.mjs verify DESIGN.md` → exit 0; existence check of all 17 referenced existing test suites and all 22 modify-list files → present; code-seam and doc-anchor reads at HEAD → all confirmed. No `wishes:lint` script exists in this repository.
- **Checklist:** all eight plan-review criteria PASS (fidelity to the SHIP-stamped design, disjoint parallel file ownership, runnable `dist/`-based validations, aggregate gate `npm run check && npm run build && npm test` preserved, no deferred machinery built).
- **Gaps:** LOW-1 group 4 test-file ambiguity; LOW-2 group 2 grep guard could not match the wrapped JSDoc at `src/sdk/rlm-driver.ts:102-103`; LOW-3 `REPLOptions` does not exist; LOW-4 CHANGELOG deliverable should name `schema.json`; LOW-5 informational. Questioner lens: event emission must live in `rlm.ts` (the REPL has no emitter); hook API unnamed; `unavailable` fragment vs full sentence; design criterion 3 not hermetic through `rlmLoop`; timeout margin unfloored (`src/sdk/python-plugin.ts:176` treats non-positive as no timeout); `call_tool` not reserved; sidecar rule nested-key ambiguity; collision source; resolver import path; suffix scope.
- **Orchestrator action:** all items applied to the wish before round 2.

### Plan review — round 2 — 2026-09-03T01:25:33Z — SHIP

- **Reviewer:** review-subagent/plan/mikro-declared-tools-truth/r2 (read-only subagent).
- **Target:** same path, HEAD `14bf5e8c51637adea53aeae3a450a1b919b1783e`.
- **Commands:** `design-review-evidence.mjs verify DESIGN.md` → exit 0; `grep -n "TODO\|TBD\|{{" WISH.md` → empty; `grep -n "falls back to\|fall back to\|one-shot mode for safety" src/sdk/rlm-driver.ts` → hits at `:102-103` (guard is load-bearing); source reads of `src/repl.ts:89,111,343`, `src/rlm.ts:479,540-541,932-947`, `src/sdk/python-plugin.ts:176,270-278`, `src/sdk/tool-loader.ts:84-94`, `src/mcp/server.ts:186-190,205,606-620,919-921,989-992`, `src/mcp/backends/prime-sdk.ts:132-133`, `src/config.ts:124,833`, `tests/custom-providers.test.ts:337-345`, `tests/backend-contract.test.ts:141-156`, battery `^def` counts 9+3+6.
- **Per-item verification:** all seven amendments PASS; the split of design criterion 2 by owner and the hermetic realization of design criterion 3 judged a faithful executable refinement, not scope drift (no LLM seam exists in `rlmLoop`; every backend-owned input is pinned through the `loop` and `loaders` seams).
- **Checklist:** all criteria PASS; wave file ownership disjoint; files list complete; `loaders` is a test seam, not runtime machinery.
- **Gaps:** MEDIUM group 4 event test named an infeasible option ("through `rlmLoop`'s emitter") and an unprovable "enclosed by the `repl` pair" clause; MEDIUM bridged `signal` did not realize the design's run-abort signal (`src/repl.ts` holds none; `rlmLoop` owns `abortController`); LOW `validateAgentTools` when `loadConfig` throws; LOW stale comment at `src/mcp/backends/prime-sdk.ts:696-697`; LOW group 2 guard could also cover `:278-280`.
- **Verdict:** SHIP — zero CRITICAL/HIGH; reviewer stated the MEDIUM items are wish-text clarifications touching group 4 only, applicable without re-review of waves 1 or 3.
- **Orchestrator action:** all five items applied (exported `bridgeToolResolver(resolver, emitter, { sessionId, selfTag, signal })` built by `rlmLoop` with `abortController.signal`; group 4 acceptance and success criterion reworded to "between `execute` and its settlement"; `loadConfig` failure rule; `prime-sdk.ts` comment added to group 1 and the files list; group 2 guard extended with `has at least one schema`). Status set to `APPROVED` 2026-09-03.

### Execution — merged to `dev` — 2026-09-03T12:47:13Z

- **Author:** Steve (Claude) across six groups; integration branch `openclaw/mikro-declared-tools-truth`, six commits `5d88ead` → `562d3da` fast-forwarded onto `18606d4`.
- **PR:** [#149 docs: document declared tool contracts](https://github.com/automagik-dev/mikro/pull/149) — base `dev`, head `562d3da`, merged by `namastex888`, merge commit `b3d4a31`.
- **Pre-merge gates on `562d3da`:** `npm run check`, `npm run build`, `npm test` (878 passed, 0 failed); focused group validations G1–G6 (90 + 33 + 34 + 67 + 216 + 4 = 444 passed); all group content-contract greps passed; `git diff --check` clean. PR checks 8/8 success: [Quality Gate](https://github.com/automagik-dev/mikro/actions/runs/33754497161/job/100645520612), [Commit Messages](https://github.com/automagik-dev/mikro/actions/runs/33754497346/job/100645521557), Socket (PR alerts + project report), GitGuardian, CodeRabbit, Snyk ×2.
- **Post-merge CI on `dev@b3d4a31`:** [CI 33757222947](https://github.com/automagik-dev/mikro/actions/runs/33757222947) success, [Commitlint 33757223029](https://github.com/automagik-dev/mikro/actions/runs/33757223029) success.
- **Read-only evidence re-check by Sofia (GPT-Sol; not the independent cross-family final gate) against `origin/dev`:** `git grep modelProblem -- src tests` empty; `git grep -E "falls back to|fall back to|one-shot mode for safety|has at least one schema" -- src/sdk/rlm-driver.ts` empty; `git grep -E "falls back to one-shot|fall back to one-shot" -- docs README.md` empty; every positive grep in group 6 validation hits; `examples/agents/hello-world/tools/greet.schema.json`, `tests/repl-tool-bridge.test.ts`, `tests/repl-reserved-names.test.ts`, `tests/legacy-backend-tools.test.ts` present.
- **Checked above on this evidence:** success criteria 1–9 and 11; every group acceptance criterion.
- **Final-gate policy and status:** the default final gate is **GLM 5.3 at max reasoning**. A bounded no-repository canary requested model `juice/GLM-5.3` with `thinking=max`; admission and the archived durable entry resolved provider `juice`, model `GLM-5.3`, and stored `thinkingLevel: max`. The terminal response was `CANARY_OK` via `openai-completions` with 19,448 input tokens, 5 output tokens, 64 cache-read tokens, and `$0.0000` reported cost. However, `session_status` rendered the same terminal session as `Modes: think high`. Because the observable surfaces disagree, effective max execution is not proven under the no-fallback rule; the exact max-reasoning route remains **UNAVAILABLE** and no final review was attempted. Do not configure or consume Anthropic through OpenClaw. Fable 5.1 is exceptional-only through Claude Code launched directly via Orca, and only if Felipe explicitly selects it.
- **Still open:** the GLM 5.3/max final evidence review is blocked until the runtime preserves and proves `max` instead of reporting `high`; success criterion 10 and QA Functional remain unattempted because the authorized exact route was not admitted; QA Integration and Regression are covered by the post-merge verification recorded below.
- **Post-merge verification on `dev@b3d4a31`:** direct bounded audit by Sofia after the delegated child was blocked by a no-shell runtime. `npm ci`, `npm run check`, `npm run build`, and `npm test` passed (**878/878**, 197 suites, 0 failures). A no-spend local MCP-path harness exercised `runTurn → LegacyMikroBackend → declared ToolResolver`: `hello-world` loaded the `greet` sidecar, generated `def greet(**kwargs):`, and returned `{\"greeting\":\"Hello, Daily mikro!\"}`; the `changelog` agent with no `tools:` and generic `mikro_query` both ran without a tool resolver. A real MCP stdio session with a deliberately missing `ghost` tool listed `mikro_missing` as `UNAVAILABLE` with the remedy and returned `isError: true` from `tools/call` before model execution. Network/paid-model calls: zero. Existing merged-dev CI remains green: [CI 33757222947](https://github.com/automagik-dev/mikro/actions/runs/33757222947), [Commitlint 33757223029](https://github.com/automagik-dev/mikro/actions/runs/33757223029).

### Value Receipt — Daily 2026-09-03

- **Audience:** mikro maintainers and Felipe as promotion/merge authority.
- **Before → after:** declared tools could be silently omitted or advertised without being callable; on `dev@b3d4a31`, the default backend loads schema-backed tools, missing/reserved/colliding declarations are explicitly `UNAVAILABLE`, and schema-less SDK tool intent fails loudly.
- **Navigable proof:** implementation [PR #149](https://github.com/automagik-dev/mikro/pull/149), merged-dev CI links and post-merge command/read-back evidence above; documentation evidence is isolated in [PR #150](https://github.com/automagik-dev/mikro/pull/150).
- **Environment:** delivered to `dev` (mikro homolog); no `dev → main` PR, promotion, deploy, publication, or live-model spend was performed.
- **Remaining gap to the Weekly Bet:** `juice/GLM-5.3` answered the bounded canary, but the requested `max` level was reported as `high`; therefore the exact GLM 5.3/max final gate remains `UNAVAILABLE`, the independent review was not started, and the live Brain functional reproduction was not attempted.
- **External channel:** none.
- **Authority:** Felipe separately decides PR #150 merge, any live-model spend, and any promotion from `dev`.

---

## Files to Create/Modify

```
# Modify
src/sdk/tool-loader.ts
src/sdk/python-plugin.ts
src/sdk/rlm-driver.ts
src/sdk/index.ts
src/repl.ts
src/rlm.ts
src/mcp/backends/legacy.ts
src/mcp/backends/prime-sdk.ts   # comment only (group 1)
src/mcp/agents.ts
src/mcp/server.ts
python/llm_bridge.py
python/repl_server.py
tests/sdk-tool-loader.test.ts
tests/sdk-python-plugin.test.ts
tests/sdk-rlm-driver-tools.test.ts
tests/mcp-agents.test.ts
tests/custom-providers.test.ts
tests/example-hello-world.test.ts
docs/tool-authoring.md
docs/agent-yaml-schema.md
docs/events.md
docs/sdk-overview.md
README.md
CHANGELOG.md

# Create
tests/repl-tool-bridge.test.ts
tests/repl-reserved-names.test.ts
tests/legacy-backend-tools.test.ts
examples/agents/hello-world/tools/greet.schema.json
```
