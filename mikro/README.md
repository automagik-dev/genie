# mikro

RLM algorithm CLI for coding agents — prompt externalization, Python REPL with symbolic recursion, code-driven navigation.

Based on the [RLM paper](https://arxiv.org/abs/2501.12599) (REPL-based LLM Method). Uses [pi/ai](https://www.npmjs.com/package/@earendil-works/pi-ai) as the multi-provider LLM client, plus two native providers of its own (`station/`, `khal/`).

## Install

`scripts/install.sh` is the canonical installer — mikro is git-installed, not
npm-installed (see [`docs/release-contract.md`](docs/release-contract.md)):

```bash
curl -fsSL https://raw.githubusercontent.com/automagik-dev/mikro/main/scripts/install.sh | bash
```

It clones to `~/.mikro/mikro`, runs `npm ci --include=dev` and `npm run build`,
then symlinks `dist/src/cli.js` → `~/.local/bin/mikro`. Re-running it against an
existing checkout refreshes it in place. From a clone you already have,
`bash scripts/install.sh` (or `npm run install:local`) does the same.

Four env vars override the defaults: `MIKRO_REPO_URL`, `MIKRO_BRANCH`,
`MIKRO_INSTALL_DIR`, `MIKRO_BIN_DIR`.

### Update

```bash
mikro update            # fetch origin/main, rebuild in place
mikro update --force    # same, discarding local changes in the checkout
```

`mikro update` refuses to run over a dirty checkout without `--force`, then
resets to `origin/main`, reinstalls, rebuilds, and prints the before commit,
the target commit and the resulting version. Because `mikro` is a symlink into
that clone's `dist/`, this is what makes a new `main` commit take effect.

`mikro update` is safe to interrupt: the previous `node_modules` is parked
while `npm ci` runs and swapped back if the install fails, and `~/.local/bin/mikro`
is a dependency-free launcher (`bin/mikro.mjs`) that repairs a missing or
half-written `node_modules` before loading the CLI — so a killed update never
leaves you without a working `mikro`. Set `MIKRO_NO_SELF_HEAL=1` to disable
the repair (CI, or to see the raw error).

### Not on npm

mikro is not published to npm — `install.sh` is the only distribution channel,
and `mikro update` the only update path. The programmatic SDK still exists in
the same checkout; consume it as a git dependency (`dist/` is committed, so no
build step is needed on the consumer side):

```bash
npm install github:automagik-dev/mikro   # package name: mikro
```

This consumer install uses the consumer project’s npm manifest and lock; it is
not covered by Mikro’s checkout guard before dependency mutation.

## Quick Start

```bash
# Scaffold .mikro/ config in the current directory
mikro init

# Run a query
mikro "What is the meaning of life?"

# Query with context (directory of docs)
mikro "How does IPC work?" --context ./docs/

# Query with a single file as context
mikro "Summarize this paper" --context paper.md --output json

# Pipe data in
cat data.csv | mikro "Analyze this dataset"
```

## Use mikro from Claude Code / Codex (`mikro mcp`)

Offload repeatable work to a cheap or local model instead of paying host-model
prices for it every time.

```bash
claude mcp add mikro -- mikro mcp
```

That's it. Claude Code now has an `mikro_query` tool, plus **one tool per
microagent** you've defined — `mikro_triage`, `mikro_test_writer`, and so on — so
the model delegates to them by name.

**Claude Code users: there is a plugin.** It registers the same server with
`--dir` pointed at the project you have open, so agent discovery and the REPL
cwd agree with your project root instead of wherever the host spawned the
process:

```bash
claude plugin marketplace add ~/.mikro/mikro && claude plugin install mikro@mikro
```

The clone *is* the marketplace — `.claude-plugin/marketplace.json` sits at the
repository root — and `~/.mikro/mikro` is exactly where `install.sh` put it.
The plugin needs `mikro` on `PATH`, which is what `install.sh` provides; if the
server shows as failed in `claude mcp list`, check `command -v mikro` in the
shell that launched Claude Code. It ships that one server plus two skills
(`/mikro:offload-guidance`, `/mikro:microagent-create`). Details, limits and
honest positioning: [`plugins/claude-code/README.md`](plugins/claude-code/README.md).

### Tool contract

Every tool — `mikro_query` and each microagent — takes the same input, chosen to
mirror the host's own Agent tool so the model uses it without being taught:

| field | required | meaning |
| --- | --- | --- |
| `prompt` | yes | The task. A complete, standalone instruction: the agent runs to completion and cannot ask follow-up questions mid-run. |
| `query` | — | Deprecated alias for `prompt`. Pass one or the other, never both. |
| `session_id` | — | Continue an earlier call **on this same tool** — pass the `session_id` its result returned. |
| `context` | — | Path to a file or directory to load as context, relative to the server's working directory. Same as the CLI's `--context`. |
| `model` | — | `mikro_query` only: override the model as `"<provider>/<model>"`, e.g. `station/Brain-35B`. |

`prompt` and `query` are both schema-*optional* and exactly one is demanded at
runtime — JSON Schema can only say "exactly one of" via `anyOf`/`oneOf`, which
several MCP hosts flatten or reject, so the constraint lives in code and the
error names `prompt`.

Every result declares an `outputSchema` of `{answer: string, session_id: string}`
and returns both in `structuredContent`. `answer` is the text block byte for
byte, token/cost footer included — declaring an `outputSchema` also *permits* a
host to read `structuredContent` instead of `content`, so the answer has to be
in it or the whole delegated run is invisible to that host.

Pass `session_id` back to **the same tool** and the prior turns are replayed into
the new prompt. Sessions are in-process and time-limited: an expired id, an id
belonging to another tool, and an id with a call already in flight each get their
own named error. Resume is conversation replay, not REPL state — the Python REPL
is rebuilt per call and its state is deliberately not promised across turns.

A run that fails **without throwing** comes back as `isError` with the reason in
`answer`. mikro's two designed aborts — three consecutive empty LLM responses and
the wall-clock timeout — return their reason as the answer rather than raising,
so without this a host model would read the abort reason as the agent's report.
Both are matched by exact signal (the abort's `budgetHit`, the timeout's
verbatim answer), never by sniffing the answer for an `Error:` prefix — a report
that quotes a failing log line legitimately starts that way. A genuine
`max-cost`/`max-tokens`/`max-depth` budget hit still forces a real final answer
and stays a success: shorter, not failed.

**The tool set is live.** Every `tools/list` *and* every `tools/call` re-scans
the agent roots from one shared scan, and `notifications/tools/list_changed`
fires when the set actually changes — so an agent you author mid-session is
listed and callable with no reconnect.

Long runs emit `notifications/progress` per iteration, which keeps conforming
clients from timing out mid-delegation. `MIKRO_MCP_RUN_TIMEOUT_MS` lifts mikro's
own wall-clock cap.

> Not to be confused with `mikro acp` below. In ACP the *client* is an editor and
> the *agent* is the AI tool — Claude Code and Codex are agents themselves, so
> they can't drive mikro over ACP. MCP is the protocol they speak as clients.

## Microagents (`agent.yaml`)

A microagent is an `agent.yaml` folder ([full schema](docs/agent-yaml-schema.md))
in any of:

```
~/.mikro/agents/<name>/         # global
<project>/.agents/<name>/      # project — supported alias
<project>/.mikro/agents/<name>/ # project — the convention
```

`<project>/.mikro/agents/` is the convention: everything mikro owns in a
repository lives under one `.mikro/` directory next to `mikro.yaml`. `.agents/`
is scanned too and stays supported — an agent folder is portable between the
two, and `.mikro/agents/` wins when the same name exists in both. Project agents
shadow global ones with the same name, and `MIKRO_AGENTS_DIR` (colon-separated)
replaces every root. Roots are listed above in precedence order, lowest first.

Directory name → tool name: lowercased, anything outside `[a-z0-9_-]` folded to
`_`, prefixed `mikro_`. So `.mikro/agents/explore-r/` becomes `mikro_explore-r`.

```yaml
# ~/.mikro/agents/triage/agent.yaml
schema_version: 1
tools_api: 1
shape: loop
model: station/Qwen3.6-35B-A3B-MTP-GGUF   # local — $0 marginal cost
description: Classifies inbound issues and proposes a label + owner.
system: SYSTEM.md
# no `thinking:` — required here: on a station/ Qwen GGUF model any level
# makes the run abort empty. On a cloud model add `thinking: low`, where
# omitting it means reasoning *off*, not "provider default". Notes below.
budget:
  max_iterations: 6
  max_cost: 0.50
```

### Fields

Snake_case and camelCase are both accepted for every multi-word key. Unknown
keys are preserved on `AgentSpec.extras` rather than rejected, so you can layer
your own schema without forking the parser.

| field | default | what it does |
| --- | --- | --- |
| `schema_version` | `1` | Schema generation. Stable at 1; prior versions stay loadable. |
| `tools_api` | `1` | Tool-contract generation. Same guarantee. |
| `shape` | `single-step` | `single-step` \| `loop` \| `recurse`. An unknown value is a hard error. |
| `model` | ambient config | `"<provider>/<model>"` — `station/…`, `khal/…`, or any pi/ai provider. A bare model id keeps the configured provider. |
| `description` | — | One line the MCP client shows the host model. Falls back to the first meaningful line of the system prompt, then a generic string — an agent with neither is effectively invisible. |
| `system` | — | Path to the system prompt, relative to the agent directory. |
| `tools` | `[]` | Plugin names resolved from `tools/<name>.{mjs,js,py}`. Optional `tools/<name>.schema.json` supplies model-facing metadata; default `mikro mcp` bridges each plugin into the REPL. Missing, reserved, or `.mikro/TOOLS.md`-colliding names make that agent unavailable. |
| `budget.max_cost` | — | USD ceiling per run. |
| `budget.max_iterations` | — | Iteration ceiling. Threaded into `runAgent({ maxIterations })`. |
| `budget.max_depth` | — | Recursion depth ceiling, for `shape: recurse`. |
| `scope.reads` / `scope.writes` | — | Advisory glob hints. The SDK does **not** enforce them; individual tool handlers do. |
| `thinking` | ambient config | `minimal` \| `low` \| `medium` \| `high` — reasoning effort for this agent's own model calls. An unknown value is a hard error. The four levels are graded only on providers that accept a reasoning effort; on `station/` models they collapse to on/off, where **on breaks the Qwen GGUF models** — see the two notes below. |
| `temperature` | ambient config | Sampling temperature `0`–`2` for this agent's own model calls, the `agent.yaml` twin of `--temperature`. Writes the same `config.temperature` mikro.yaml's top-level `temperature:` writes, so an agent's value outranks the project's. `0` is greedy decoding — a real pin, not a synonym for unset — while an explicit `null` or an omitted key inherits. A non-number or an out-of-range value is a hard error, unlike most type drift in this parser: a temperature that silently fell back would be indistinguishable from one that took. Best-effort: pi/ai sends `temperature` on every api family and drops it only on the `anthropic-messages` api — when a reasoning level is set, or when the resolved model declares `compat.supportsTemperature: false`. Claude reached via OpenRouter or Bedrock does not get that guard, so the model family alone does not tell you whether the pin took. |

> **`thinking` is not tuning — it is a default worth overriding.** Omitting it
> does **not** mean "provider default": pi/ai explicitly *disables* reasoning
> when no level is given, so an agent that needs its model to think has to say
> so. A declared level outranks the ambient `gemini.thinking-level` exactly the
> way `--thinking` does, because it writes that same field — there is no second
> per-agent channel to keep in sync. Despite the `gemini.` prefix the config key
> inherited, this is **not** Google-only: pi/ai maps it onto OpenAI
> (`reasoning.effort`), Google (`thinkingConfig.thinkingLevel`), and Anthropic
> (`thinking.budget_tokens`) alike. Treat the level as a request rather than a
> guarantee — pi/ai clamps it to what the resolved model declares, searching
> *upward* first, so `minimal` on a model with a higher floor comes back raised.
> Full detail in [`docs/agent-yaml-schema.md`](docs/agent-yaml-schema.md#reasoning-effort-thinking).

> **Do not set `thinking` on a `station/` Qwen GGUF model.** There the field is
> not graded and reasoning-off is not an oversight — it is the QA'd workaround
> that makes the model answer at all. `station/` models declare
> `supportsReasoningEffort: false`, so no `reasoning_effort` is ever sent and
> `low` and `high` are indistinguishable; what the level actually toggles is
> `chat_template_kwargs.enable_thinking`, which pi/ai sets from *whether* a
> level was requested. Off, `Qwen3.6-35B-A3B-MTP-GGUF` answers. On, it streams
> everything into `reasoning_content` and never emits a `content` delta, so the
> turn parses as empty and three of those abort the run — surfaced as `isError`
> over MCP. This is why every shipped `station/` recipe in
> [`examples/agents/`](examples/agents/) omits the field. Rationale and the
> live-QA record: `src/station-provider.ts`.

> **Choosing `shape`.** mikro externalizes context into the Python REPL — the
> model has to *run code* to read it. So `shape: single-step` gives it one pass
> and it answers **before ever opening your file**. Use `single-step` only when
> the whole input fits in the prompt; use `loop` with a `budget.max_iterations`
> whenever the agent takes `context`. Symptom of getting this wrong: a
> confident answer and a suspiciously small input-token count in the footer.

### `.proposed` is a reserved suffix

A directory whose name ends `.proposed` (matched case-insensitively) is a draft
awaiting human approval. Discovery skips it **before the spec is parsed**, and
`tools/call` dispatches from that same scan, so a draft is neither listed nor
callable — calling it by its would-be name answers
`Unknown tool: mikro_<name>_proposed`. Activation is a rename you perform:

```bash
mv .mikro/agents/<name>.proposed .mikro/agents/<name>
```

The tool appears on the next request. This is the propose-only boundary behind
`/mikro:microagent-create`. **The skip is silent by design**, so do not name a
real agent `<something>.proposed`.

### Ready-made ones

Copy from **[`examples/agents/`](examples/agents/)** — the single recipe tree
([index](examples/agents/README.md)). Start with
[`explore/`](examples/agents/explore/): it answers a question about the repo it
runs in with `file:line` citations. Install it as
`<project>/.mikro/agents/explore/` and Claude Code gets an `mikro_explore` tool.
Also there: `codebase-qa`, `changelog` and `log-triage` (small, local-model,
ungated), and `explore-r` (recursive). Which worker model to run them on, and
what the evidence does and does not establish:
[`docs/worker-models.md`](docs/worker-models.md).

Each result ends with what it cost, so the offload is visible rather than
assumed:

```
mikro · agent=triage · station/Qwen3.6-35B-A3B-MTP-GGUF · 3 iterations · 307 in / 36 out · $0.00 · 3.9s
```

(`$0.00` is correct, not broken: `station/` models run locally and have no
per-token cost.)

Protocol and recipe smokes, run manually — CI does not:
`node scripts/smoke-mcp.mjs` (protocol) and `node scripts/smoke-explore.mjs`
(the `explore` recipe end to end, citations resolved against this checkout).

## SDK (`mikro.sdk.*`)

mikro also ships a programmatic SDK for consumers that need to drive
agents from code — with per-iteration observability, permission
hooks, validate-with-retry, session checkpointing, and a pluggable
tool registry. The CLI path above is untouched; the SDK is purely
additive.

```ts
import { readFile } from "node:fs/promises";
import { sdk } from "mikro";

const spec = await sdk.loadAgentSpec("./my-agent");
const registry = sdk.createToolRegistry();
await sdk.loadPluginTools(spec, registry);

for await (const ev of sdk.runAgent({
	agentId: "my-agent",
	sessionId: "s-1",
	input: "what's new?",
	driver: sdk.rlmDriver({
		model: { provider: "google", model: "gemini-2.5-flash" },
		system: await readFile("./my-agent/SYSTEM.md", "utf8"),
	}),
	toolRegistry: registry,
})) {
	console.log(ev.type, ev.timestamp);
}
```

The package has no `exports` map, so there are no subpaths — everything comes
off the root, and the SDK surface is namespaced under `sdk`.

**Stability stamp:** `schema_version: 1` + `tools_api: 1` are the fields every
shipped bridge has run against. The SDK's first production consumer is
`khal-os/brain`, a multi-agent pipeline whose L1 triage and L2 preservation
bridges both run through `sdk.runAgent()`; its outer-`IterationDriver` bridge
pattern is a reusable template for migrating a working agent into the SDK
without rewriting its internals.

Deeper dives:

- [`docs/sdk-overview.md`](docs/sdk-overview.md) — layered architecture + design principles.
- [`docs/events.md`](docs/events.md) — the 13-event catalogue + emitter contract.
- [`docs/tool-authoring.md`](docs/tool-authoring.md) — TS/MJS + Python plugin recipes.
- [`docs/agent-yaml-schema.md`](docs/agent-yaml-schema.md) — `agent.yaml` field reference.
- [`examples/agents/`](examples/agents/README.md) — **the** microagent recipe tree: `explore`, `explore-r`, `codebase-qa`, `changelog`, `log-triage`, plus the three runnable SDK walk-throughs with tests (hello-world / research-agent / brain-triage).
- [`examples/`](examples/) — `mikro.yaml` configuration examples (tauri-docs, paper-review, cag-*, gemini-*), which are not microagents.
- [`docs/worker-models.md`](docs/worker-models.md) — which model to run a microagent on: the round-2 evidence, per-arm price and run date, and what each arm's `n` does and does not establish.

## Live event stream (`rlmLoop({ emitter })`)

A real recursive `rlmLoop` run emits an observable, in-memory event
stream over the SDK's `createEmitter()` bus. This is the shared substrate
that the **mikro-acp adapter** (web client) and **pi's native TUI** consume
as renderers — mikro itself ships the events, not a UI.

### Subscribing (the contractual seam)

Pass a `createEmitter()` you have **already subscribed to** as
`rlmLoop`'s `emitter` option, so you receive events from the first
emission. Omit it and the run uses an internal emitter. The run closes
the emitter when it finishes (a `SessionClose` event, then the iterator
returns).

```ts
import { rlmLoop, sdk } from "mikro";

const emitter = sdk.createEmitter();

// Subscribe BEFORE the run starts.
(async () => {
	for await (const ev of emitter) {
		console.log(ev.type, ev.correlationId, ev.parentRunId);
	}
})();

await rlmLoop(query, context, config, { emitter }); // same signature the mikro-acp adapter uses
```

### Event schema

Events reuse the existing SDK `AgentEvent` union (see
[`docs/events.md`](docs/events.md)) — **no schema fork**. On the recursion
path every event additionally carries two optional ancestry fields:

| field | meaning |
| --- | --- |
| `correlationId` | Stable id of the node the event belongs to. For a spawned child it is the sortable `uuidv7()` minted at the spawn site; for a run's own iterations it is that run's self-correlation id. |
| `parentRunId` | The `correlationId` of the parent node — the ancestry edge (maps to the child process's `MIKRO_PARENT_RUN_ID`). Absent for the true root. |

**Build the recursion tree by keying on `correlationId` / `parentRunId`,
not `depth`** — `depth` cannot disambiguate sibling branches at the same
level, but two siblings of one parent always get distinct `correlationId`s.

Per-run producers and what they emit:

- `AgentStart`, `SessionOpen` — once at run start.
- `IterationStart`, `IterationOutput` — per parent iteration. `IterationOutput.metrics` carries per-node `latencyMs` / `toolCalls` / `costUsd` / `tokens` (incl. `reasoning`) from the wired `MetricsRecorder`, plus `responseModel` when the provider reports it.
- `ToolCallBefore` / `ToolCallAfter` — around each REPL execution.
- `Recurse` — **one per recursive `rlm_query` spawn**, carrying the child's `correlationId` and `parentRunId` (this run) — the ancestry edge.
- `IterationOutput` (child-completion) — bridged from `RlmChildResult.usage` when a child settles: the child node's cost / tokens / latency, keyed by its `correlationId`. A failed child additionally emits an `Error` (`phase: "recurse"`).
- `EmitDone`, `SessionClose` — once at run end.

### Headless subscriber (reference consumer)

[`scripts/watch-headless.mjs`](scripts/watch-headless.mjs) is the reference
consumer: it logs one compact JSON line per event (so `"type"` is
greppable) and reconstructs the recursion tree by `correlationId`.

```bash
# Deterministic proof (no credentials needed): a >=2-level recursive run
# with sibling branches at two levels.
node scripts/watch-headless.mjs -- "decompose and recurse on each part"
node scripts/watch-headless.mjs -- "…" | grep -c '"type":"Recurse"'   # one line per spawn

# Against a real run (needs a working model endpoint / provider key):
MIKRO_HEADLESS_REAL=1 node scripts/watch-headless.mjs -- "your prompt"
```

### Scope note

Level-2 **live child-internal** streaming — a child's own iterations
surfaced to the parent bus over `src/ipc.ts` — is **not** included. A
recursive child is summarized as a single bridged completion node; the
root subscriber sees its direct spawns, and a collector aggregating the
process tree reconstructs deeper levels by `correlationId`. Streaming
child-internal events into the parent stream is the documented next step.

## ACP agent (`mikro acp`) — wire mikro into an ACP host

> **⚠️ Experimental.** `mikro acp` works and is tested end-to-end, but its
> protocol surface may change without a deprecation cycle, and v1 **serializes
> prompt turns within a single active session** — a concurrent
> `session/prompt` is rejected with JSON-RPC `-32600` rather than queued. Every
> other part of mikro documented here is stable.

`mikro acp` is a stdio [Agent Client Protocol](https://agentclientprotocol.com)
agent: newline-delimited JSON-RPC over **stdin/stdout**, so any ACP client can
drive a real `rlmLoop` and render its live event stream. No port, no daemon —
the client spawns the process and owns its lifetime.

Mikro checkouts use npm and the committed v3 `package-lock.json` as their sole
dependency authority. Use `npm run deps:ci` for local installs: it rejects
incoherent metadata and competing root locks before invoking `npm ci`. CI, the
canonical installer, updater and launcher repair use the same guard before
dependency recovery or installation. Deliberately running raw `npm ci` or
`npm install` bypasses that protection and is unsupported by this guarantee.

### One-time: find your absolute launch command

Every host entry needs the **absolute** path to the built CLI. Compute it once:

```bash
# From a clone of this repo:
npm run deps:ci && npm run build
node -e "console.log(require('path').resolve('dist/src/cli.js'))"
# → /ABS/PATH/TO/mikro/dist/src/cli.js   ← use THIS everywhere below
```

The launch command is always: **`node /ABS/PATH/TO/mikro/dist/src/cli.js acp`**
run **with `cwd` set to the project you want mikro to operate in** (mikro loads
`.mikro/mikro.yaml` from `cwd`, exactly like the CLI). Substitute your real
absolute path for `/ABS/PATH/TO/mikro` in every snippet — nothing else changes.

> Sessions are durable. mikro persists each ACP session (conversation history +
> cwd + config snapshot + any host MCP config) to `~/.mikro/acp-sessions/<id>.json`,
> so `session/load` and a follow-up prompt keep working **after the host
> restarts the agent** — no "Invalid params". Override the store location with
> `MIKRO_ACP_SESSIONS_DIR`.

### From Claude Code, Codex, or Hermes — via `acpx`

**This is the main path.** In ACP, the *client* is the editor and the *agent* is
the AI tool. Claude Code and Codex are themselves **agents**, so they cannot
consume `mikro acp` directly — two agents don't speak to each other.

Bridge them with [`acpx`](https://github.com/openclaw/acpx), a headless ACP
client (verified with acpx 0.12.0). Any harness that can run a shell command
then drives mikro:

```bash
# From /ABS/PATH/TO/your-project (this becomes the session cwd):
AGENT="node /ABS/PATH/TO/mikro/dist/src/cli.js acp"

# One-time: register an acpx session for this cwd, driven by mikro.
npx --yes acpx --agent "$AGENT" --cwd "$PWD" sessions new

# Then drive prompts by hand, repeating as you iterate (--approve-all skips
# permission prompts; drop it to answer them interactively):
npx --yes acpx --agent "$AGENT" --cwd "$PWD" --approve-all "What does this repo do?"

# Or the repo's own scripted end-to-end smoke (spawns + drives the agent):
node /ABS/PATH/TO/mikro/scripts/smoke-acp.mjs              # fast handshake + prompt
node /ABS/PATH/TO/mikro/scripts/smoke-acp.mjs --multiturn  # survives an agent restart
node /ABS/PATH/TO/mikro/scripts/smoke-acp.mjs --recursive  # live translated recursion stream
```

### From an ACP editor client

Any editor that is a real ACP client can spawn mikro directly — no `acpx` needed.
Zed is the reference implementation (Zed Industries authored ACP):

```jsonc
// Zed settings.json
{
  "agent_servers": {
    "mikro": {
      "command": "node",
      "args": ["/ABS/PATH/TO/mikro/dist/src/cli.js", "acp"],
      "cwd": "/ABS/PATH/TO/your-project",
      "env": { "MIKRO_ACP_RUN_TIMEOUT_MS": "660000" }
    }
  }
}
```

Other ACP clients take the same three inputs — `command`, `args`, `cwd` — in
whatever shape their config uses.

### Remote (stdio over SSH) — first-class

Because the transport is pure stdio, a host on your laptop can drive mikro on a
remote box with **no port, no tunnel, no `-t`** — SSH pipes stdin/stdout for
you. Point the host's `command` at `ssh` and pass the remote launch as args:

```jsonc
{
  "command": "ssh",
  "args": [
    "REMOTE_HOST",
    "/ABS/PATH/ON/REMOTE/node", "/ABS/PATH/ON/REMOTE/mikro/dist/src/cli.js", "acp"
  ],
  "cwd": "/ABS/PATH/TO/local-placeholder"
}
```

- **Use the remote node's absolute path — not bare `node`.** A non-interactive
  SSH command (`ssh HOST node …`) does **not** source your login shell, so a
  `node` installed via a version manager (nvm, fnm, asdf, volta) or under
  `~/.local/bin` is **not on `PATH`** and you get `bash: node: command not
  found`. Find the absolute path once from an interactive session on the remote
  box — `ssh REMOTE_HOST` then `command -v node` (e.g. `/home/you/.nvm/versions/node/v20.11.0/bin/node`)
  — and hard-code it. (If node is installed system-wide at `/usr/bin/node`,
  bare `node` happens to work, but the absolute path is always safe.)
- Do **not** pass `ssh -t` — a PTY injects terminal control bytes that corrupt
  the JSON-RPC frame stream. Plain `ssh <host> /abs/node … acp` (no PTY) is
  correct.
- The session `cwd` that matters is the **remote** one; set it via the remote
  project dir where you launch, or by prefixing `cd /remote/project &&`.
- To pass env to the remote agent, set it in the remote command (SSH does not
  forward local env by default), e.g.
  `ssh REMOTE_HOST "MIKRO_REPL_TIMEOUT_MS=600000 /ABS/PATH/ON/REMOTE/node /abs/…/cli.js acp"`.

### Env legend

| Env var | Effect |
| --- | --- |
| `MIKRO_ACP_RUN_TIMEOUT_MS` | Override `rlmLoop`'s internal wall-clock cap for an ACP-hosted turn (default 300000). Raise it for recursive turns whose child spawns run long. |
| `MIKRO_REPL_TIMEOUT_MS` | Max time a single REPL cell may run before it is killed. Raise it when a recursive `rlm_query` cell must outlast a slow child. |
| `MIKRO_ACP_SESSIONS_DIR` | Override the durable session-store directory (default `~/.mikro/acp-sessions`). Point it at scratch for hermetic tests. |
| `STATION_BASE_URL` / `LEMONADE_BASE_URL` | Local station/Lemonade gateway base URL (default `http://localhost:13305/api/v1`). |

Any provider API keys the chosen `.mikro/mikro.yaml` model needs are read from the
environment / `~/.mikro/settings.json` exactly as for the CLI.

### MCP servers (store + advertise only)

`initialize` advertises `mcpCapabilities` (`http` + `sse`), and mikro accepts and
**persists** the `mcpServers` a host passes on `session/new` / `session/load`.
mikro does **not** yet execute tools against those servers — there is no MCP
client wired in — so the config is stored/advertised for continuity, and MCP
tool execution is a documented follow-on. A host is not misled: the advertised
capability carries `_meta["mikro/mcp"] = "store-and-advertise-only; no MCP client
execution yet"`.

### Node-field legend — `rlm:` tool-call nodes

Each recursive `rlm_query` spawn surfaces as a flat ACP tool-call node with
`toolCallId = "rlm:<childCorrelationId>"`. Its completion `tool_call_update`
carries machine-readable per-node data under `_meta["mikro/node"]`:

| `_meta["mikro/node"]` field | meaning |
| --- | --- |
| `correlationId` | The child node's stable id (sortable `uuidv7()` minted at the spawn site). Join key for the recursion tree. |
| `parentRunId` | The spawning run's `correlationId` — the ancestry edge (absent for the root). |
| `depth` | Recursion depth of this child (`[d{depth}]` also appears in the node title). |
| `latencyMs` | Child wall-clock latency in ms. |
| `costUsd` | Child cost in USD (may be absent on keyless/local providers). |
| `tokens` | `{ input, output }` token counts for the child. |
| `error` | `{ name, message }` when the child failed (node status `failed`). |

A `tool_call_update` for an ordinary REPL execution instead carries
`_meta["mikro/durationMs"]`. Client-facing payloads (args / output / titles) are
width-bounded and secret-redacted at the translator boundary before they cross
the web boundary.

## Running CLI commands

Use `run_cli(cmd, *args, timeout=10, check=False, input=None)` in the Python
REPL or `.mikro/TOOLS.md` to run a command directly and capture its output.
It returns `{returncode, stdout, stderr}`. Timeouts and missing commands return
`returncode: -1` with an error in `stderr`; `check=True` raises on nonzero exits.

```python
r = run_cli("git", "log", "-n", "10", "--oneline")
out = r["stdout"]
```

## How It Works

mikro implements the RLM (REPL-LM) algorithm:

1. **Prompt externalization** — Your context (files, directories) is loaded into a Python REPL as the `context` variable. Only metadata (type, size, chunk lengths) appears in the LLM message history. The LLM never sees the raw context in its messages.

2. **Iterative REPL loop** — The LLM writes Python code in ` ```repl``` ` blocks. mikro executes each block in a persistent Python subprocess, feeds results back, and the LLM iterates until it calls `FINAL()` or `FINAL_VAR()`.

3. **Recursive sub-calls** — Inside REPL code, the LLM can call:
   - `llm_query(prompt)` — single LLM completion (fast, one-shot)
   - `llm_query_batched(prompts)` — concurrent LLM calls
   - `rlm_query(prompt)` — spawn a child RLM session (full iterative loop)
   - `rlm_query_batched(prompts)` — parallel child RLM sessions

4. **Termination** — The loop ends when the LLM calls `FINAL("answer")` or `FINAL_VAR("variable_name")`, or when max iterations (default 30) is reached.

## CAG Mode (Cache-Augmented Generation)

CAG mode bakes your full context into the system prompt and leverages provider-level caching so that subsequent queries against the same context are dramatically cheaper and faster.

### When to use `--cache` vs default RLM

| Mode | Best for | How it works |
|------|----------|-------------|
| **Default (RLM)** | Large corpora, exploratory analysis | Context loaded into REPL `context` variable; LLM navigates it programmatically |
| **`--cache`** | Repeated questions on same docs, study sessions, batch Q&A | Full context injected into system prompt and cached at the provider |

Use `--cache` when you plan to ask multiple questions about the same set of documents. Use default RLM when the context is too large for a single system prompt or you need programmatic navigation.

### Cost comparison

| Query | Cost |
|-------|------|
| First query (cache miss) | Full input token cost (context + prompt) |
| Subsequent queries (cache hit) | **50-90% cheaper** -- only cache-read tokens are billed |

The exact savings depend on your provider. Google and Anthropic both offer significant discounts on cached input tokens.

### Batch usage

Process a list of questions against cached context:

```bash
mikro batch questions.txt --context ./docs/
mikro batch questions.txt --context ./docs/ --output json
```

Each question in the file is run sequentially, reusing the cached context. The first question pays full cost; subsequent questions benefit from the cache. `--parallel <n>` runs them concurrently.

### Cache warmup and estimation

Warm the cache and estimate costs before running queries:

```bash
mikro cache --context ./docs/ --estimate
```

This loads your context, calculates token counts, and shows estimated costs for cached vs uncached queries without making any LLM calls.

### YAML configuration

Enable cache in your `.mikro/mikro.yaml`:

```yaml
cache:
  enabled: true              # or use --cache flag per-invocation
  retention: long            # short|long -- maps to provider cache retention
  ttl: 3600                  # seconds -- provider-specific TTL
  expire-time: ""            # ISO 8601 -- for Google explicit caching
  session-prefix: "myproject" # prepended to content hash for sessionId
```

`session-prefix` is YAML-only — there is no `--session-prefix` flag.

For detailed provider-specific TTL behavior (Google, Anthropic, Bedrock, OpenAI), see [docs/TTL_CONTROL.md](docs/TTL_CONTROL.md).

## Gemini 3 Native

mikro integrates Gemini 3 native features. All are opt-in, additive, and silently ignored on non-Google providers.

### Quick Start

```yaml
# .mikro/mikro.yaml
model:
  provider: google
  model: gemini-3.1-flash-lite-preview

gemini:
  thinking-level: medium      # Control thinking depth
  google-search: true          # Web search in REPL
  url-context: true            # Fetch URLs in REPL
  code-execution: true         # Server-side Python
  media-resolution:
    images: high               # ~1120 tokens/image
    pdfs: medium               # ~560 tokens/page
    video: low                 # ~70 tokens/frame
```

```bash
mikro "Research latest AI developments" --context ./notes/ --tools standard --thinking high
```

### Features

| Feature | Config | CLI Flag | Description |
|---------|--------|----------|-------------|
| Thinking levels | `gemini.thinking-level` | `--thinking` | minimal/low/medium/high — controls reasoning depth |
| Thought signatures | automatic | — | Multi-turn quality via pi/ai signature circulation |
| Structured output | `output.schema` | — | JSON Schema enforcement via API (not text parsing) |
| Google Search | `gemini.google-search` | — | `web_search()` battery in REPL |
| URL Context | `gemini.url-context` | — | `fetch_url()` battery in REPL |
| Code Execution | `gemini.code-execution` | — | Server-side Python alongside local REPL |
| Image Generation | `gemini.image-gen` | — | `generate_image()` via Nano Banana |
| Media Resolution | `gemini.media-resolution` | — | Per-type token cost control |
| Batch API | — | `--batch-api` | 50% cost reduction for bulk operations |
| Context Caching | `cache.enabled` | `--cache` | 90% discount on cached tokens |
| Function + Tools | automatic | — | Custom functions + built-in tools in one API call |

Three keys are accepted, validated and then **warn instead of doing anything** —
`gemini.computer-use`, `gemini.maps-grounding`, `gemini.file-search`. Setting one
prints a "planned" warning; nothing is wired up behind it.

### Cost Comparison

| Mode | Cost (per 1M tokens) | Savings |
|------|---------------------|---------|
| Base (flash-lite) | $0.075 input / $0.30 output | — |
| + Context caching | ~$0.0075 input (cached) | 90% on input |
| + Batch API | ~$0.0375 input / $0.15 output | 50% on all |
| Cache + Batch | ~$0.00375 input (cached+batch) | 95% on cached input |

**100 queries over 500K context: < $2.00** with cache + batch stacking.

### Provider Compatibility

| Feature | Google | Anthropic | OpenAI | Others |
|---------|--------|-----------|--------|--------|
| Thinking levels | native | ignored | ignored | ignored |
| Thought signatures | native | ignored | ignored | ignored |
| Structured output | API-enforced | FINAL() fallback | FINAL() fallback | FINAL() fallback |
| Web search/URL | native | error msg | error msg | error msg |
| Code execution | native | local only | local only | local only |
| Media resolution | native | ignored | ignored | ignored |
| Batch API | native | standard batch | standard batch | standard batch |
| Context caching | native | native | native | provider-dependent |

### Gemini Batteries (REPL Functions)

Available with `--tools standard` or `--tools full` when provider is Google:

```python
# In REPL code:
result = web_search("latest nodejs version")
print(result)

page = fetch_url("https://example.com/docs")
print(page[:500])

img_path = generate_image("architecture diagram of microservices")
print(img_path)
```

Non-Google providers get clear error messages: `"web_search() requires provider: google"`.

### Examples

See `examples/` for complete configs:
- `gemini-research/` — Web search + URL context research agent
- `gemini-multimodal/` — Media resolution + image analysis
- `gemini-cheap-batch/` — Maximum cost stacking example

## Config Files

Config lives in a `.mikro/` directory beside your project. `mikro init` scaffolds
it with inline comments; `mikro init --template code` uses the code-oriented
prompt set. **Only `.mikro/` is read** — a `SYSTEM.md` at the repository root is
silently ignored.

| File | Purpose |
|------|---------|
| `.mikro/mikro.yaml` | Model, context, budget, cache, storage, gemini config. Its presence is what makes mikro use the directory at all; without it you get built-in defaults. |
| `.mikro/SYSTEM.md` | System prompt sent to the LLM. Default: the RLM paper prompt. |
| `.mikro/CRITERIA.md` | Output format criteria appended to the system prompt. |
| `.mikro/TOOLS.md` | Custom Python functions injected into the REPL namespace. |

Model selection is the `model:` block in `.mikro/mikro.yaml`, `--model <ref>` for
one run, or `mikro config set model.provider …` globally. There is no
`MODEL.md` — nothing loads it.

### Sampling temperature

Provider-neutral, and deliberately **top-level** in `mikro.yaml` rather than
under `gemini:` — pi/ai maps `temperature` on every api family, not just Google's.

```yaml
# .mikro/mikro.yaml
temperature: 0   # 0-2. Omit the key (or set it to null) to send no temperature at all.
```

| Setting | Config | CLI Flag | Description |
|---------|--------|----------|-------------|
| Sampling temperature | `temperature` (top-level) | `--temperature` | 0-2 on the root loop's calls. `0` is greedy decoding, not "unset". Also settable per agent via `agent.yaml`'s `temperature:`, which outranks mikro.yaml and is itself outranked by the flag. Omitting it sends no temperature at all, leaving the provider's own default in place. |

Best-effort, like a thinking level: pi/ai sends `temperature` on every api family
and drops it only on the `anthropic-messages` api — when a reasoning level is
set, or when the resolved model declares `compat.supportsTemperature: false`.
Claude reached via OpenRouter or Bedrock is not subject to that guard, so the
model family alone does not tell you whether the pin took.

### Migrating from `rlmx` (`mikro migrate`)

Everything public was renamed from `rlmx` to `mikro` on 2026-08-29: the
binary, `.rlmx/rlmx.yaml` → `.mikro/mikro.yaml`, `~/.rlmx` → `~/.mikro`, the
MCP server key, the Claude Code plugin id, `RLMX_*` env vars. Old config is
still *read* (with a warning) so nothing breaks the day you update, but the
Claude Code plugin registration and any `.mcp.json` that spawns `rlmx mcp`
cannot fall back — there is no `rlmx` binary any more.

```bash
mikro migrate                      # dry-run: list every legacy artifact found
mikro migrate --apply              # perform the rewrites (JSON files are backed up beside themselves)
mikro migrate --root ~/work --exclude backups --depth 4   # widen / narrow the scan
```

It scans the current directory and `$HOME` (bounded depth, skipping
`node_modules`, `.git`, dot-directories) for: project `.rlmx/` dirs,
`.mcp.json` servers with `command: rlmx`, `~/.rlmx`, the `~/.local/bin/rlmx`
symlink, and the plugin registration under `~/.claude/`. Shell rc lines
mentioning `~/.rlmx` or `RLMX_*` are reported; add `--rc` to rewrite them too
(backup beside the file). `RLMX_*` variables already exported in the running
shell are reported only. `mikro upgrade` is an alias.

### Custom providers (`providers:`)

Any OpenAI-compatible, Anthropic-compatible or OpenAI Responses endpoint can be
declared in config and then used as `<id>/<model>` anywhere a model ref is
accepted — `model:` in `mikro.yaml`, `--model`, an agent's `model:` pin, or the
MCP `model` argument. Nothing per-vendor is hard-coded: the declaration *is*
the provider.

```yaml
# .mikro/mikro.yaml (project) — or the same keys under "providers" in
# ~/.mikro/settings.json (global; camelCase accepted). A project entry
# replaces a global entry with the same id.
providers:
  wafer:
    api: openai-completions        # default; also anthropic-messages, openai-responses
    base-url: https://pass.wafer.ai/v1
    api-key-env: WAFER_API_KEY     # env var name (or a list — first one set wins)
    headers:                       # sent on every request
      Wafer-ZDR: required
    models:
      GLM-5.3-Flash:
        context-window: 128000
        max-tokens: 16000          # reasoning tokens count against this on GLM
        reasoning: true
        input: [text]              # add `image` for vision models
        cost: { input: 0, output: 0, cache-read: 0, cache-write: 0 }  # $ per 1M tokens
  deepseek:
    base-url: https://api.deepseek.com/v1
    api-key-env: DEEPSEEK_API_KEY
    models: [deepseek-chat, deepseek-reasoner]   # list form; defaults per model
```

Keys are env-only — the config names the variable, never holds the value.
`mikro doctor` lists every declared provider, which key variable is set, and
whether the configured `model:` resolves. `mikro mcp` validates every
microagent's pin at discovery time. A tool whose provider or model is not
resolvable is advertised as **UNAVAILABLE** with the reason, as is a default
`mikro` agent with missing tools, a reserved REPL tool name, or a tool that
collides with `.mikro/TOOLS.md`. Calling an unavailable tool returns the same
cause and repair instead of starting a run. Declaring the provider or repairing
the tool heals it on the next `tools/list` — no restart. Every microagent
description, available or unavailable, ends with `Backend: <name>. Tools: …`
(or `Tools: none declared.`); `mikro` is the default backend.

### TOOLS.md Format

Define custom REPL tools as `## heading` + `python` code block:

```markdown
## search_docs
` ``python
def search_docs(keyword):
    """Search context for files matching keyword."""
    matches = [item for item in context if keyword.lower() in item['content'].lower()]
    return [m['path'] for m in matches]
` ``

## summarize_chunk
` ``python
def summarize_chunk(text, max_words=100):
    """Summarize a chunk of text."""
    return llm_query(f"Summarize in {max_words} words:\n{text}")
` ``
```

## CLI Reference

`mikro --schema` prints the machine-readable flag/output/exit-code contract as
JSON — that is the generated source of truth; this table is the readable copy.

```
mikro "query" [options]                              Run an RLM query
mikro init [--template default|code] [--dir <path>]  Scaffold .mikro/ config
mikro cache [options]                                Pre-warm cache or estimate context size
mikro batch <file> [options]                         Bulk interrogation from a questions file
mikro benchmark <mode> [options]                     Run benchmarks (cost or oolong)
mikro stats [options]                                Query run history and cost breakdowns
mikro config <set|get|list|delete|path>              Manage ~/.mikro/settings.json
mikro doctor                                         Health check: providers, config
mikro update [--force]                               Fetch latest main commit for a git install
mikro acp                                            Run as a stdio ACP agent (EXPERIMENTAL)
mikro mcp [--dir <path>]                             Run as a stdio MCP server (agents as tools)

Options:
  --context <path>        Path to context (directory or file)
  --output <mode>         Output mode: text (default), json, stream
  --verbose               Show iteration progress on stderr
  --max-iterations <n>    Maximum RLM iterations (default: 30)
  --timeout <ms>          Timeout in milliseconds (default: 300000)
  --dir <path>            Working directory for init and mcp (default: cwd)
  --help, -h              Show this help message
  --version, -v           Show version
  --schema                Output machine-readable CLI schema JSON

  --stats                 Emit JSON stats to stderr (or include in --output json)
  --log <path>            Write structured JSONL log to file
  --tools <level>         Tool level: core (default), standard, full
  --max-cost <n>          Maximum USD spend per run
  --max-tokens <n>        Maximum total tokens per run
  --max-depth <n>         Maximum recursive rlm_query depth
  --model <ref>           Model for this run: "provider/model" or a bare model id
  --ext <list>            File extensions for context dirs (comma-separated)
  --thinking <level>      Thinking level: minimal, low, medium, high (Gemini 3)
  --temperature <n>       Sampling temperature, 0-2 (default: unset, provider decides)
  --cache                 Enable cache mode (full context in system prompt)
  --no-session            Disable auto-save of session data
  --estimate              Show context size and cost estimate without caching (cache)
  --parallel <n>          Concurrent questions for batch command (default: 1)
  --batch-api             Use Gemini Batch API for 50% cost reduction (batch)
  --template <name>       Template for init: default or code
```

Sub-command shapes:

```bash
mikro benchmark cost [--output json]                 # built-in dataset
mikro benchmark oolong [--samples 5] [--idx 42]      # auto-installs HF datasets
mikro stats [--run <id>] [--costs] [--tools] [--since 24h|7d|30m] [--output json]
```

Exit codes: `0` success · `1` general/validation error, missing query, missing
provider key, or empty-response abort · `130` SIGINT · `143` SIGTERM.

`mikro doctor` exits `1` if any of the six provider keys it checks is unset,
so a healthy single-provider install can still exit nonzero. Read its output
for the individual provider status.

## Output Modes

### Text (default)

Prints the final answer to stdout.

### JSON

```bash
mikro "query" --output json
```

Returns:

```json
{
  "answer": "The answer to your query...",
  "references": ["docs/start/create-project.md", "docs/concept/inter-process-communication.md"],
  "usage": {
    "inputTokens": 12500,
    "outputTokens": 3200,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "totalCost": 0.0041,
    "llmCalls": 5
  },
  "iterations": 3,
  "model": "google/gemini-3.1-flash-lite-preview"
}
```

`answer`, `references`, `usage`, `iterations` and `model` are always present,
and `usage` always carries all six fields above. Optional additions:
`reasoningTokens` inside `usage` when the provider reports it, plus
`usageBreakdown` (root/child/total split on recursive runs), `budgetHit`,
`geminiCounts`, `geminiBatteriesUsed`, and `stats` (with `--stats`).

### Stream

```bash
mikro "query" --output stream
```

Emits JSONL events per iteration, then a final event.

## Context Loading

| Input | Behavior |
|-------|----------|
| `--context dir/` | Recursively reads `*.md` files as `list[{path, content}]` (extensions configurable via `context.extensions` / `--ext`) |
| `--context file.md` | Reads as single string |
| `--context file.json` | Parses JSON as dict or list |
| stdin pipe | Reads as single string |

## Settings and Environment Variables

Provider keys can live in the environment or in `~/.mikro/settings.json`, which
`mikro config set` writes. Priority is **CLI flags > settings.json >
`.mikro/mikro.yaml` > defaults** — settings.json outranks the project YAML on
purpose, so `mikro config set model.provider openai` takes effect in a checkout
that has its own `model:` block.

```bash
mikro config set GEMINI_API_KEY <key>     # persisted, chmod-restricted
mikro config set model.provider google
mikro config list                         # API keys masked
mikro config path                         # ~/.mikro/settings.json
```

Recognised provider keys, as env vars or settings keys: `GEMINI_API_KEY`,
`GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`,
`XAI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `KIMI_API_KEY`,
`MOONSHOT_API_KEY`, `MINIMAX_API_KEY`, `ZAI_API_KEY`, `GLM_API_KEY`. A
settings-file key is injected into the environment only when that env var is not
already set, so the ambient environment always wins.

Other environment variables mikro reads:

| Env var | Effect |
| --- | --- |
| `MIKRO_AGENTS_DIR` | Colon-separated list that **replaces** the default microagent roots. |
| `MIKRO_MCP_RUN_TIMEOUT_MS` | Wall-clock cap for one `mikro mcp` tool call. |
| `MIKRO_ACP_RUN_TIMEOUT_MS`, `MIKRO_ACP_SESSIONS_DIR`, `MIKRO_REPL_TIMEOUT_MS` | See the ACP env legend above. |
| `STATION_BASE_URL` / `LEMONADE_BASE_URL` | Local `station/` gateway base URL (default `http://localhost:13305/api/v1`). |
| `KHAL_API_KEY` (or `MIKRO_KHAL_API_KEY`) / `KHAL_BASE_URL` | Credentials and endpoint for the native `khal/` provider. |
| `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Enable Langfuse trace export. |
| `MIKRO_PARENT_RUN_ID`, `MIKRO_CHILD_CORRELATION_ID`, `MIKRO_RECURSION_DEPTH` | Set by mikro on spawned recursive children — read, not authored by you. |

## Programmatic API

```typescript
import { rlmLoop, loadConfig, loadContext } from "mikro";

const config = await loadConfig("./");        // reads ./.mikro/
const context = await loadContext("./docs/");

const result = await rlmLoop("How does IPC work?", context, config, {
  maxIterations: 10,
  timeout: 60000,
  verbose: false,
  output: "json",
});

console.log(result.answer);
console.log(result.references);
```

## Requirements

- Node.js >= 22.19.0
- Python 3.10+ (for the REPL subprocess)
- An LLM API key (Anthropic, OpenAI, Google, etc.) — or a local `station/` gateway, which needs none

## Versioning

mikro uses **calendar versioning**: `1.YYMMDD.N`, where `YYMMDD` is the UTC build
date and `N` is a daily counter. The `1.` major (bumped from `0.` on
2026-08-17) declares the public surface production-ready; the rest of the
version still records *when* a build was cut, not what changed — read
[`CHANGELOG.md`](CHANGELOG.md), not the version delta, to learn about breaking
changes. The release boundary is a PR merge into
`main`, and the bump is **automatic** — CI derives the next version on merge and
commits it, so do not hand-run `npm run bump-version` in a PR unless you intend
that reviewed version to be the released one. See
[`docs/release-contract.md`](docs/release-contract.md).

## License

MIT — see [LICENSE](LICENSE) for the full text.
