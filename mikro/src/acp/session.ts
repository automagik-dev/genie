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

import type {
	ContentBlock,
	SessionUpdate,
	ToolCallContent,
	ToolCallStatus,
	ToolKind,
} from "@agentclientprotocol/sdk";
import type {
	AgentEvent,
	EmitDoneEvent,
	ErrorEvent,
	IterationOutputEvent,
	MessageEvent,
	RecurseEvent,
	ToolCallAfterEvent,
	ToolCallBeforeEvent,
} from "../sdk/events.js";

/** Machine-readable per-node metrics attached under this `_meta` key. */
export const NODE_META_KEY = "mikro/node";

/** Truncation cap for titles/previews so a spawn node stays legible. */
const PREVIEW_CHARS = 80;

/**
 * Payload-hygiene policy — the mikro-live-tui final gate mandates THIS adapter
 * own truncation + redaction at the translator boundary. Every client-facing
 * field a tool-call node ships (its content text blocks AND the machine-readable
 * `rawInput` / `rawOutput`) is passed through `sanitizeText` / `sanitizeRaw`
 * before it leaves `translateEvent`, so it is both width-bounded to
 * MAX_PAYLOAD_CHARS and secret-redacted. Rationale: a single repl cell can emit
 * megabytes of stdout — an unbounded SessionNotification chokes a browser client
 * — or echo the environment/secrets, which must not cross the web boundary.
 * Titles are separately capped at PREVIEW_CHARS via `preview()`.
 *
 * SCOPE: the answer/thought streams (`agent_message_chunk` / `agent_thought_chunk`)
 * are intentionally NOT truncated here — the settled answer is the deliverable
 * and its length is model-bounded, not stdout-bounded, so truncating it would
 * corrupt the product. The oversized-payload vector this gate closes is tool
 * stdout/args/raw, not model-authored answer text.
 */
const MAX_PAYLOAD_CHARS = 16_384;

/** Marker key set on a raw field whose serialized form exceeded the cap. */
const RAW_TRUNCATED_KEY = "mikro/truncated";

/**
 * Basic secret redaction. Deliberately pattern-targeted (not entropy heuristics)
 * so it does not corrupt ordinary output: sensitive `key=value` / `"key":"value"`
 * pairs and a handful of well-known credential shapes are rewritten to
 * `[REDACTED]`. Applied to string content and to the serialized form of raw
 * fields before they cross the web boundary.
 *
 * The keyword pattern's surrounding `[\w.-]` runs are bounded (`{0,64}`) so the
 * engine cannot backtrack superlinearly on a long keyword-substring run that
 * never reaches the `[:=]` delimiter (e.g. `"auth"` repeated 100k times) — that
 * previously blocked the stdio event loop for tens of seconds. Callers also
 * bound the redaction INPUT length (see `boundedRedact`), so redaction cost is
 * O(MAX_PAYLOAD_CHARS) regardless of raw payload size.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/(["']?\b[\w.-]{0,64}(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|auth|credential|bearer)[\w.-]{0,64}\b["']?\s*[:=]\s*)(["'][^"']*["']|[^\s,;}"']+)/gi,
		"$1[REDACTED]",
	],
	[
		/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
		"[REDACTED PRIVATE KEY]",
	],
	[/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, "$1[REDACTED]"],
	[/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"],
	[/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]"],
	[/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]"],
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED]"],
];

/** Rewrite recognizable secrets in `text` to `[REDACTED]`. */
function redactSecrets(text: string): string {
	let out = text;
	for (const [re, sub] of REDACTIONS) out = out.replace(re, sub);
	return out;
}

/**
 * Overlap kept past the width cap when redacting an oversized payload: the
 * redaction pass sees `MAX_PAYLOAD_CHARS + REDACT_OVERLAP` chars so a secret
 * straddling the cut is still matched (and dropped) before the final hard cap
 * removes the tail. Comfortably longer than any credential shape in REDACTIONS.
 */
const REDACT_OVERLAP = 256;

/**
 * Truncate-THEN-redact with a self-describing marker.
 *
 * The redaction INPUT is bounded to `MAX_PAYLOAD_CHARS + REDACT_OVERLAP` BEFORE
 * `redactSecrets` runs, so redaction cost is O(MAX_PAYLOAD_CHARS) even on a
 * multi-megabyte payload — the earlier full-payload redaction blocked the
 * synchronous stdio drain loop for tens of seconds on a hostile input. A secret
 * straddling the cut cannot leak: the overlap slice is redacted first, then the
 * result is hard-capped to `MAX_PAYLOAD_CHARS` (dropping the redacted tail).
 */
function boundedRedact(text: string): string {
	if (text.length <= MAX_PAYLOAD_CHARS) return redactSecrets(text);
	const head = redactSecrets(text.slice(0, MAX_PAYLOAD_CHARS + REDACT_OVERLAP));
	const omitted = text.length - MAX_PAYLOAD_CHARS;
	return `${head.slice(0, MAX_PAYLOAD_CHARS)}\n…[mikro: truncated ${omitted} of ${text.length} chars]`;
}

/** Bound + redact a client-facing string. */
function sanitizeText(text: string): string {
	return boundedRedact(text);
}

/**
 * Bound + redact a machine-readable raw field before it crosses the web
 * boundary. Serializes, redacts string leaves, and re-parses so the client
 * still receives structured data; if the serialized form is oversized it is
 * replaced with a truncation marker carrying a bounded preview.
 */
function sanitizeRaw(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	const json = safeJson(value);
	// Small enough to keep structured: redact the whole (bounded) JSON, re-parse.
	if (json.length <= MAX_PAYLOAD_CHARS) {
		const redacted = redactSecrets(json);
		try {
			return JSON.parse(redacted) as unknown;
		} catch {
			return redacted;
		}
	}
	// Oversized: bound the redaction INPUT before redacting (see boundedRedact),
	// so a hostile megabyte-scale raw field cannot stall the drain loop.
	return {
		[RAW_TRUNCATED_KEY]: true,
		originalChars: json.length,
		preview: boundedRedact(json),
	};
}

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
export function createTranslationContext(
	acpSessionId: string,
): TranslationContext {
	return {
		acpSessionId,
		knownNodes: new Set<string>(),
		nodeDepth: new Map<string, number>(),
		pendingRepl: new Map<string, string[]>(),
		replSeq: 0,
		streamedAnswer: "",
		ignoredCount: 0,
	};
}

/** Truncate + single-line + secret-redact a string for a title/preview.
 *  Titles cross the web boundary too, so they get the same redaction as
 *  content — the PREVIEW_CHARS cap bounds width, redactSecrets bounds leakage. */
function preview(text: string, cap = PREVIEW_CHARS): string {
	const flat = redactSecrets(text.replace(/\s+/g, " ").trim());
	return flat.length > cap ? `${flat.slice(0, cap)}…` : flat;
}

/** Wrap a plain string as a single tool-call text content block, width-bounded
 *  and secret-redacted per the payload-hygiene policy. */
function textContent(text: string): ToolCallContent {
	return { type: "content", content: { type: "text", text: sanitizeText(text) } };
}

/** Map an mikro tool name to the closest ACP `ToolKind`. */
function kindForTool(tool: string): ToolKind {
	const t = tool.toLowerCase();
	if (t === "repl" || t.includes("exec") || t.includes("python") || t.includes("bash"))
		return "execute";
	if (t.includes("read") || t.includes("cat")) return "read";
	if (t.includes("search") || t.includes("grep")) return "search";
	if (t.includes("fetch") || t.includes("http")) return "fetch";
	if (t.includes("query") || t.includes("recurse") || t.includes("rlm"))
		return "think";
	return "other";
}

/** Stable tool-call id for a recursion (child-spawn) node. */
export function recurseNodeId(childCorrelationId: string): string {
	return `rlm:${childCorrelationId}`;
}

/** The run id an event is "about" (for keying pending repl calls). */
function runKey(ev: { correlationId?: string; sessionId?: string }): string {
	return ev.correlationId ?? ev.sessionId ?? "root";
}

/**
 * Translate one `AgentEvent` into zero or more `SessionUpdate` notifications.
 * Pure w.r.t. the outside world; only mutates `ctx`.
 */
export function translateEvent(
	ev: AgentEvent,
	ctx: TranslationContext,
): SessionUpdate[] {
	switch (ev.type) {
		case "Message":
			return translateMessage(ev, ctx);
		case "EmitDone":
			return translateEmitDone(ev, ctx);
		case "IterationOutput":
			return translateIterationOutput(ev, ctx);
		case "ToolCallBefore":
			return translateToolCallBefore(ev, ctx);
		case "ToolCallAfter":
			return translateToolCallAfter(ev, ctx);
		case "Recurse":
			return translateRecurse(ev, ctx);
		case "Error":
			return translateError(ev, ctx);
		// Lifecycle / structural events carry no client-facing update.
		case "AgentStart":
		case "SessionOpen":
		case "SessionClose":
		case "IterationStart":
		case "Validation":
		case "ToolCallObservation":
			return [];
		default:
			// Forward-compat: never crash on an unknown variant; count it.
			ctx.ignoredCount++;
			return [];
	}
}

// ── individual translators ─────────────────────────────────────────────────

function answerMessageId(ctx: TranslationContext): string {
	return `answer:${ctx.acpSessionId}`;
}

/** agent_message_chunk carrying `text`, sharing the single answer messageId. */
function answerChunk(ctx: TranslationContext, text: string): SessionUpdate {
	const content: ContentBlock = { type: "text", text };
	return {
		sessionUpdate: "agent_message_chunk",
		content,
		messageId: answerMessageId(ctx),
	};
}

function translateMessage(
	ev: MessageEvent,
	ctx: TranslationContext,
): SessionUpdate[] {
	// Only the assistant's answer text streams to the client. system/user
	// roles are internal scaffolding.
	if (ev.role !== "assistant") return [];
	if (ev.content.length === 0) return [];
	ctx.streamedAnswer += ev.content;
	return [answerChunk(ctx, ev.content)];
}

function translateEmitDone(
	ev: EmitDoneEvent,
	ctx: TranslationContext,
): SessionUpdate[] {
	const payload = ev.payload as { answer?: unknown } | null | undefined;
	const answer =
		payload && typeof payload.answer === "string" ? payload.answer : "";
	if (answer.length === 0) return [];

	// Dedupe: emit only the suffix not already streamed.
	if (ctx.streamedAnswer.length === 0) {
		ctx.streamedAnswer = answer;
		return [answerChunk(ctx, answer)];
	}
	if (answer === ctx.streamedAnswer) return []; // exact repeat — nothing new
	if (answer.startsWith(ctx.streamedAnswer)) {
		const delta = answer.slice(ctx.streamedAnswer.length);
		ctx.streamedAnswer = answer;
		return delta.length > 0 ? [answerChunk(ctx, delta)] : [];
	}
	// Divergent final answer (a driver rewrote rather than appended): send it
	// as the authoritative answer; the shared messageId lets the client treat
	// the message as updated rather than duplicated.
	ctx.streamedAnswer = answer;
	return [answerChunk(ctx, answer)];
}

function translateIterationOutput(
	ev: IterationOutputEvent,
	ctx: TranslationContext,
): SessionUpdate[] {
	// Child-completion? (node opened by an earlier Recurse.)
	if (ev.correlationId && ctx.knownNodes.has(ev.correlationId)) {
		const nodeId = recurseNodeId(ev.correlationId);
		const depth = ctx.nodeDepth.get(ev.correlationId) ?? ev.metrics?.depth ?? 1;
		const content: ToolCallContent[] = [];
		if (ev.output.length > 0) content.push(textContent(ev.output));
		const metricsLine = formatMetricsLine(ev.metrics);
		if (metricsLine) content.push(textContent(metricsLine));
		const update: SessionUpdate = {
			sessionUpdate: "tool_call_update",
			toolCallId: nodeId,
			status: "completed" satisfies ToolCallStatus,
			content,
			rawOutput: { answer: sanitizeRaw(ev.output), metrics: ev.metrics },
			_meta: {
				[NODE_META_KEY]: {
					correlationId: ev.correlationId,
					parentRunId: ev.parentRunId,
					depth,
					latencyMs: ev.metrics?.latencyMs,
					costUsd: ev.metrics?.costUsd,
					tokens: ev.metrics?.tokens,
				},
			},
		};
		return [update];
	}

	// Root loop reasoning → thought.
	if (ev.output.length === 0) return [];
	const content: ContentBlock = { type: "text", text: ev.output };
	return [
		{
			sessionUpdate: "agent_thought_chunk",
			content,
			messageId: `thought:${ev.sessionId}:${ev.iteration}`,
		},
	];
}

function translateToolCallBefore(
	ev: ToolCallBeforeEvent,
	ctx: TranslationContext,
): SessionUpdate[] {
	const key = runKey(ev);
	const toolCallId = `tool:${key}:${ev.iteration}:${ctx.replSeq++}`;
	const queue = ctx.pendingRepl.get(key) ?? [];
	queue.push(toolCallId);
	ctx.pendingRepl.set(key, queue);

	const argsText =
		typeof ev.args === "string" ? ev.args : safeJson(ev.args);
	const content: ToolCallContent[] =
		argsText.length > 0 ? [textContent(argsText)] : [];
	return [
		{
			sessionUpdate: "tool_call",
			toolCallId,
			title: `${ev.tool}: ${preview(argsText)}`,
			kind: kindForTool(ev.tool),
			status: "in_progress" satisfies ToolCallStatus,
			content,
			rawInput: sanitizeRaw(ev.args),
		},
	];
}

function translateToolCallAfter(
	ev: ToolCallAfterEvent,
	ctx: TranslationContext,
): SessionUpdate[] {
	const key = runKey(ev);
	const queue = ctx.pendingRepl.get(key);
	const toolCallId = queue?.shift();
	if (!toolCallId) {
		// No matching open call (e.g. events replayed out of order). Skip
		// rather than fabricate a node — do not crash the translator.
		return [];
	}
	const resultText =
		typeof ev.result === "string" ? ev.result : safeJson(ev.result);
	const content: ToolCallContent[] =
		resultText.length > 0 ? [textContent(resultText)] : [];
	return [
		{
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: (ev.ok ? "completed" : "failed") satisfies ToolCallStatus,
			content,
			rawOutput: sanitizeRaw(ev.result),
			_meta: { "mikro/durationMs": ev.durationMs },
		},
	];
}

function translateRecurse(
	ev: RecurseEvent,
	ctx: TranslationContext,
): SessionUpdate[] {
	const childId = ev.correlationId;
	if (!childId) {
		// A Recurse with no correlation id cannot be tied to a completion; still
		// surface it as an anonymous node so the spawn is visible.
		return [
			{
				sessionUpdate: "tool_call",
				toolCallId: `rlm:anon:${ctx.replSeq++}`,
				title: `rlm_query [d${ev.depth}] ${preview(ev.query)}`,
				kind: "think",
				status: "in_progress" satisfies ToolCallStatus,
				content: [textContent(ev.query)],
				rawInput: sanitizeRaw({ query: ev.query, depth: ev.depth }),
			},
		];
	}
	ctx.knownNodes.add(childId);
	ctx.nodeDepth.set(childId, ev.depth);
	const nodeId = recurseNodeId(childId);
	// Flat-client ancestry encoding: depth tag in the title, parent edge in the
	// leading content line.
	const ancestry = `↳ depth ${ev.depth} · parent ${ev.parentRunId ?? "root"}`;
	return [
		{
			sessionUpdate: "tool_call",
			toolCallId: nodeId,
			title: `rlm_query [d${ev.depth}] ${preview(ev.query)}`,
			kind: "think",
			status: "in_progress" satisfies ToolCallStatus,
			content: [textContent(ancestry), textContent(ev.query)],
			rawInput: sanitizeRaw({
				query: ev.query,
				depth: ev.depth,
				parentRunId: ev.parentRunId,
				correlationId: childId,
			}),
		},
	];
}

function translateError(
	ev: ErrorEvent,
	ctx: TranslationContext,
): SessionUpdate[] {
	// Tied to a known recursion node → mark that node failed.
	if (ev.correlationId && ctx.knownNodes.has(ev.correlationId)) {
		const nodeId = recurseNodeId(ev.correlationId);
		return [
			{
				sessionUpdate: "tool_call_update",
				toolCallId: nodeId,
				status: "failed" satisfies ToolCallStatus,
				content: [
					textContent(`error [${ev.phase}] ${ev.error.name}: ${ev.error.message}`),
				],
				_meta: {
					[NODE_META_KEY]: {
						correlationId: ev.correlationId,
						parentRunId: ev.parentRunId,
						error: { name: ev.error.name, message: ev.error.message },
					},
				},
			},
		];
	}
	// Otherwise surface the error context to the client as a message chunk.
	// Kept OUT of ctx.streamedAnswer (its own messageId) so it never pollutes
	// answer dedupe.
	const content: ContentBlock = {
		type: "text",
		text: `mikro error [${ev.phase}] ${ev.error.name}: ${ev.error.message}`,
	};
	return [
		{
			sessionUpdate: "agent_message_chunk",
			content,
			messageId: `error:${ev.sessionId}:${ev.phase}`,
		},
	];
}

// ── helpers ─────────────────────────────────────────────────────────────────

function formatMetricsLine(
	metrics: IterationOutputEvent["metrics"],
): string | null {
	if (!metrics) return null;
	const parts: string[] = [];
	if (typeof metrics.costUsd === "number")
		parts.push(`$${metrics.costUsd.toFixed(6)}`);
	if (metrics.tokens)
		parts.push(
			`${metrics.tokens.input}→${metrics.tokens.output} tok`,
		);
	parts.push(`${metrics.latencyMs}ms`);
	return parts.length > 0 ? `metrics: ${parts.join(" · ")}` : null;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
