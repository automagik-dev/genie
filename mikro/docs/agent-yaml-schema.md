# `agent.yaml` schema

> **Stability:** `schema_version: 1` + `tools_api: 1` are **stable**
> as of 2026-04-22 — production-validated by the `khal-os/brain`
> consumer across L1 triage (30/30 ship), L2 preservation (ship at
> variance ceiling), and L3 audit (in flight). Future schema changes
> will introduce `schema_version: 2` as a parallel — v1 bridges
> continue loading unchanged.

The agent folder's `agent.yaml` file is a small YAML mapping that the
SDK's `parseAgentSpec` / `loadAgentSpec` turn into an `AgentSpec`.
The schema is **deliberately minimal** — only the fields the SDK
consumes are validated. Unknown keys are preserved on `AgentSpec.extras`
so consumers (brain, genie, your project) can layer their own schema
without forking the parser.

The executing backend is selected by mikro rather than set in this file;
omitting a backend selection means `mikro`. Every MCP microagent description
reports that executing backend and the declared tool names.

## Minimal example

```yaml
schema_version: 1
tools_api: 1

shape: single-step
model: gemini-2.5-flash

tools:
  - greet
```

Loaded:

```ts
const spec = await sdk.loadAgentSpec("/path/to/agent-dir");
// spec = {
//   dir: "/path/to/agent-dir",
//   schemaVersion: 1,
//   toolsApi: 1,
//   shape: "single-step",
//   model: "gemini-2.5-flash",
//   tools: ["greet"],
//   extras: {},
// }
```

## Full reference

```yaml
# ─── Schema versioning ────────────────────────────────────────
schema_version: 1            # or schemaVersion: 1   (both accepted)
tools_api: 1                 # or toolsApi: 1

# ─── Iteration shape (how the loop behaves) ──────────────────
shape: single-step           # "single-step" | "loop" | "recurse"
                             # Default: single-step

# ─── Model selection (consumer-interpreted) ──────────────────
model: gemini-2.5-flash      # free-form string; the SDK does not
                             # validate — it's surfaced on AgentSpec
                             # for the consumer's driver / rlmDriver.

# ─── Reasoning effort (optional) ──────────────────────────────
thinking: high               # "minimal" | "low" | "medium" | "high"
                             # Rejected with a named error if it is anything
                             # else. Omit to inherit the ambient config.

# ─── Sampling temperature (optional) ──────────────────────────
temperature: 0               # number, 0–2. `0` is greedy decoding — a real
                             # value, not a synonym for "unset". Omit to
                             # inherit the ambient config. Rejected with a
                             # named error if it is not a number in range.

# ─── Tools ───────────────────────────────────────────────────
tools:
  - greet                    # Resolves from tools/greet.{mjs,js,py}.
  - search_corpus            # An optional same-name .schema.json supplies
                             # model-facing metadata.

# ─── Scope hints (advisory, SDK does NOT enforce) ────────────
scope:
  reads:
    - Conversas/*            # Glob patterns; consumers (brain's
    - docs/**/*.md           # read() tool) enforce the policy.
  writes:
    - _pending/*

# ─── Budget hints (advisory in the SDK today) ────────────────
budget:
  max_cost: 0.01             # USD per run (consumer-enforced)
  max_iterations: 5          # Ceiling — consumer can pass to
                             # runAgent({ maxIterations }).
  max_depth: 3               # For recursive shapes.

# ─── System prompt pointer ───────────────────────────────────
system: SYSTEM.md            # Relative to agent dir. Consumer loads
                             # the content and passes it to the
                             # driver (e.g. rlmDriver({ system })).

# ─── Prompt assembly (optional) ──────────────────────────────
prompt:
  append-stop-protocol: false  # or append_stop_protocol / appendStopProtocol
                               # Default: true — mikro appends its
                               # FINAL/repl termination protocol section to
                               # the system prompt. Set false for a
                               # deliberately bare prompt. Rejected with a
                               # named error if it is not a boolean.
```

## Field reference

| field | type | default | status | notes |
|---|---|---|---|---|
| `schema_version` / `schemaVersion` | number | `1` | **SDK reads — stable** | Production-validated 2026-04-22. Bumped when the schema itself changes; prior versions stay loadable. |
| `tools_api` / `toolsApi` | number | `1` | **SDK reads — stable** | Production-validated 2026-04-22. Bumped when the tool contract changes; prior versions stay loadable. |
| `shape` | `"single-step" \| "loop" \| "recurse"` | `"single-step"` | SDK reads, enforces allowed values | Rejects unknown shapes with a named error. |
| `model` | string | — | passthrough | Not validated. Consumers wire it into their driver. |
| `tools` | string[] | `[]` | SDK reads; default backend loads | Empty strings are filtered and duplicates collapse. Plugins resolve from `tools/<name>.{mjs,js,py}`; optional `tools/<name>.schema.json` supplies the model-facing contract. The default `mikro mcp` backend exposes each plugin in the REPL with keyword arguments. |
| `thinking` | `"minimal" \| "low" \| "medium" \| "high"` | — | SDK reads, enforces allowed values | Reasoning effort for the agent's own model calls. Rejects unknown levels with a named error. See [Reasoning effort](#reasoning-effort-thinking). |
| `temperature` | number (`0`–`2`) | — | SDK reads, enforces range | Sampling temperature for the agent's own model calls. Applied by `applyAgent` onto `config.temperature`, so it outranks mikro.yaml's top-level `temperature:` and is outranked by `--temperature`. `0` is greedy decoding, **not** unset. A non-number or an out-of-range value is rejected with a named error. Best-effort: pi/ai sends `temperature` on every one of its ten api families and drops it only on the `anthropic-messages` api — either when a reasoning level is set, or when the resolved model declares `compat.supportsTemperature: false`. Claude reached over OpenRouter (`openai-completions`) or Bedrock (`bedrock-converse-stream`) does *not* get that guard, so the model family alone does not tell you whether the pin took. |
| `system` | string | — | passthrough | Consumer is responsible for reading the file + handing its contents to the driver. |
| `scope.reads` | string[] | — | passthrough | Advisory. Enforced by individual tool handlers (e.g. brain's `read`). |
| `scope.writes` | string[] | — | passthrough | Advisory, same as above. |
| `budget.max_cost` / `maxCost` | number | — | passthrough | Consumer threads it into their budget tracker. |
| `budget.max_iterations` / `maxIterations` | number | — | SDK/consumer | Can be passed to `runAgent({ maxIterations })`. |
| `budget.max_depth` / `maxDepth` | number | — | passthrough | For recursive shapes. |
| `prompt.append-stop-protocol` / `append_stop_protocol` / `appendStopProtocol` | boolean | `true` | SDK reads, enforces boolean | Whether mikro appends its FINAL/repl termination protocol section to the system prompt. Set `false` for a deliberately bare prompt. A non-boolean is rejected with a named error. |

## Reasoning effort: `thinking`

```yaml
thinking: high
```

The `agent.yaml` twin of `mikro --thinking`. Under `mikro mcp`, `applyAgent`
writes it to the single field the whole stack already reads —
`config.gemini.thinkingLevel` → `llmComplete({ thinkingLevel })` → pi-ai's
`reasoning` option — so a declared level outranks the ambient `mikro.yaml`'s
`gemini.thinking-level` exactly the way the CLI flag does. There is no
separate per-agent channel to keep in sync.

Four things worth knowing before you set it:

- **It is not Google-only,** despite the `gemini.` prefix the config field
  inherited. pi-ai maps `reasoning` on every API family it supports: OpenAI
  Responses (`reasoning.effort`), OpenAI Completions and its
  deepseek / openrouter / zai / together dialects (`reasoning_effort`), Google
  (`thinkingConfig.thinkingLevel`), and Anthropic (`thinking.budget_tokens`).
- **Omitting it is not "provider default".** pi-ai explicitly *disables*
  reasoning when no level is given, on models that support it. So an agent that
  wants its model to think has to say so.
- **The level is a request, not a guarantee.** pi-ai clamps it to the levels the
  resolved model actually declares, and it searches *upward* first — so
  `thinking: minimal` on a model whose floor is higher comes back *raised*, not
  lowered. Treat it as a hint, and read the run's reported effort if the exact
  value matters.
- **It is not graded everywhere, and on `station/` it is a footgun** — see the
  next section before setting it on a local model.

`minimal`, `low`, `medium`, and `high` are the accepted values. pi-ai's own type
additionally has `xhigh` and `max`, but those are reachable only on models that
declare an explicit mapping for them, so `agent.yaml` rejects them today.

### `station/` models: leave `thinking` unset

`station/` models (`src/station-provider.ts`) declare
`compat.supportsReasoningEffort: false`, so pi-ai never sends a
`reasoning_effort` at all. The four levels therefore do not grade anything
there: `low` and `high` build the identical request, and the only thing a
declared level changes is that *some* level was declared.

On the llama.cpp Qwen MTP models that one bit is load-bearing in the wrong
direction. They carry `reasoning: true` +
`compat.thinkingFormat: "qwen-chat-template"`, which makes pi-ai send
`chat_template_kwargs.enable_thinking = !!reasoningEffort`:

| `agent.yaml` | request | `Qwen3.6-35B-A3B-MTP-GGUF` behaviour |
|---|---|---|
| no `thinking:` | `enable_thinking: false` | answers directly — **the QA'd baseline** |
| any `thinking:` level | `enable_thinking: true` | streams into `reasoning_content`, emits no `content` delta, parses as **empty** |

Three consecutive empty turns abort the run (`src/rlm.ts`), which `mikro mcp`
reports as `isError`. So reasoning-off is not an accident inherited from the
"omitting it is not a provider default" rule above — for these models it is the
deliberate, live-QA'd compat workaround documented in the
`src/station-provider.ts` header, and adding `thinking:` removes it. Every
shipped `station/` recipe under `examples/agents/` omits the field for this
reason.

FastFlowLM / NPU `station` models (`*-FLM`) declare `reasoning: false`, so the
field is simply inert on them rather than harmful.

## MCP discovery and unavailable agents

`mikro mcp` validates model pins and, for the default `mikro` backend, declared
tools on every discovery scan. A declaration is advertised as **UNAVAILABLE**
when it has no matching `.mjs`, `.js`, or `.py` file, uses a reserved REPL
name, or collides with a function from `.mikro/TOOLS.md`. The first detected
cause wins, the description includes its repair, and `tools/call` refuses the
run with that same cause.

The file, reserved-name, and collision probes do not pre-reject `prime` or
`prime-sdk` agents, whose dispatch surfaces resolve tools differently. Every
microagent description—available or unavailable—ends with
`Backend: <name>. Tools: a, b.` or `Backend: <name>. Tools: none declared.`

SDK loaders remain independently usable: a non-strict load can report a name
in `result.missing`, while default-backend MCP discovery refuses guaranteed
failures before a run starts.

## Extras

Any key not listed above is preserved on `AgentSpec.extras` so
domain-specific schemas can layer without a parser fork:

```yaml
# agent.yaml
schema_version: 1
tools: [search_corpus]

brain:
  reader_inline_media: true
  pending_writes_whitelist:
    - _pending/**/*.yaml
```

```ts
const spec = await sdk.loadAgentSpec("/path/to/agent");
// spec.extras.brain === { reader_inline_media: true, pending_writes_whitelist: [...] }
```

## Reserved directory suffix: `.proposed`

A directory whose name ends **`.proposed`** (matched case-insensitively) is a
*draft* awaiting human approval, and `mikro mcp` discovery skips it outright —
see `isProposedDir` in `src/mcp/agents.ts`. Because `tools/call` dispatches from
the same scan that builds `tools/list`, a draft is **neither listed nor
callable**; calling it by its would-be tool name answers
`Unknown tool: mikro_<name>_proposed`.

This is the propose-only boundary behind `/mikro:microagent-create`, which writes
candidate agents into `.mikro/agents/<name>.proposed/` and stops. Activation is a
rename performed by the user:

```bash
mv .mikro/agents/<name>.proposed .mikro/agents/<name>
```

The tool appears on the next request — live refresh, no reconnect — and renaming
back withdraws it.

**So do not name a real agent `<something>.proposed`.** It would load fine via
`loadAgentSpec` and never appear as a tool, and the skip is silent by design:
there is no warning to notice.

## Errors the parser raises

| condition | error |
|---|---|
| YAML syntax error | `Error: agent.yaml: parse error: ...` |
| Top-level is not a mapping (e.g. a list or scalar) | `Error: agent.yaml: expected a YAML mapping at the top level` |
| `shape` is set to an unsupported value | `Error: agent.yaml: shape must be one of single-step \| loop \| recurse, got "..."` |
| `thinking` is set to an unsupported level | `Error: agent.yaml: thinking must be one of minimal \| low \| medium \| high, got "..."` |
| `temperature` is not a number, is non-finite, or is outside `0`–`2` | `Error: agent.yaml: temperature must be a number between 0 and 2, got ...` |
| `agent.yaml` file is missing (via `loadAgentSpec`) | `ENOENT` from `node:fs` |

Non-strings, non-finite numbers, and other type drift default
silently — the parser aims to be forgiving where there's no risk of
surprise.

`temperature` is the one exception to that forgiveness, and deliberately: a
`temperature: hot` that fell back to the ambient value would be
indistinguishable from a working pin, and pinning sampling is the only reason
to declare the field at all. An explicit `temperature: null` is still "unset",
the same as omitting the key.

### How `mikro mcp` reports them

Discovery must not let one bad agent take down the server, so `loadOne` skips
any directory whose `agent.yaml` fails to parse. It does **not** skip quietly:
when an `agent.yaml` exists but is invalid, the parser's message above is
written to **stderr** once per directory (discovery re-runs on every request, so
repeating it would flood the log), naming the agent and its path:

```
mikro: skipping agent "triage" (/repo/.mikro/agents/triage): agent.yaml: thinking must be one of minimal | low | medium | high, got "hgih"
```

A directory with *no* `agent.yaml` is not an error and stays silent — that is
just a folder that is not an agent. The other silent case is the `.proposed`
suffix below, which is skipped before the spec is read at all.

## Consumer schema evolution

When you need to validate additional fields — e.g. brain's
`scope.reads` enforcement — layer your own validator on top of
`AgentSpec.extras`. The SDK's parser is a floor, not a ceiling:

```ts
import { sdk } from "mikro";

const spec = await sdk.loadAgentSpec(path);
validateBrainExtras(spec.extras); // your layer; throws if non-compliant.
const registry = sdk.createToolRegistry();
// ... proceed ...
```
