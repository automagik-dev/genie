# Design: `rlmx acp` — ACP adapter for rlmx (web + editor consumption)

| Field | Value |
|-------|-------|
| **Slug** | `rlmx-acp-adapter` |
| **Date** | 2026-07-20 |
| **WRS** | 100/100 |

Parallel to `rlmx-live-tui` (which it depends on) and `extract-200-percent`. Turns rlmx's recursive
agents into an **ACP (Agent Client Protocol) agent** so an existing web client (Tidewave) + pi's
native TUI consume them — no bespoke UI, no reinvented transport. Reference: **pi-acp**.

## Problem

rlmx's agents are only reachable via its CLI/SDK — no standardized surface an editor, web UI, or
chat bridge can drive. And its recursive multi-agent execution (the whole point) has nowhere to be
*seen* by a human-facing client. ACP is the "LSP for agents" that fixes exactly this: a JSON-RPC
protocol with a real client ecosystem (Zed, VS Code, Neovim, JetBrains, and browser hosts). This
wish ships **`rlmx acp`** — an ACP agent that drives rlmx in-process and streams its recursion/tool
events as ACP session updates — so the station's agents are consumable "for free" by existing clients.

## Scope

### IN
- **`rlmx acp` subcommand** (inside `~/prod/rlmx`): a **stdio JSON-RPC ACP Agent** built on
  **`@agentclientprotocol/sdk`** (the official SDK — no hand-rolled JSON-RPC), mirroring pi-acp's
  structure (an ACP `Agent` + a session-translation layer).
- **Drive rlmx's instrumented recursion path in-process** (not `spawn` — rlmx has no `--mode rpc`).
  On `session/prompt`, run the **instrumented `rlmLoop`** (`src/rlm.ts`, the production `rlmx query`
  recursion path) — *not* the separate `sdk/runAgent` driver, which rlmx-live-tui explicitly leaves
  un-wired to recursion — and **subscribe the `createEmitter()` bus that rlmx-live-tui Group 2 wires
  onto `rlmLoop`**. The adapter obtains that run's emitter via the **same seam the headless subscriber
  uses** (this is the cross-wish contract: rlmx-live-tui must expose the per-run emitter to a caller,
  via `opts` injection or a returned stream — not only wire an internal one). Translate events →
  ACP `session/update` notifications:
  - `Message`/text → `agent_message_chunk`
  - `ToolCallBefore` → `tool_call` (pending); `ToolCallAfter` → `tool_call_update` (done/failed, `durationMs`)
  - `RecurseEvent` (spawn) → a **nested sub-agent `tool_call` node** — the recursion tree the client renders
  - `IterationOutputEvent.metrics` + bridged `RlmChildResult.usage` → per-node tokens/cost/latency
  - permission needs → `requestPermission`
- **Session lifecycle**: `initialize` / `authenticate` / `session/new` / `session/load` /
  `session/prompt`, with **durable session persistence + restore-on-empty** (the pi-in-Tidewave fix
  for multi-turn "Invalid params").
- **Tidewave-recognition capabilities** in the init handshake: advertise **`loadSession: true`** and
  **MCP-server support**, and **accept host-provided MCP servers** by materializing them into rlmx's
  config (pi did `syncProjectMcpConfig → .pi/mcp.json`). (Storing/advertising only — see OUT re: execution.)
- **Client wiring docs**: a Tidewave External Agent `exec` entry for `rlmx acp`, and a Newio `custom`
  ACP-type snippet. Dev/debug loop uses **Newio `acp-inspector`** (MIT) in isolation, then Tidewave e2e.

### OUT
- **A bespoke web UI** — reuse **Tidewave** (primary) / **Newio** (secondary). Only if those prove
  insufficient do we build one on **zvzuola/acp-components** (MIT) — explicitly deferred.
- **ACP remote (HTTP/WebSocket) transport** — WIP in ACP, and unnecessary: the *host* bridges stdio↔browser
  (Tidewave's ACP-over-WebSockets proxy; Newio's `agent-connector`). We ship plain stdio.
- **Adding an MCP *client* to rlmx** (actually *executing* host-provided MCP tools) — rlmx has no MCP
  client today; v1 advertises + stores the config for recognition, execution is a follow-on.
- **The recursion instrumentation itself** — that's `rlmx-live-tui`; this wish *consumes* its event stream.
- **Editor-specific polish** beyond the Tidewave target (Zed diff niceties, etc.) — later.

## Approach

**Chosen: a stdio ACP agent (pi-acp-shaped) that drives rlmx's SDK in-process and translates the
recursion event stream; target Tidewave for the web experience; let the host handle browser transport.**

The research settled every fork. **Transport is not our problem**: browser hosts already bridge to a
local stdio ACP agent — Tidewave runs an ACP-over-WebSockets proxy that *spawns* the stdio agent, and
`pi-acp` (our reference, same pi-ai base as rlmx) has already been made to run inside Tidewave as an
External Agent. So we ship the same stable stdio JSON-RPC agent pi-acp ships and skip ACP's WIP remote
transport entirely. The one structural change from pi-acp: it `spawn`s `pi --mode rpc` and gets
**crash/state isolation for free** (one subprocess per session — a throw in one can't kill the others);
**rlmx has no RPC mode**, so we drive the instrumented `rlmLoop` *in-process* and subscribe the
`createEmitter()` stream `rlmx-live-tui` wires. That is a richer event source but **trades away that
free isolation** — one node process hosts every ACP session. v1 pays for that deliberately (Decision
#9 / Risk #8): **serialize to one active session**, each `rlmLoop` run wrapped so a failure fails only
that session, never the agent; per-session subprocess/worker isolation (pi-acp's model) is the follow-on.

The pi-in-Tidewave integration gives us a **concrete capability spec** (three patches pi needed):
advertise `loadSession: true` + MCP support so Tidewave recognizes the agent; accept host MCP servers
into config; and restore persisted sessions when the in-memory map is empty. We bake these in from day
one rather than discover them as bugs. rlmx's recursion is the differentiator — mapping `RecurseEvent`
to nested ACP tool-call nodes is what makes the web client show the tree.

**Alternatives considered:**
- *Own web UI on acp-components* — real option, but reinvents what Tidewave gives for free (incl. the
  browser transport). Deferred to OUT. Rejected for v1.
- *ACP remote WS/HTTP transport* — WIP spec; the host already bridges. Rejected.
- *Spawn the rlmx CLI (pi-acp-literal)* — rlmx has no `--mode rpc`; in-process SDK is richer. Rejected.
- *Add an MCP client to rlmx to execute host tools* — scope creep; advertise+store for recognition, defer execution. Rejected for v1.
- *Wait for `extract-200-percent` fleet* — independent; the adapter works for any rlmx agent/query. Not a dependency.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Stdio JSON-RPC ACP agent** via `@agentclientprotocol/sdk`; no remote transport | Stable ACP transport; the host (Tidewave/Newio) bridges to the browser. Don't reinvent the wheel. |
| 2 | Drive the instrumented **`rlmLoop`** in-process (the recursion path, **not** `sdk/runAgent`), subscribe its `createEmitter()` | rlmx has no `--mode rpc`; `rlmLoop` is the recursion path rlmx-live-tui instruments — `runAgent` is a separate, un-wired driver. |
| 3 | **Depends-on `rlmx-live-tui`** (its instrumentation is the event stream translated) | Nothing to translate without the `RecurseEvent`/emitter wiring. |
| 4 | Primary target **Tidewave** (browser); secondary Newio; dev via `acp-inspector` | Proven: pi-acp already runs in Tidewave; adapter stays client-agnostic (any stdio ACP host). |
| 5 | Bake in **`loadSession:true` + MCP-advertise + session restore-on-empty** from day one | The exact patches pi needed to work in Tidewave — spec, not surprises. |
| 6 | Map **`RecurseEvent` → nested ACP tool-call node** | Makes the client render the recursion tree — rlmx's differentiator. |
| 7 | Packaged as **`rlmx acp` subcommand** in the rlmx repo | User choice; tight coupling to the emitter; one repo to version. |
| 8 | **No bespoke UI, no MCP execution** in v1 (both OUT) | Reuse existing clients; rlmx has no MCP client — advertise/store only. |
| 9 | **v1 = one active session, serialized**; each `rlmLoop` run isolated by a try/catch boundary | In-process drive collapses all sessions into one node process (no subprocess isolation); serialize + isolate so one session's failure never crashes the agent. Per-session worker isolation is the follow-on. |
| 10 | Pin the **emitter-subscription seam** as a cross-wish contract with rlmx-live-tui | `rlmLoop` today neither returns nor accepts an `EventStream`; the two wishes must agree how a caller obtains the per-run emitter (opts injection or returned stream). |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Depends on `rlmx-live-tui` instrumentation not yet built | High | Sequence after it; until then, translate against a recorded event fixture. `blocks`/`depends-on` declared. |
| 8 | **In-process drive loses pi-acp's per-session isolation** — one `rlmLoop` throw could crash every ACP session; concurrent `session/prompt` share one event loop + module state in `rlm.ts`/`llm.ts` | High | v1 **serializes to one active session** and wraps each run in a try/catch so a failure fails only that session; reject/queue overlapping prompts. Per-session subprocess/worker isolation = documented follow-on (Decision #9). |
| 9 | **Emitter seam undefined** — `rlmLoop` neither returns nor accepts an `EventStream` today | Medium | Pin the seam as the cross-wish contract (Decision #10); rlmx-live-tui exposes the per-run emitter to a caller (the headless subscriber needs the same). |
| 2 | Tidewave won't recognize the agent without the right capabilities | Medium | Replicate pi-acp's 3 patches (loadSession + MCP advertise + restore-on-empty); validate in `acp-inspector` then Tidewave. |
| 3 | ACP has no first-class "sub-agent/recursion" node — nesting representation may be awkward | Medium | Represent recursion as **nested `tool_call`** updates (widely rendered); acp-components/rlm-code event vocab as reference; keep a flat fallback. |
| 4 | rlmx recursion spans **child processes**; child-internal events aren't in the parent emitter | Medium | Same Level-1 boundary as `rlmx-live-tui`: child nodes appear on spawn, fill on `onChildEnd`; live child-internal is a later enhancement. |
| 5 | `@agentclientprotocol/sdk` 0.26 vs ACP spec churn (remote transport WIP) | Low | Pin the SDK; we only use stable stdio surface; track pi-acp's SDK bumps. |
| 6 | Advertising MCP support but not executing host MCP tools could mislead a client | Low | Advertise/store only where required for recognition; document that tool execution is rlmx-native in v1; MCP-client execution is a named follow-on. |
| 7 | Permission model mismatch (rlmx tool exec vs ACP `requestPermission`) | Low | Map to `requestPermission` when a client is attached; auto-allow in headless/inspector runs (configurable). |

## Success Criteria

- [ ] `rlmx acp` starts as a stdio ACP agent; **`acp-inspector` connects**, completes `initialize`
      (advertising `loadSession:true` + MCP support), and runs a `session/new` → `session/prompt` end-to-end.
- [ ] A **recursive** rlmx run surfaces in the ACP session as streamed `agent_message_chunk` +
      `tool_call`/`tool_call_update`, with **each `RecurseEvent` spawn represented as a distinct
      tool-call node — nested where the client supports it, flat otherwise** (per Risk #3) — carrying
      per-node tokens/cost/latency. (Criterion passes on either representation; it asserts the *events
      map to renderable ACP updates with metrics*, not that a specific client draws a tree.)
- [ ] **Multi-turn works**: `session/load` restores a persisted session and a follow-up `session/prompt`
      does **not** throw "Invalid params" (restore-on-empty implemented).
- [ ] **Runs as a Tidewave External Agent** (browser): a recursive run is visible/navigable in the web
      UI end-to-end. (If Tidewave setup is environmental, this criterion may be demonstrated via
      `acp-inspector` + a recorded Tidewave-handshake test, with the Tidewave run as QA.)
- [ ] Docs: Tidewave External Agent `exec` entry + Newio `custom`-type snippet + `acp-inspector` dev loop.
- [ ] `rlmx` build/test green; the adapter is additive (no regression to existing subcommands).

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content
digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `32d93546a60acaa5d28dd54b65745f20d1ba61f3f05ce9f9a6ea94d20dbe5965`
- **Reviewer:** genie reviewer (Opus 4.8, independent design gate)
- **Reviewed at:** 2026-07-20T22:24:03.000Z
<!-- genie-design-review:end -->
