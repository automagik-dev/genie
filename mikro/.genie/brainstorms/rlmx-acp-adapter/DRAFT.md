# DRAFT — rlmx-acp-adapter

`rlmx acp` subcommand: expose rlmx's recursive agents over the **Agent Client Protocol (ACP)** so
existing ACP clients — especially a web UI + pi's native TUI — drive them and see recursion/tool
events live. Reference implementation: **pi-acp** (svkozak/pi-acp).

## WRS
```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```
Research resolved: **ship plain stdio ACP agent — the host bridges to the browser.** Primary web
target = **Tidewave** (ACP-over-WebSockets proxy spawns a local stdio ACP agent; pi-acp already runs
inside it). Dev harness = Newio **acp-inspector** (MIT). Bake in the 3 pi-in-Tidewave patches. rlm-code
= sibling RLM engine, aware-of only. → Crystallized in DESIGN.md.

## Settled decisions (this session)
- **Drop the custom TUI** (amended out of rlmx-live-tui): viewing = this ACP adapter (web client) +
  **pi native TUI**. Don't reinvent the wheel.
- **Packaging: inside the rlmx repo** as a `rlmx acp` subcommand/subpackage (user choice).
- **Use `@agentclientprotocol/sdk`** for the ACP side (pi-acp uses ^0.26.0) — do NOT hand-roll JSON-RPC.
- **Drive rlmx in-process via its SDK** (not `spawn`): rlmx has NO `--mode rpc` (unlike pi). The
  adapter is an ACP Agent that, on `session/prompt`, runs rlmx's loop and subscribes `createEmitter()`.
- **depends-on `rlmx-live-tui`** (Group 2 instrumentation): the adapter consumes exactly the
  `RecurseEvent` / `IterationOutputEvent` / `ToolCallBefore/After` stream that wish wires. Without it
  there is nothing to translate.

## pi-acp anatomy (our template)
- Deps: `@agentclientprotocol/sdk ^0.26.0`. Bin `pi-acp`.
- `src/acp/agent.ts` — the ACP Agent: `initialize` / `authenticate` / `session/new` / `session/load`
  / `session/prompt`. Spawns `pi --mode rpc` (`PiRpcProcess.spawn`) — we replace this with in-process rlmx SDK.
- `src/acp/session.ts` — translation: pi events → ACP `sessionUpdate` notifications
  (`agent_message_chunk`, `tool_call`, `tool_call_update`), `requestPermission`, structured diffs.
- `src/pi-rpc/process.ts` — parses pi's JSONL rpc events → `PiRpcEvent`. Our analog subscribes rlmx's emitter.
- Session persistence via a small session-map file; slash/skill commands surfaced to the client.

## rlmx → ACP mapping (the clean fit)
| rlmx event (events.ts) | ACP sessionUpdate |
|---|---|
| Message / text_delta | `agent_message_chunk` |
| ToolCallBefore | `tool_call` (pending) |
| ToolCallAfter | `tool_call_update` (completed/failed, durationMs) |
| RecurseEvent (spawn) | nested `tool_call` "sub-agent" node (or ACP plan/child update) — the recursion tree |
| IterationOutputEvent.metrics | node metrics (tokens/cost/latency) attached to the update |
| RlmChildResult.usage (onChildEnd) | child node completion + usage |
| permission needs | `requestPermission` (client-driven) |

## OPEN (pending research agent aca9f9…)
1. **Transport for the web client:** ACP stdio (client spawns `rlmx acp`, like Zed) is stable; ACP
   remote WS/HTTP is WIP. Does **stdiobus** bridge stdio→WS so a browser consumes it without the WIP
   transport? Is **newio** the ready web client (and what transport does it want)? → decides transport.
2. **UI reuse:** does **zvzuola/acp-components** give web ACP rendering we reuse (don't reinvent)?
3. **rlm-code (SuperagenticAI):** sibling RLM engine — overlap/inspiration/anything to reuse?

## Scope (draft)
IN: a `rlmx acp` ACP Agent (via @agentclientprotocol/sdk) driving rlmx SDK in-process; translate the
recursion event stream → ACP session updates incl. the sub-agent/recursion tree; session new/load/prompt;
permission passthrough; a client-config snippet (npx-style) for the chosen web client.
OUT: ACP remote-transport spec work if a bridge (stdiobus) covers it; building a NEW web UI from scratch
(reuse the existing client / acp-components); the recursion instrumentation itself (that's rlmx-live-tui);
editor-specific polish beyond the target web client.

## Risk notes
- ACP `session/prompt` is one-shot request/streamed-updates; rlmx recursion spans child processes —
  the adapter must fan child-process events into one ACP session stream (same bridging as the TUI would need).
- @agentclientprotocol/sdk 0.26 vs ACP spec churn (remote transport WIP) — pin + track.
- Permission model: rlmx tool execution vs ACP `requestPermission` — map or auto-allow for headless.
