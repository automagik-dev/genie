# DRAFT — rlmx-live-tui

Parallel wish to `extract-200-percent` (ryzen-ai-station). This is the TUI that wish fenced OUT,
plus the pi-ai upgrade that unlocks the events to render.

## WRS
```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```
Resolved by the pi-ai diff research: bump breaks only 2 runtime imports (completeSimple/getModel
→ /compat in 0.80.0; migrate to Models runtime); rlmx ALREADY emits the full recursion surface
(RecurseEvent depth/parentDepth, IterationOutputEvent.metrics tokens/cost/latency/toolCalls, via
createEmitter multi-subscriber broadcast) → TUI is a rendering layer, not new plumbing. Cross-wish
dep: extract-200-percent's station provider needs 0.80's createProvider ⇒ this bump lands first.
→ Crystallized in DESIGN.md.

## The three asks (user)
1. **Diff pi-ai** in rlmx (pinned **0.77.0**) → latest (~0.80.10). What changed.
2. **Improvements**: adopt what makes rlmx better (esp. structured events we can render).
3. ⭐ **A live rlmx+pi-ai TUI** (in addition to the SDK) to **SEE the recursion happening** —
   parent→child agent spawns, depth, per-agent tokens/cost/latency, tool calls, live.

## Problem (draft)
rlmx's multiagent power (child-process recursion via `RLMX_RECURSION_DEPTH`/`buildChildEnv`) is
**invisible** — it runs headless through the SDK/CLI, so you can't watch a recursive run unfold.
And rlmx is pinned to an **old pi-ai (0.77.0)** while the current line (~0.80.x) adds lifecycle
hooks, cache-miss visibility, and richer session/RPC access we're not using. This wish (a) bumps
pi-ai and adopts what matters, and (b) ships a **live TUI on pi-tui** that renders the recursive
agent tree in real time.

## Known facts
- rlmx imports from `@earendil-works/pi-ai` at 4 sites in `src/` (see research agent).
- rlmx has its own event layer: `src/sdk/events.ts`, `src/sdk/emitter.ts`, `src/sdk/metrics.ts`
  (per-iteration cost/latency captured), `src/ipc.ts`.
- Recursion is child-process based (`src/llm.ts` `buildChildEnv`, `RLMX_PARENT_RUN_ID`,
  `correlationId`) — so a live view must aggregate events across processes (IPC/mailbox).
- pi ships **pi-tui** (differential render, Box/Container/Text/SelectList/Markdown/Loader/Image,
  Kitty/iTerm2 inline images) — the render substrate. pi-agent-core streams `message_update`
  events. pi.dev 0.80.4 added `agent_settled`/`before_provider_headers` hooks + cache-miss visibility;
  0.80.3 "richer RPC session tree access"; 0.80.8 live model-catalog refresh + centralized ModelRuntime.

## OPEN (pending research agent aa4cb…)
- Exact event schema for a recursion view (which events carry depth/parentRunId/tokens/tool-calls).
- Whether rlmx's existing emitter already exposes parent/child linkage, or the TUI must correlate
  via `RLMX_PARENT_RUN_ID`/`correlationId` over IPC/mailbox.
- Is 0.77→latest a safe minor bump or are there breaking changes?

## Scope (draft)
IN: pi-ai bump + adoption; a live recursion TUI (pi-tui) reading rlmx's event stream across the
process tree; wired to the local `station` provider (:13305) once extract-200-percent Group 1 lands.
OUT: the metric microagents themselves (that's extract-200-percent); a web UI; changing the
recursion mechanism itself.

## Dependency note
- **depends-on / relates-to** extract-200-percent Group 1 (the `station` local-provider patch) —
  the TUI wants to demo recursion against local models. If ordering matters, the pi-ai bump here
  should land compatibly with that patch (both touch pi-ai usage in rlmx).
