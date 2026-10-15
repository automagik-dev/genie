# Authoring tool plugins

A mikro agent is a folder with `agent.yaml`, optional `SYSTEM.md` /
`VALIDATE.md`, and a `tools/` subdirectory of per-tool plugin files.
The SDK loaders and the default `mikro mcp` backend load those files at
runtime. SDK consumers can dispatch them through `runAgent()`; the default
backend exposes them inside the Python REPL. Three flavours are supported.

## TS/MJS tool plugin

File: `<agent-dir>/tools/<name>.mjs` (preferred) or `<name>.js`.

```js
// tools/greet.mjs
export default async function greet(args, ctx) {
	// args  — an SDK tool_call payload or default-backend keyword args object
	// ctx   — { tool, sessionId, iteration, signal }
	if (ctx.signal.aborted) throw new Error("aborted");
	return { hello: args.name };
}
```

## Sidecar schema

Put optional model-facing metadata beside any JavaScript or Python plugin as
`tools/<name>.schema.json`. Both plugin loaders attach the sidecar to the
registry. Its shape is exactly:

```ts
export interface ToolSchema {
	readonly description?: string;
	readonly parameters?: Record<string, unknown>;
}
```

A complete `tools/echo.schema.json`:

```json
{
  "description": "Return the supplied text unchanged.",
  "parameters": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "Text to return." }
    },
    "required": ["text"],
    "additionalProperties": false
  }
}
```

The top level must be a plain object containing only `description` and
`parameters`. `description`, when present, must be a string; `parameters` must
be a plain object whose `type`, when present, is `"object"`. Nested JSON Schema
keys pass through unchanged, and `{}` is valid. An absent sidecar leaves the
handler schema-less. An unreadable, invalid JSON, or malformed sidecar throws
`InvalidPluginError` naming the sidecar and the reason.

Rules:

- **Default export only.** The loader imports the module dynamically
  and reads `module.default`. Named exports are ignored.
- **Must be a function.** The default export must satisfy
  `(args: unknown, ctx: ToolContext) => unknown | Promise<unknown>`.
  Anything else throws `InvalidPluginError` at load time.
- **Extension priority.** `.mjs` beats `.js` — pick one per name.
- **TypeScript source (`.ts`) is not loaded in this revision.**
  Compile to `.mjs` or `.js` first, or use `tsx`/`ts-node` in your
  runtime. A future slice will add native TS loading.

Loading:

```ts
import { sdk } from "mikro";

const spec = await sdk.loadAgentSpec("/path/to/my-agent");
const registry = sdk.createToolRegistry();
const result = await sdk.loadPluginTools(spec, registry);
// result: { loaded: ["greet"], skipped: [], missing: [] }
```

## Python tool plugin

File: `<agent-dir>/tools/<name>.py`.

```python
#!/usr/bin/env python3
"""tools/search_corpus.py — stdio-JSON tool."""
import json, sys

args = json.load(sys.stdin)
# ... your logic ...
result = {"hits": [{"id": i, "text": f"doc {i}"} for i in range(args["limit"])]}
json.dump(result, sys.stdout)
```

Protocol:

| direction | format | notes |
|---|---|---|
| stdin | JSON | Single value — what the agent sent as `tool_call.args`. |
| stdout | JSON | Parsed by the SDK; malformed → `PythonPluginError`. |
| stderr | free-form text | Captured but **not** interpreted. Surfaces via error payloads. |
| exit 0 | success | stdout must be valid JSON (empty stdout → `null`). |
| exit ≠ 0 | failure | `PythonPluginError` with `{exitCode, stderr, stdout}`. |

Loading (compose with the TS/MJS loader):

```ts
const js = await sdk.loadPluginTools(spec, registry);       // .mjs / .js first
const py = await sdk.loadPythonPlugins(spec, registry, {    // then .py for the rest
	timeoutMs: 30_000,
	// env is PROCESS.ENV by default — pass `{}` to isolate.
	env: { PATH: process.env.PATH, BRAIN_HOME: agentHome },
});
```

Options:

| option | default | purpose |
|---|---|---|
| `pythonBin` | `"python3"` | Override for venv paths or vendored interpreters. |
| `timeoutMs` | `30000` | Wall-clock budget. `null` disables. On overrun → `PythonPluginTimeoutError`. |
| `env` | `process.env` | Subprocess env. `{}` for isolation. |
| `cwd` | agent dir | `Path.cwd()` inside the plugin. |

Error taxonomy:

- `PythonPluginError` — non-zero exit, malformed stdout JSON, spawn
  failure (`ENOENT` on missing interpreter), missing script file.
  Always carries `exitCode`, `stderr`, `stdout`.
- `PythonPluginTimeoutError` — wall-clock overrun (SIGKILL). Carries
  `toolName`, `timeoutMs`.

Every call spawns a fresh subprocess — no pooling, no state leakage.
The ~50–100 ms interpreter startup is acceptable for sub-second
LLM-bound tool cadence.

## Calling bridged tools from the REPL

On the default `mikro` backend, each declared plugin becomes a Python stub of
the form `def <name>(**kwargs)`. Call it with keyword arguments, for example
`greet(name="Stéfani")`; `kwargs` is sent to the Node handler as one JSON
object and the JSON-round-tripped result is returned to Python. The sidecar
description and property names form the stub docstring; without a sidecar it
says `(arguments undocumented — pass keyword arguments)`.

A missing handler, handler failure, or non-JSON-serializable result raises
`RuntimeError` in Python without rejecting the enclosing REPL execution, and
the REPL stays alive. The bridge is at-least-once per code block: if crash
recovery replays a failed block, a side-effecting handler can run again. The
run's abort signal reaches JavaScript handlers as `ctx.signal`; `.mjs`/`.js`
handlers own their deadline and should abort work cooperatively.

## Reserved names

Declared tools on the default `mikro` backend must be Python identifiers,
such as `search_web` or `café`, and cannot be Python keywords such as `class`
or `await`. Names such as `web-search` and `2fa` are **UNAVAILABLE**. Leading
underscores are also unavailable because the REPL does not persist private
names. Python normalizes Unicode identifiers; names that normalize to the
same tool or a reserved name collide too. Rename the declaration and its file
together. The soft keywords `match`, `case`, and `type` remain valid names.

Declared tools on the default backend cannot use Python REPL globals or names
defined by the built-in battery files. This includes `FINAL`, `context`, and
`call_tool`. Discovery advertises an agent with a reserved declaration as
**UNAVAILABLE**; rename the tool and its file. A name that collides with a
function from `.mikro/TOOLS.md` is also unavailable. This discovery check does
not apply to `prime` or `prime-sdk`.

If any custom tool code fails during REPL startup or recovery, the run fails
with the tool name and Python error, and the partial REPL is stopped before
the model can use it. Writing a diagnostic to stderr alone is not a failure.

## Timeouts on the default backend

`MIKRO_REPL_TIMEOUT_MS` controls the enclosing REPL execution timeout (30,000
ms by default). The backend gives each Python plugin a timeout of
`Math.max(1, defaultReplTimeoutMs() - 1_000)`, so a slow plugin becomes a
Python `RuntimeError` before the REPL is killed. By comparison, direct SDK use
of `loadPythonPlugins` defaults `timeoutMs` to 30,000 ms. JavaScript handlers
have no separate per-tool timer; honor `ctx.signal` and impose a deadline in
the handler when its operation needs one.

## How tools reach the model on each backend

- **`mikro` (the default):** declared plugins become Python `**kwargs` stubs
  in the REPL, not native function declarations. Keyword arguments preserve
  the declared JSON object without an ambiguous positional mapping.
- **SDK `rlmDriver`:** sidecar schemas supply native function declarations.
  At least one tool remaining after `expose` must have a schema or construction
  throws `NoExposableToolsError`; omit `tools` only when one-shot behavior is
  intentional.
- **`prime-sdk`:** the shared loaders attach sidecars to Prime custom tools;
  its existing permissive object fallback remains when a sidecar is absent.
  The `prime` subprocess backend's behavior is unchanged.

Gemini code-execution paths outside mikro's REPL do not see bridged tools.
Declaring a tool without a matching `tools/<name>.{mjs,js,py}` file on the
default backend is `missing` and therefore **UNAVAILABLE**.

JavaScript plugins use dynamic ESM `import()`, so repeated loads of the same
resolved URL in one Node process reuse the module cache. Restart the process
after editing module-level plugin state. Plugins execute trusted code with the
host process's authority; audit their source and dependencies, and restrict the
Python `env` option where appropriate.

## Live `mikro mcp` bridge check

This live, non-CI check reproduces the original declared-tool path:

1. Start `mikro mcp --dir ~/workspace/repos/brain --verbose`, or add
   `--log /tmp/mikro-mcp.jsonl` for structured events.
2. From an MCP client, request `tools/list` and confirm `mikro_ask-maestro` is
   available with a `Backend: mikro. Tools: …` suffix.
3. Send an MCP `tools/call` request for `mikro_ask-maestro` with its normal
   input; `tools/call` is an MCP method, not a shell subcommand.
4. Confirm stderr or the JSONL log contains at least one declared-tool
   `ToolCallBefore`, nested inside the surrounding `tool: "repl"` event pair.

## Handler context

Every handler (TS / Python) receives a `ToolContext`:

```ts
interface ToolContext {
	readonly tool: string;            // the agent-declared name
	readonly sessionId: string;
	readonly iteration: number;
	readonly signal: AbortSignal;     // abort-at-boundaries
}
```

Honour `ctx.signal.aborted` in long-running handlers. The Python
loader already wires `signal.addEventListener("abort", ...)` to
`SIGKILL` the subprocess; TS/MJS handlers should check at cooperative
boundaries.

## Testing a plugin hermetically

```ts
import { sdk } from "mikro";

const registry = sdk.createToolRegistry();
await sdk.loadPluginTools(spec, registry);
const greet = registry.get("greet")!;
const out = await greet({ name: "Stéfani" }, {
	tool: "greet",
	sessionId: "t",
	iteration: 1,
	signal: new AbortController().signal,
});
// assert on `out`
```

For full end-to-end coverage with the event stream + permission chain
+ session checkpoint, pass the registry to `runAgent({ toolRegistry })`
and drive with a canned `IterationDriver`. See
[`examples/`](../examples/) for runnable walk-throughs.

## Production reference — `khal-os/brain`

The `examples/agents/brain-triage/` directory in this repo demonstrates the
Python-plugin pattern in minimal form. For a full production
implementation of the pattern across three bridged agents, see
`khal-os/brain`:

| agent | folder | tools registered |
|---|---|---|
| L1 triage | `.agents/triage/` | `read`, `emit_done` |
| L2 preservation | `.agents/preservation/` | `brain_list`, `brain_get`, `brain_search`, `validate`, `read_window`, `brain_write`, `brain_propose`, `emit_done` |
| L3 audit | `.agents/audit/` | sampled audit subset |

Each folder carries the same `agent.yaml` + `SYSTEM.md` +
`VALIDATE.md` shape this repo documents. The bridge driver
(`src/agent/mikro-bridge.ts` in brain) wraps each agent's existing
pi-agent loop as one outer iteration of `runAgent()`, preserving
retry / validate / stop-reason semantics exactly while gaining
SDK-level events, permissions, and session checkpointing.
