# Design: rlmx pi-ai upgrade + recursion observability + live TUI

| Field | Value |
|-------|-------|
| **Slug** | `rlmx-live-tui` |
| **Date** | 2026-07-20 |
| **WRS** | 100/100 |

Parallel to `extract-200-percent` (ryzen-ai-station). This is the TUI that wish deferred, plus the
pi-ai upgrade both wishes need — and, per design review, **the event instrumentation that must
exist before any TUI can show a recursion**.

## Problem

rlmx's real power — **child-process recursive multi-agent execution** — is **invisible**. It runs
headless; you cannot *watch* a recursive run unfold (who spawned whom, how deep, tokens/cost/latency
per agent, which tool fired). Worse than "no UI": the run path emits **no observable event stream at
all**. The CLI recursion path (`rlm.ts::rlmLoop` → `llm.ts::rlmQuery`) is bracketed only by Langfuse
spans + `onChildStart/End` callbacks; the SDK's `createEmitter()` event bus is wired for
`runAgent()`'s own events but **not** for the recursion path, and the `RecurseEvent` type has **no
producer anywhere in the codebase**. Separately, rlmx is pinned to a **stale pi-ai (0.77.0)**. This
wish (a) bumps pi-ai, (b) **instruments the recursion path to emit a real event stream**, and (c)
ships a **live pi-tui view** of the recursion tree — turning rlmx's best feature into something you
can see happen.

## Scope

### IN
- **pi-ai bump `0.77.0` → latest (0.80.10)**, `~/prod/rlmx`. The only break is two runtime value
  imports — `completeSimple`, `getModel` — that 0.80.0 moved to `@earendil-works/pi-ai/compat`
  (`src/llm.ts:8`, `src/sdk/rlm-driver.ts:62-65`); all `import type {…}` are unchanged. Migrate to
  the `Models` runtime (`builtinModels()`/`createModels()` — durable API; exposes `createProvider`
  the sibling wish needs) rather than the `/compat` band-aid. (`engines.node` is already `>=22.19`.)
- **Recursion observability instrumentation** (the enabler, `src/rlm.ts` + `src/llm.ts` +
  `src/sdk/`): this is real plumbing, not a rendering afterthought.
  - **Emit `RecurseEvent`** at the actual spawn site (`llm.ts::rlmQuery`, where `RLMX_RECURSION_DEPTH`
    is read and the child is spawned). The type exists (`events.ts:98`) but has **zero producers** today.
  - **Drive an emitter from the recursion path** (`rlm.ts::rlmLoop`) so a subscriber sees the
    parent's own iterations (`IterationStart/Output`, `ToolCallBefore/After`, `Session*`) live — the
    same `createEmitter()` bus `runAgent()` already uses, now wired into the CLI/recursion path
    (the wiring `emitter.ts`'s header defers as unfinished "Group 2-3" work).
  - **Bridge child-process results up:** child agents recurse in a *separate process*, so their
    internal events aren't in the parent. Carry each child's **final** usage/outcome to the parent's
    stream via the existing `onChildEnd`→`RlmChildResult { usage?: UsageStats, isError, durationMs }`
    channel (`llm.ts:391`). Tag nodes with the cross-process ancestry key
    **`RLMX_PARENT_RUN_ID`/`correlationId`** (`llm.ts:425-431,478`), not `depth` (depth ≠ identity
    when a parent spawns multiple children).
- **Low-risk adoptions in the same PR:** `uuidv7()` time-ordered IDs (replace `randomUUID()` at
  `llm.ts:478` — sortable ancestry IDs the tree wants), `contentText()`, and surface
  `Usage.reasoning`/`AssistantMessage.responseModel` into the metrics.
- **Live recursion TUI** on **pi-tui**: a `rlmx tui`/`rlmx watch` surface that subscribes to the
  now-wired emitter and renders a **live tree** — a node per `RecurseEvent`, nested by
  `correlationId`/parent-run-id, a `Loader` while in-flight, per-node **tokens/cost/latency/toolCalls**
  (parent nodes from `IterationOutputEvent.metrics`; child nodes from the bridged `RlmChildResult.usage`).
  Composed from pi-tui `Container`/`Box`/`Text`/`Loader` (no built-in tree widget).

### OUT
- **Fully-live *child-internal* streaming (Level 2):** animating a child's own iterations/tool-calls
  live requires streaming child-process events up over `src/ipc.ts`/`.genie/mailbox`. v1 shows child
  nodes on spawn and fills them on completion (from the bridged final result); the parent's own
  iterations are fully live. Level 2 documented as the enhancement.
- **Rewriting the recursion mechanism** — we *instrument* the child-process model (env-var ancestry,
  `rlmQuery` spawn), we do not replace it.
- **The metric microagents / station provider** — that's `extract-200-percent`. This wish only makes
  rlmx pi-ai-0.80-native (enabling that wish's `createProvider`) and observable.
- **Web UI / dashboard** — terminal only.
- **A full `runAgent`-based rewrite of the CLI path** — instrument the existing `rlmLoop`, don't replace it with `runAgent`.

## Approach

**Chosen: bump pi-ai to the `Models` runtime, instrument the recursion path to emit the existing
event types, then render that stream in pi-tui.**

The design review corrected the original thesis: the event *types* in `events.ts` carry the right
fields, but nothing in the live recursion path emits them — `RecurseEvent` has no producer, and
`rlmLoop` never touches the emitter (only Langfuse + `onChildStart/End`). So the TUI is **not** a
free rendering layer; the load-bearing work is **wiring the emitter into the recursion path and
adding the `RecurseEvent` producer**. That instrumentation is exactly the deferred "Group 2-3"
wiring `emitter.ts` documents as unfinished — this wish owns it, because no other wish does, and the
TUI is what validates it end-to-end.

Two channels, honestly separated: the **parent's** own iterations flow through the wired emitter
(`IterationOutputEvent.metrics`, which describes the emitting agent's iterations); **child** nodes,
running in separate processes, surface only their **final** usage via `onChildEnd`'s
`RlmChildResult.usage`. Tree structure keys on `correlationId`/`RLMX_PARENT_RUN_ID`, the real
cross-process ancestry, not on `depth`. The pi-ai bump is independent and small, but sequenced first
because the `Models` migration also unblocks the sibling wish's `station` provider.

**Alternatives considered:**
- *"Render the existing emitter, no plumbing" (original thesis)* — **refuted by code**: `RecurseEvent`
  has no producer and `rlmLoop` isn't emitter-wired. Rejected.
- *Anchor the TUI on Langfuse spans instead of instrumenting the emitter* — Langfuse is an external
  sink, not a live local subscriber surface; wiring the in-process emitter is the reusable, durable
  path that also completes rlmx's own SDK event vision. Rejected as primary.
- *Rebuild the CLI path on `runAgent()` (which already emits events)* — large rewrite of the working
  recursion loop; instrument in place instead. Rejected.
- *Split instrumentation and TUI into two wishes* — the TUI is the only consumer that validates the
  instrumentation; splitting risks emitting events nothing exercises. Kept together, isolated by group.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Bump pi-ai to latest via the **`Models` runtime** migration (2 import sites) | Only break in the window; durable API; exposes `createProvider` the sibling wish needs. |
| 2 | **Instrument the recursion path** — add the `RecurseEvent` producer at `rlmQuery`'s spawn + wire `rlmLoop`→emitter | The types exist but have no producers; this plumbing is the real work, not a rendering afterthought (design-review CRITICAL). |
| 3 | **Two metric channels:** parent iterations via `IterationOutputEvent.metrics`; child nodes via bridged `onChildEnd`/`RlmChildResult.usage` | Children run in separate processes; their internal events aren't in the parent (design-review MEDIUM). |
| 4 | **Tree identity = `correlationId`/`RLMX_PARENT_RUN_ID`**, not `depth` | Depth can't disambiguate sibling branches; env-var ancestry is the real key (design-review LOW). |
| 5 | v1 = child nodes appear on spawn, fill on completion; **child-internal live (Level 2) is OUT** | Delivers "see the recursion" without cross-process IPC streaming; honest boundary. |
| 6 | Surface = **`rlmx tui`/`rlmx watch`** subcommand; render with pi-tui primitives | rlmx has a subcommand CLI; no built-in tree widget, compose from `Container`/`Box`/`Text`/`Loader`. |
| 7 | Adopt `uuidv7`, `contentText`, `Usage.reasoning`, `responseModel` in the same PR | Cheap/additive; `uuidv7` gives sortable ancestry IDs. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Instrumentation touches the **hot recursion path** (`rlm.ts`/`llm.ts`) — regression risk to a working loop | High | Emit is synchronous/in-memory (emitter.ts) and additive; gate every step with a **recursive-run regression** before the TUI; never change control flow, only add emit points. |
| 2 | This completes the dormant SDK-events effort ("Wish B" per `emitter.ts`) — schema could diverge or collide | Medium | Reuse the existing `events.ts` types/`makeEvent` verbatim; only add the missing `RecurseEvent` producer + wiring; don't fork the event schema. |
| 3 | Cross-wish dep: `extract-200-percent` Group 1's `station` provider uses **0.80** `createProvider` (absent in 0.77) | High | This wish owns the bump + `Models` migration; sequence it to land first (or the sibling absorbs it). |
| 4 | Child nodes can only show **final** usage in v1 (internal iterations run in the child process) | Medium | Scope states it; child nodes render a `Loader` until `onChildEnd`, then fill from `RlmChildResult.usage`. Level 2 (IPC) is the documented next step. |
| 5 | pi-tui has no tree widget; hand-composed deep trees may flicker/mis-layout | Medium | Differential render + `Container` nesting; cap/scroll depth; validate on a ≥2-level, multi-sibling run. |
| 6 | `IterationOutputEvent.metrics` and its `costUsd`/`tokens` are **optional** (present only when a `MetricsRecorder` is wired) | Medium | The instrumentation wires the recorder on the recursion path; criteria assert metrics are populated, not assumed. |

## Success Criteria

- [ ] pi-ai pin is latest; `npm run check` (`tsc --noEmit`) + `npm run build` pass; a **recursive
      `rlmx` run still completes** (regression) — the two migrated call sites work.
- [ ] A real recursive `rlmx` run **emits `RecurseEvent`** (a producer now exists) and drives the
      emitter — verifiable by a headless subscriber that logs one node per spawn (proves instrumentation
      independent of the TUI).
- [ ] `rlmx tui`/`watch` launches a live view; a **≥2-level, multi-sibling** recursive run shows a
      **tree that grows a node per `RecurseEvent`**, a `Loader` per in-flight node, and per-node
      **tokens/cost/latency/toolCalls** (parent nodes from `IterationOutputEvent.metrics`, child nodes
      from bridged `RlmChildResult.usage`).
- [ ] **Tree ancestry is correct across sibling branches** — nodes nest by `correlationId`/parent-run-id,
      not depth (a grandchild renders under its true parent even with multiple children at a level).
- [ ] Adoptions landed: `uuidv7` ancestry IDs; `contentText` used; `responseModel`/`reasoning` available to the view.
- [ ] Docs: how to launch the view, what each node field means, and that Level-2 (child-internal live via IPC) is the next step.

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content
digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `1e27cc49308a8fb94e70a9497b7288d6dd0c01128a4b3dfe601dca0a23c3c657`
- **Reviewer:** genie:reviewer (Opus 4.8, independent design gate)
- **Reviewed at:** 2026-07-20T21:24:52.000Z
<!-- genie-design-review:end -->
