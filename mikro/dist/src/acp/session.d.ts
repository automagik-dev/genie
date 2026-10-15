/**
 * ACP event-translation layer — wish mikro-acp-adapter, Group 2.
 *
 * `translateEvent(ev, ctx)` turns each `AgentEvent` yielded by the
 * instrumented `rlmLoop` (see `src/sdk/events.ts`) into zero or more ACP
 * `SessionUpdate` notifications, LIVE, as the event arrives in `agent.ts`'s
 * drain loop. The drain loop wraps each returned update in a
 * `SessionNotification` and ships it via `conn.sessionUpdate({ sessionId,
 * update })`. Translation is pure and synchronous — it only reads/writes the
 * mutable `TranslationContext` — so the deterministic unit test
 * (`tests/acp-translation.test.ts`) can feed a synthetic event sequence and
 * assert the exact emitted `SessionUpdate` shape without a live run.
 *
 * ── MAPPING TABLE ────────────────────────────────────────────────────────
 *
 *   AgentEvent                     → SessionUpdate(s)
 *   ─────────────────────────────────────────────────────────────────────
 *   Message (role=assistant)       → agent_message_chunk  (streamed answer)
 *   EmitDone (payload.answer)      → agent_message_chunk  (final answer,
 *                                     DEDUPED against already-streamed text)
 *   IterationOutput (root)         → agent_thought_chunk   (loop reasoning)
 *   IterationOutput (child node)   → tool_call_update      (on the Recurse
 *                                     node, completed + per-node metrics)
 *   ToolCallBefore                 → tool_call             (kind from tool
 *                                     name, args as content)
 *   ToolCallAfter                  → tool_call_update      (completed/failed,
 *                                     result content + durationMs)
 *   Recurse                        → tool_call             (one node per
 *                                     spawn; toolCallId from child id)
 *   Error (known node)             → tool_call_update      (failed)
 *   Error (root / unknown node)    → agent_message_chunk   (error context)
 *   AgentStart / SessionOpen /                             (no update —
 *   SessionClose / IterationStart /                         lifecycle only)
 *   Validation / Message(non-asst)
 *   unknown ev.type                → none; ctx.ignoredCount++ (forward-compat)
 *
 * ── ROOT-vs-CHILD IterationOutput ────────────────────────────────────────
 * Both a run's own per-iteration text AND a bridged child-completion arrive
 * as `IterationOutput`. The recursion bridge (`src/sdk/recursion-bridge.ts`)
 * stamps the child-completion with `correlationId === <child id>` — the SAME
 * id carried by the `Recurse` event that spawned it. So the discriminator is
 * node identity: if `ev.correlationId` names a node we already opened from a
 * `Recurse`, it is that child's completion → `tool_call_update`; otherwise it
 * is the loop's own reasoning → `agent_thought_chunk`. `depth`/`metrics`
 * presence do NOT discriminate (root iterations carry metrics too).
 *
 * ── THOUGHT vs MESSAGE (judgement call) ──────────────────────────────────
 * A root `IterationOutput.output` is the model's *intermediate* per-iteration
 * text — it is the loop reasoning toward an answer, not the answer itself
 * (the answer is delivered exactly once via `EmitDone.payload.answer`, or via
 * `Message(role=assistant)` on drivers that stream it). Surfacing every
 * iteration as `agent_message_chunk` would spam the client with half-formed
 * "answers". So intermediate iteration text → `agent_thought_chunk`
 * (reasoning), and only the settled answer → `agent_message_chunk`.
 *
 * ── DEDUPE POLICY (answer text) ──────────────────────────────────────────
 * `ctx.streamedAnswer` accumulates every character already sent as an
 * `agent_message_chunk`. On `EmitDone` we emit only the SUFFIX of
 * `payload.answer` not yet streamed: if nothing was streamed (the common case
 * today — `rlmLoop` does not emit incremental `Message` events, so the answer
 * arrives whole in `EmitDone`), the full answer goes out once; if a driver
 * streamed the answer incrementally and `EmitDone` merely repeats it, the
 * delta is empty and NOTHING is re-sent. All answer chunks share one
 * `messageId` so a client coalesces them into a single message.
 *
 * ── NESTED-OR-FLAT (recursion shape on a flat protocol) ──────────────────
 * ACP has no sub-agent primitive, so each `rlm_query` spawn is represented as
 * a single tool-call node whose ancestry is encoded in the title + content:
 *   • title   = `rlm_query [d{depth}] {prompt preview}`  — the `[d{depth}]`
 *               tag makes tree depth visible in a flat list.
 *   • content = a leading `↳ depth {depth} · parent {parentRunId}` line, so
 *               even a client that only renders tool-call text shows the edge
 *               back to the spawning run.
 * The child-completion `tool_call_update` then carries per-node cost / tokens
 * / latency both as a human-readable content line AND, machine-readably, in
 * `_meta["mikro/node"]` (correlationId, depth, parentRunId, latencyMs, costUsd,
 * tokens) so a richer client can reconstruct the exact tree.
 *
 * ── stdout discipline ────────────────────────────────────────────────────
 * This module produces plain data; it never writes to stdout. All emission
 * happens in `agent.ts` through `conn.sessionUpdate`.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "../sdk/events.js";
/** Machine-readable per-node metrics attached under this `_meta` key. */
export declare const NODE_META_KEY = "mikro/node";
/**
 * Mutable per-prompt translation state. One is created per `session/prompt`
 * turn (`createTranslationContext`) and threaded through every
 * `translateEvent` call for that run.
 */
export interface TranslationContext {
    /** The ACP session id every notification is stamped with. */
    readonly acpSessionId: string;
    /** Child correlation ids opened via `Recurse` — the set that lets an
     *  `IterationOutput` be recognized as a child-completion. */
    readonly knownNodes: Set<string>;
    /** Child correlation id → its recursion depth (for the completion node). */
    readonly nodeDepth: Map<string, number>;
    /** Open repl tool calls awaiting their `ToolCallAfter`, keyed by the
     *  emitting run's id; FIFO because Before/After are strictly sequential. */
    readonly pendingRepl: Map<string, string[]>;
    /** Monotonic counter minting unique repl tool-call ids. */
    replSeq: number;
    /** Cumulative assistant answer text already sent as agent_message_chunk. */
    streamedAnswer: string;
    /** Count of genuinely unknown `ev.type`s (forward-compat telemetry). */
    ignoredCount: number;
}
/** Fresh translation state for one prompt turn. */
export declare function createTranslationContext(acpSessionId: string): TranslationContext;
/** Stable tool-call id for a recursion (child-spawn) node. */
export declare function recurseNodeId(childCorrelationId: string): string;
/**
 * Translate one `AgentEvent` into zero or more `SessionUpdate` notifications.
 * Pure w.r.t. the outside world; only mutates `ctx`.
 */
export declare function translateEvent(ev: AgentEvent, ctx: TranslationContext): SessionUpdate[];
//# sourceMappingURL=session.d.ts.map