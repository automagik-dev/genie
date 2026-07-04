/**
 * Omni runner — the one resident process (`genie omni serve`).
 *
 * Owns the NATS transport and the two-way bridge between the phone and the
 * global approval queue:
 *   - subscribes `omni.message.{instance}.>` — both text replies AND reactions
 *     arrive here. A WhatsApp reaction reaches genie as a `message.received`
 *     whose content is `[Reaction: <emoji> on message <targetId>]` (the target
 *     id is also the top-level `messageId`); the legacy `omni.event.>` subject
 *     has zero publishers in this Omni build, so it is retired (SPIKE finding a);
 *   - on each new pending approval row, SENDS an approval-request over the Omni
 *     HTTP API (an id-returning send) and tags the row with the REAL Omni
 *     message id (the WhatsApp stanza id) the send returns — so an inbound
 *     reaction can be correlated to the exact approval it targets, rather than
 *     the old self-referential `genId()` ref that matched nothing (SPIKE b);
 *   - matches inbound replies/reactions against the approve/deny vocabulary and
 *     resolves the correlated approval (reaction → the stored stanza id; bare
 *     text → oldest-pending fallback);
 *   - records every inbound message to the inbox (`recordInbound`). One-shot
 *     agent spawning on inbound is Group 4 — this group only stores.
 *
 * The hook handler never touches NATS: it enqueues a row and polls the DB. This
 * runner is the only NATS client, so `genie --help`/`task`/`board` never
 * initialize the transport (proven by the {@link natsConnectionCount} marker).
 *
 * NATS is injected behind {@link NatsLike} so tests drive a fake with zero
 * network. The real transport is a dynamic `import('nats')` — never a top-level
 * import — so merely loading this module costs nothing.
 */

import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OmniRoute, OmniRuntimeConfig } from './omni-config.js';
import { matchReaction, matchTextToken } from './omni-matching.js';
import { signOmniRequest } from './omni-signature.js';
import {
  ApprovalConflictError,
  type ApprovalDecision,
  attachOmniMessageId,
  expireStale,
  listApprovalsNeedingStatusAck,
  listPendingApprovals,
  markHandled,
  recordInbound,
  recordStatusGlyph,
  resolveApproval,
} from './v5/omni-queue.js';

// ============================================================================
// Injectable NATS surface
// ============================================================================

export interface NatsInboundMsg {
  subject: string;
  data: Uint8Array;
}

export interface NatsSubscription extends AsyncIterable<NatsInboundMsg> {
  unsubscribe(): void;
}

export interface NatsLike {
  subscribe(subject: string): NatsSubscription;
  publish(subject: string, payload: string): void;
  close(): Promise<void>;
}

export type NatsFactory = (opts: { servers: string }) => Promise<NatsLike>;

/** Process-lifetime count of real NATS connections opened. Stays 0 unless
 *  `omni serve` actually runs — the "transport not initialized" marker. */
let natsConnections = 0;
export function natsConnectionCount(): number {
  return natsConnections;
}

// ============================================================================
// Injectable one-shot `claude -p` spawn surface
// ============================================================================

export interface SpawnClaudeOpts {
  /** The inbound message text, passed as the `claude -p "<message>"` prompt. */
  message: string;
  /** Working directory of the child — the mapped route's absolute repo dir. */
  cwd: string;
  /** Aborted when the run exceeds its budget; the child MUST be killed on abort. */
  signal: AbortSignal;
  /**
   * Absolute path to a persona / AGENTS.md file appended to Claude Code's system
   * prompt (`--append-system-prompt-file`). Absent → no persona is appended.
   */
  personaFile?: string;
  /**
   * Stable `--session-id` (UUID) so a conversation RESUMES across messages. The
   * runner derives it deterministically from (instance, chat); if a caller omits
   * it the executor generates a fresh one defensively.
   */
  sessionId?: string;
}

export interface SpawnClaudeResult {
  /**
   * The FINAL assistant reply text — already parsed out of Claude's stream-json
   * stdout (truncated to the reply cap before publishing). See
   * {@link extractStreamJsonReply}.
   */
  stdout: string;
  /** Process exit code; non-zero is surfaced as a bounded error notice. */
  exitCode: number;
}

/** Bounded one-shot `claude -p` executor. Injectable so tests never fork claude. */
export type SpawnClaude = (opts: SpawnClaudeOpts) => Promise<SpawnClaudeResult>;

/**
 * Build the `claude` argv for one bounded one-shot run (Model A). Streams the
 * turn as NDJSON (`--output-format stream-json`, which requires `-p`/`--print`
 * AND `--verbose`) under a stable `--session-id` so the conversation resumes,
 * and appends the persona to the system prompt when one is resolved. Pure +
 * exported so the arg contract is unit-tested without forking claude.
 */
export function buildClaudeArgs(opts: { message: string; sessionId: string; personaFile?: string }): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    opts.sessionId,
    ...(opts.personaFile ? ['--append-system-prompt-file', opts.personaFile] : []),
    opts.message,
  ];
}

/**
 * Extract the final assistant reply from Claude's `stream-json` stdout (NDJSON,
 * one JSON event per line). Preference order:
 *   1. the terminal `{"type":"result","subtype":"success","result":"<text>"}`
 *      event — the canonical final answer;
 *   2. otherwise the concatenation of `assistant` message text blocks (a partial
 *      or non-success turn still yields the text it produced);
 *   3. on total parse failure (stdout is not stream-json at all), the raw stdout
 *      verbatim — never lose the reply just because the wire format shifted.
 */
export function extractStreamJsonReply(raw: string): string {
  let assistantText = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue; // skip a non-JSON line (log noise / partial frame)
    }
    if (!evt || typeof evt !== 'object') continue;
    const o = evt as { type?: string; subtype?: string; result?: unknown; message?: { content?: unknown } };
    if (o.type === 'result' && o.subtype === 'success' && typeof o.result === 'string' && o.result.length > 0) {
      return o.result;
    }
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const block of o.message.content as Array<{ type?: string; text?: string }>) {
        if (block && block.type === 'text' && typeof block.text === 'string') assistantText += block.text;
      }
    }
  }
  return assistantText || raw;
}

/**
 * Derive a STABLE session-id UUID from (instance, chat) so every message on a
 * conversation resumes the same Claude session. Deterministic (sha256 of the
 * pair, shaped into a v5-style UUID) — no state to persist, and two hosts
 * serving the same route converge on the same id.
 */
export function deterministicSessionId(instance: string, chat: string): string {
  const h = createHash('sha256').update(`omni-session:${instance}:${chat}`).digest('hex').slice(0, 32).split('');
  h[12] = '5'; // version 5 (name-based)
  h[16] = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16); // variant 10xx → 8/9/a/b
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Default executor — a real Model A `claude -p` run bounded by the caller's
 * abort signal, streaming stream-json and parsing out the final reply. Never
 * imported at module top-level cost; only invoked once an inbound message
 * actually matches a configured route. A missing `sessionId` is generated
 * defensively (callers always pass a stable one).
 */
export const defaultSpawnClaude: SpawnClaude = async ({ message, cwd, signal, personaFile, sessionId }) => {
  const args = buildClaudeArgs({ message, sessionId: sessionId ?? randomUUID(), personaFile });
  const proc = Bun.spawn(['claude', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // Bun forwards the AbortSignal: aborting SIGKILLs the child, freeing the route.
    signal,
  });
  const raw = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: extractStreamJsonReply(raw), exitCode };
};

// ============================================================================
// Injectable id-returning Omni send (approval announce)
// ============================================================================

/**
 * Result of an id-returning Omni send. `messageId` is the correlatable id — the
 * WhatsApp stanza id / externalId (SPIKE finding (b)) — that an inbound reaction
 * later references. Absent on a failed send (the row stays un-tagged and is
 * retried on the next tick).
 */
export interface OmniSendResult {
  messageId?: string;
  success?: boolean;
  error?: string;
}

export interface OmniSendOpts {
  instance: string;
  chat: string;
  text: string;
}

/**
 * Send an approval-request message and RETURN the id it was assigned. Injectable
 * so tests drive a fake (zero network); the default posts to the Omni HTTP send
 * API. This replaces the fire-and-forget NATS `omni.reply.*` publish whose id
 * Omni's `onReply` discarded — capturing the real Omni message id is what makes
 * a reaction correlatable to the exact approval it targets.
 */
export type OmniSend = (opts: OmniSendOpts) => Promise<OmniSendResult>;

/**
 * Default id-returning send — POSTs the approval message to Omni's HTTP send
 * route, signed exactly like {@link registerAgentInOmni} (bearer + optional
 * ed25519). Returns the message id from the response so `announce()` can store
 * the correlatable stanza id. Degrades to an error result (silent retry, never a
 * throw) when the Omni API URL is unconfigured.
 *
 * NOTE: the exact send route + response field that surface the WhatsApp *stanza
 * id* (vs the persisted Omni UUID) are documented in SPIKE (b) but not yet
 * exercised against the live hub — the injectable seam above is what the test
 * suite proves; G3's `--live` round-trip confirms this default's wire format.
 */
export function makeDefaultOmniSend(config: OmniRuntimeConfig): OmniSend {
  return async ({ instance, chat, text }) => {
    const apiUrl = config.apiUrl;
    if (!apiUrl) return { success: false, error: 'omni apiUrl not configured' };
    const path = '/api/v2/messages';
    const bodyJson = JSON.stringify({ instanceId: instance, chatId: chat, text });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const sig = signOmniRequest('POST', path, bodyJson);
    if (sig) Object.assign(headers, sig);
    const res = await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: bodyJson,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    // SendResult ({ success, messageId, ... }) may be top-level or `{ data }`-wrapped.
    const json = (await res.json()) as { messageId?: string; data?: { messageId?: string } };
    const messageId = json.messageId ?? json.data?.messageId;
    return { success: Boolean(messageId), messageId };
  };
}

// ============================================================================
// Injectable outbound set-reaction (⏳→✅/❌ status ack)
// ============================================================================

export interface OmniSetReactionResult {
  success?: boolean;
  error?: string;
}

export interface OmniSetReactionOpts {
  instance: string;
  chat: string;
  /** The WhatsApp stanza id of the message to react to (genie's own approval). */
  messageId: string;
  /** The status emoji to set (⏳/✅/❌). A new emoji SWAPS the prior one in place. */
  emoji: string;
}

/**
 * Set (or swap) genie's OWN status reaction on a message it sent. Injectable so
 * tests drive a fake (zero network); the default POSTs the Omni `--reaction`
 * HTTP path. WhatsApp allows one reaction per sender per message, so setting a
 * new emoji on the same stanza id replaces the prior one — that is how the
 * ⏳→✅/❌ ack swaps in place.
 *
 * This is the seam the SPIKE-documented fallback swaps behind: if a later
 * `--live` QA shows the in-place reaction swap does not RENDER, replace this
 * default impl with a message-edit (prepend a status glyph) or a status-reply
 * variant — the runner calls this one seam, so the fallback is an impl swap, not
 * a rewrite.
 */
export type OmniSetReaction = (opts: OmniSetReactionOpts) => Promise<OmniSetReactionResult>;

/**
 * Default set-reaction — POSTs to Omni's HTTP reaction route, signed exactly
 * like {@link makeDefaultOmniSend}. Uses the `--reaction` path (correct
 * `fromMe` for genie's own message), NOT the bare `react` verb. Degrades to an
 * error result (never a throw) when the Omni API URL is unconfigured.
 *
 * NOTE: like {@link makeDefaultOmniSend}, the exact reaction-route body shape is
 * documented in SPIKE (c) but not yet exercised against the live hub — the
 * injectable seam above is what the test suite proves; G3's `--live` round-trip
 * confirms this default's wire format (and whether the in-place swap renders).
 */
export function makeDefaultOmniSetReaction(config: OmniRuntimeConfig): OmniSetReaction {
  return async ({ instance, chat, messageId, emoji }) => {
    const apiUrl = config.apiUrl;
    if (!apiUrl) return { success: false, error: 'omni apiUrl not configured' };
    const path = '/api/v2/messages';
    const bodyJson = JSON.stringify({ instanceId: instance, chatId: chat, reaction: emoji, messageId });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const sig = signOmniRequest('POST', path, bodyJson);
    if (sig) Object.assign(headers, sig);
    const res = await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: bodyJson,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    return { success: true };
  };
}

/** Default factory — dynamically imports `nats`. Only invoked by `omni serve`. */
export const defaultNatsFactory: NatsFactory = async ({ servers }) => {
  const nats = await import('nats');
  const nc = await nats.connect({ servers });
  natsConnections++;
  const enc = new TextEncoder();
  return {
    subscribe(subject: string): NatsSubscription {
      const sub = nc.subscribe(subject);
      return {
        unsubscribe: () => sub.unsubscribe(),
        async *[Symbol.asyncIterator]() {
          for await (const m of sub) yield { subject: m.subject, data: m.data };
        },
      };
    },
    publish: (subject, payload) => nc.publish(subject, enc.encode(payload)),
    close: () => nc.close(),
  };
};

// ============================================================================
// Inbound payload shapes (loose — omni fields vary by channel)
// ============================================================================

interface InboundMessagePayload {
  content?: string;
  sender?: string;
  instanceId?: string;
  chatId?: string;
  /**
   * For a reaction `message.received`, the reacted-to message's stanza id (also
   * embedded in `content` as `[Reaction: <emoji> on message <messageId>]`). Used
   * to correlate the reaction to the exact approval it targets (SPIKE a).
   */
  messageId?: string;
}

// ============================================================================
// Runner
// ============================================================================

export interface OmniRunnerDeps {
  db: Database;
  config: OmniRuntimeConfig;
  /** Outbound NATS publish. */
  publish: (subject: string, payload: string) => void;
  /** Structured log sink (stdout in serve; captured in tests). */
  log?: (line: string) => void;
  /** Injectable clock. */
  now?: () => number;
  /** Injectable correlation-id generator (tagged onto routed one-shot replies). */
  genCorrelationId?: () => string;
  /**
   * Injectable one-shot executor. Defaults to a real `claude -p`; tests pass a
   * fake so no real claude is ever forked.
   */
  spawnClaude?: SpawnClaude;
  /**
   * Injectable id-returning approval send. Defaults to the Omni HTTP send
   * ({@link makeDefaultOmniSend}); tests pass a fake that returns a known stanza
   * id so `announce()` is exercised with zero network.
   */
  sendApproval?: OmniSend;
  /**
   * Injectable outbound set-reaction for the ⏳→✅/❌ status ack. Defaults to the
   * Omni HTTP reaction path ({@link makeDefaultOmniSetReaction}); tests pass a
   * fake that records the (target id, emoji) so the status lifecycle is asserted
   * with zero network. The seam the SPIKE fallback (message-edit / status-reply)
   * swaps behind if the in-place reaction swap does not render live.
   */
  setReaction?: OmniSetReaction;
}

export interface OmniRunner {
  /** Send any un-announced pending approvals + expire stale rows. */
  tick(): void;
  /**
   * Handle one inbound `omni.message.*` frame — a text reply OR a reaction (both
   * arrive on this subject in this Omni build).
   */
  handleMessage(subject: string, data: string): void;
  /**
   * Resolve once every in-flight one-shot run has settled. Test seam — the serve
   * loop never awaits it (runs are fire-and-forget), but tests use it to observe
   * the mapped round-trip deterministically.
   */
  whenIdle(): Promise<void>;
}

function formatApprovalMessage(tool: string, inputSummary: string): string {
  const preview = inputSummary.length > 200 ? `${inputSummary.slice(0, 197)}...` : inputSummary;
  return [
    '\u{1F514} *Approval Required*',
    '',
    `Tool: \`${tool}\``,
    `Preview: ${preview}`,
    '',
    'Reply *y* to approve or *n* to deny',
    'Or react \u{1F44D} / \u{1F44E}',
  ].join('\n');
}

/**
 * Parse a reaction `message.received` content — `[Reaction: <emoji> on message
 * <id>]`, optionally prefixed by `[<displayName>]: ` — into its emoji + target
 * stanza id. Returns null for ordinary text so the caller falls through to the
 * text-token path. This is the sole reaction shape genie treats as a decision;
 * the dual-emit bare-emoji echo (SPIKE a) is deliberately NOT matched here, so
 * it can never double-resolve.
 */
const REACTION_RE = /\[Reaction:\s*(.+?)\s+on message\s+(.+?)\]/;
function parseReaction(content: string): { emoji: string; targetId: string } | null {
  const m = REACTION_RE.exec(content);
  return m ? { emoji: m[1].trim(), targetId: m[2].trim() } : null;
}

/** chat id from payload, else parsed from `omni.message.{instance}.{chat...}`. */
function chatIdFromSubject(subject: string): string | undefined {
  const parts = subject.split('.');
  return parts.length >= 4 ? parts.slice(3).join('.') : undefined;
}

/**
 * Outbound reply payload for a routed one-shot, addressed at the exact
 * (instance, chat) the inbound arrived on (NOT the approval chat). Mirrors the
 * origin/v4 omni-bridge reply shape so the omni side deserializes it uniformly.
 */
function buildRoutedReplyPayload(
  instance: string,
  chat: string,
  content: string,
  correlationId: string,
  nowMs: number,
): string {
  return JSON.stringify({
    content,
    agent: 'genie',
    chat_id: chat,
    instance_id: instance,
    request_id: correlationId,
    timestamp: new Date(nowMs).toISOString(),
  });
}

/** Cap a reply to `max` chars, replacing the tail with a single ellipsis. */
function truncateReply(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Dropped-because-busy notice (Decision 10 — one in-flight run per route). */
const BUSY_NOTICE = '\u{1F6D1} busy — one at a time. Your message was stored; try again shortly.';
/** Fired when a one-shot exceeds its budget and is killed. */
const timeoutNotice = (ms: number): string => `\u{23F1}\u{FE0F} timed out after ${ms}ms — the run was cancelled.`;
/** Fired on a non-zero exit or a child crash; the underlying error is bounded. */
const errorNotice = (detail: string): string => `\u{26A0}\u{FE0F} agent run failed: ${truncateReply(detail, 200)}`;

/** Compact message for an unknown thrown value. */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Status-ack glyphs for genie's OWN swapping reaction on the approval message.
 * ⏳ on announce (awaiting you), ✅ once approved, ❌ once denied or expired. All
 * three are outside the approve/deny vocab and are set with `fromMe=true`, so
 * they never dual-emit and never self-resolve an approval (SPIKE c).
 */
const STATUS_PENDING = '\u{23F3}'; // ⏳
const STATUS_APPROVED = '\u{2705}'; // ✅
const STATUS_DENIED = '\u{274C}'; // ❌ (denied and expired both land here)
/** The two glyphs that mean "done" — a row whose recorded glyph is one of these
 *  needs no further status ack (the reconciliation pass skips it). */
const TERMINAL_STATUS_GLYPHS = [STATUS_APPROVED, STATUS_DENIED];

/**
 * How far back the reconciliation pass looks for a row still needing a terminal
 * ack (24h). Generous on purpose: a row resolved/expired while `omni serve` was
 * briefly down must still get its ✅/❌ when serve returns, so this must exceed
 * any realistic downtime — it is ~785× the default 110s pollBudget. Older closed
 * rows are presumed already acked (or too stale to matter) and are left alone, so
 * per-tick reconciliation work is bounded and history is never swept.
 */
const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Distinguishes a budget-driven abort from a genuine child crash in the catch. */
class OneShotTimeoutError extends Error {
  constructor() {
    super('one-shot timed out');
    this.name = 'OneShotTimeoutError';
  }
}

export function createOmniRunner(deps: OmniRunnerDeps): OmniRunner {
  const { db, config, publish } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const genId =
    deps.genCorrelationId ?? (() => `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  const spawnClaude = deps.spawnClaude ?? defaultSpawnClaude;
  const sendApproval = deps.sendApproval ?? makeDefaultOmniSend(config);
  const setReaction = deps.setReaction ?? makeDefaultOmniSetReaction(config);
  const vocab = {
    approveTokens: config.approveTokens,
    denyTokens: config.denyTokens,
    approveReactions: config.approveReactions,
    denyReactions: config.denyReactions,
  };

  // Inbound one-shot routing state (Decision 10 — one in-flight run per route).
  const routes = config.routes ?? [];
  const timeoutMs = config.inboundTimeoutMs ?? 120_000;
  const maxReplyChars = config.inboundMaxReplyChars ?? 4_000;
  /** Routes with a run currently in flight — a second message on one is dropped. */
  const inFlight = new Set<string>();
  /** Live one-shot promises, so `whenIdle` (tests) can await completion. */
  const pending = new Set<Promise<void>>();
  /** Approval ids with an announce send in flight — guards against a second tick
   *  re-sending a row whose `omni_message_id` is not yet stored. */
  const announcing = new Set<string>();
  /** Live announce-send promises, drained by `whenIdle` alongside `pending`. */
  const inFlightSends = new Set<Promise<void>>();
  /** Live status-reaction promises (⏳→✅/❌), also drained by `whenIdle`. */
  const inFlightReactions = new Set<Promise<void>>();
  /** Omni message ids with a status-ack HTTP call currently in flight — guards
   *  the reconciliation pass (every tick) from double-firing an ack whose glyph
   *  the prior emit has not yet recorded. Keyed by the stanza id. */
  const ackInFlight = new Set<string>();
  const routeKey = (instance: string, chat: string): string => `${instance} ${chat}`;
  const findRoute = (instance: string, chat: string): OmniRoute | undefined =>
    routes.find((r) => r.instance === instance && r.chat === chat);

  /**
   * Drive one bounded `claude -p` for a mapped inbound. Owns the timeout (races
   * the spawn against an abort), the output cap, and the reply publish. Every
   * exit path publishes exactly one reply, marks the inbound handled, and clears
   * the in-flight flag — a child crash NEVER escapes this function.
   */
  async function runOneShot(
    route: OmniRoute,
    inboundId: string,
    message: string,
    replySubject: string,
    messageId?: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new OneShotTimeoutError()), { once: true });
    });
    // ⏳ on the inbound message right before the spawn (route-scoped, no-op if the
    // inbound carried no stanza id) — the first half of the run's ⏳→✅/❌ ack.
    emitRouteReaction(route, messageId, STATUS_PENDING);
    try {
      // Wrap so a SYNCHRONOUS throw from the executor becomes a rejection the
      // race can observe — and so `aborted` always gets a handler attached
      // (else a late finally-abort would surface as an unhandled rejection).
      const spawned = Promise.resolve().then(() =>
        spawnClaude({
          message,
          cwd: route.repo,
          signal: controller.signal,
          personaFile: resolvePersonaFile(route),
          sessionId: deterministicSessionId(route.instance, route.chat),
        }),
      );
      const result = await Promise.race([spawned, aborted]);
      const ok = result.exitCode === 0;
      const content = ok ? truncateReply(result.stdout, maxReplyChars) : errorNotice(`exit code ${result.exitCode}`);
      publish(replySubject, buildRoutedReplyPayload(route.instance, route.chat, content, genId(), now()));
      // ✅ once a genuine reply is published; ❌ when the run exited non-zero.
      emitRouteReaction(route, messageId, ok ? STATUS_APPROVED : STATUS_DENIED);
    } catch (err) {
      const content = err instanceof OneShotTimeoutError ? timeoutNotice(timeoutMs) : errorNotice(errText(err));
      publish(replySubject, buildRoutedReplyPayload(route.instance, route.chat, content, genId(), now()));
      emitRouteReaction(route, messageId, STATUS_DENIED); // ❌ on timeout / crash
    } finally {
      clearTimeout(timer);
      controller.abort(); // ensure a still-running child is killed on every path
      try {
        markHandled(db, inboundId, now());
      } catch (err) {
        log(`[omni] markHandled failed for ${inboundId}: ${errText(err)}`);
      }
      inFlight.delete(routeKey(route.instance, route.chat));
    }
  }

  /**
   * Spawn (or drop-with-notice) a one-shot for a mapped inbound. Adds the route
   * to `inFlight` SYNCHRONOUSLY before any await so a second message racing the
   * first sees it busy. Fire-and-forget: the serve loop never awaits the run.
   */
  function startRoutedRun(route: OmniRoute, inboundId: string, message: string, messageId?: string): void {
    const replySubject = `omni.reply.${route.instance}.${route.chat}`;
    const key = routeKey(route.instance, route.chat);
    if (inFlight.has(key)) {
      // Busy: reply, leave the inbound stored (already recorded) and unhandled.
      publish(replySubject, buildRoutedReplyPayload(route.instance, route.chat, BUSY_NOTICE, genId(), now()));
      log(`[omni] route ${key} busy — dropped inbound ${inboundId} with notice`);
      return;
    }
    inFlight.add(key);
    const run = runOneShot(route, inboundId, message, replySubject, messageId)
      .catch((err) => log(`[omni] one-shot crashed unexpectedly: ${errText(err)}`))
      .finally(() => pending.delete(run));
    pending.add(run);
  }

  /**
   * Set (or swap) genie's OWN status reaction (⏳/✅/❌) on the approval message.
   * Fire-and-forget behind the injectable {@link setReaction} seam and drained by
   * `whenIdle`, so the resolve/announce hot paths never block on the HTTP call. A
   * missing target id (send failed → row un-tagged) is a no-op, as is a target
   * whose ack is already in flight (the reconciliation guard).
   *
   * The glyph is recorded (via {@link recordStatusGlyph}) ONLY on a confirmed
   * successful set: a dropped/failed react leaves `last_status_glyph` unchanged so
   * the reconciliation pass retries it next tick. Never throws — a failed status
   * reaction is logged and the approval decision still stands.
   */
  function emitReaction(params: {
    instance: string;
    chat: string;
    targetId: string | null | undefined;
    emoji: string;
    /** Persist the glyph on `last_status_glyph` (approval rows only). */
    recordGlyph: boolean;
    /** Apply the `ackInFlight` double-fire guard (approval reconciliation only). */
    guard: boolean;
  }): void {
    const { instance, chat, targetId, emoji, recordGlyph, guard } = params;
    if (!targetId) return;
    if (guard && ackInFlight.has(targetId)) return;
    if (guard) ackInFlight.add(targetId);
    const react = setReaction({ instance, chat, messageId: targetId, emoji })
      .then((res) => {
        if (res && res.success === false) {
          log(`[omni] status ${emoji} on ${targetId} failed${res.error ? ` (${res.error})` : ''}`);
          return;
        }
        if (recordGlyph) recordStatusGlyph(db, targetId, emoji); // persist only on confirmed success
      })
      .catch((err) => log(`[omni] status ${emoji} on ${targetId} failed: ${errText(err)}`))
      .finally(() => {
        if (guard) ackInFlight.delete(targetId);
        inFlightReactions.delete(react);
      });
    inFlightReactions.add(react);
  }

  /** Approval-scoped ⏳/✅/❌ ack: scoped to the approval chat, glyph-recorded and
   *  reconciliation-guarded. Unchanged behaviour from before the route path. */
  function emitStatusReaction(targetId: string | null | undefined, emoji: string): void {
    emitReaction({
      instance: config.instance ?? '',
      chat: config.approvalChat ?? '',
      targetId,
      emoji,
      recordGlyph: true,
      guard: true,
    });
  }

  /**
   * Route-scoped run ack: ⏳ before the spawn, ✅ once a reply is published, ❌ on
   * failure/timeout — set on the INBOUND user message (`messageId`), scoped to the
   * route's own (instance, chat), NOT the approval chat. No glyph is recorded (a
   * plain inbound has no approval row) and no reconciliation guard applies (the
   * ⏳→✅/❌ pair fires exactly once, sequentially, per run). A missing messageId is
   * a no-op. Fire-and-forget, drained by `whenIdle`; never blocks the run.
   */
  function emitRouteReaction(route: OmniRoute, messageId: string | undefined, emoji: string): void {
    emitReaction({
      instance: route.instance,
      chat: route.chat,
      targetId: messageId,
      emoji,
      recordGlyph: false,
      guard: false,
    });
  }

  /**
   * Resolve the persona file for a route: the explicit `route.persona` if set,
   * else `<repo>/AGENTS.md` when it exists, else none.
   */
  function resolvePersonaFile(route: OmniRoute): string | undefined {
    if (route.persona) return route.persona;
    const agents = join(route.repo, 'AGENTS.md');
    return existsSync(agents) ? agents : undefined;
  }

  /**
   * Announce a single pending approval via the id-returning send and tag the row
   * with the REAL Omni message id (the stanza id) the send returns — so an
   * inbound reaction correlates to THIS approval. Tags only on a successful send;
   * a failed/id-less send leaves the row un-tagged so the next tick retries
   * (mirrors the old tag-after-publish semantics). On a successful tag it sets the
   * ⏳ status reaction on the sent message (SPIKE c) — the first half of the
   * ⏳→✅/❌ ack. Never throws.
   */
  async function sendAnnounce(appr: { id: string; tool: string; inputSummary: string }): Promise<void> {
    const text = formatApprovalMessage(appr.tool, appr.inputSummary);
    try {
      const result = await sendApproval({ instance: config.instance ?? '', chat: config.approvalChat ?? '', text });
      if (!result.messageId) {
        log(
          `[omni] announce ${appr.id}: send returned no messageId${result.error ? ` (${result.error})` : ''} — will retry`,
        );
        return;
      }
      attachOmniMessageId(db, appr.id, result.messageId);
      log(`[omni] announced approval ${appr.id} (omni ${result.messageId})`);
      emitStatusReaction(result.messageId, STATUS_PENDING); // ⏳ awaiting you
    } catch (err) {
      log(`[omni] announce ${appr.id} failed: ${errText(err)}`);
    }
  }

  /**
   * Send every un-announced pending approval. Fire-and-forget per row (the tick
   * loop never blocks on a slow HTTP send), guarded by `announcing` so a second
   * tick before the first send settles does not double-send.
   */
  function announce(): void {
    for (const appr of listPendingApprovals(db)) {
      if (appr.omniMessageId) continue; // already announced
      if (announcing.has(appr.id)) continue; // send in flight
      announcing.add(appr.id);
      const send = sendAnnounce(appr).finally(() => {
        announcing.delete(appr.id);
        inFlightSends.delete(send);
      });
      inFlightSends.add(send);
    }
  }

  function resolveOldest(decision: ApprovalDecision, resolvedBy: string, note: string): boolean {
    const pending = listPendingApprovals(db);
    if (pending.length === 0) return false;
    return tryResolve(pending[0].id, decision, resolvedBy, note);
  }

  function tryResolve(id: string, decision: ApprovalDecision, resolvedBy: string, note: string): boolean {
    try {
      // Stamp resolved_at with the runner clock so the reconciliation recency
      // window (which reads now() from the same dep) lines up deterministically.
      const row = resolveApproval(db, id, decision, resolvedBy, now());
      log(`[omni] resolved ${id} → ${decision} by ${resolvedBy} (${note})`);
      // Swap the ⏳ status reaction to ✅ (approved) / ❌ (denied) — the row is
      // now closed, so this is the second half of the ⏳→✅/❌ ack.
      emitStatusReaction(row.omniMessageId, decision === 'approved' ? STATUS_APPROVED : STATUS_DENIED);
      return true;
    } catch (err) {
      // Lost the race to another resolver — benign under concurrency.
      if (err instanceof ApprovalConflictError) return false;
      throw err;
    }
  }

  /**
   * Resolve an approval from an inbound reaction. Correlates by the stored real
   * Omni message id (the reaction's target stanza id, from the `[Reaction: … on
   * message <id>]` content or the top-level `messageId`). An EXPLICIT target that
   * matches no pending row is a NO-OP (logged, ignored) — NOT an oldest fallback:
   * a reaction on an already-resolved / unknown message must never resolve some
   * unrelated pending approval (the concurrency hazard this wish exists to kill).
   * Oldest fallback is reserved for the no-target-id case; reactions always carry
   * a target id, so this branch is defensive. Non-vocabulary emoji are ignored.
   */
  function resolveReaction(emoji: string, targetId: string | undefined, sender: string): void {
    const decision = matchReaction(emoji, vocab);
    if (!decision) return;
    if (targetId) {
      const match = listPendingApprovals(db).find((a) => a.omniMessageId === targetId);
      if (match) {
        tryResolve(match.id, decision, sender, `reaction ${emoji}`);
      } else {
        log(`[omni] reaction ${emoji} targets unknown/resolved id ${targetId} — ignored (no oldest fallback)`);
      }
      return;
    }
    resolveOldest(decision, sender, `reaction ${emoji} (fallback)`);
  }

  /**
   * Reconcile the status reaction on every DONE-but-not-terminally-acked row:
   * swap its ⏳ (or missing) glyph to ✅ (approved) / ❌ (denied or expired). This
   * makes the RUNNER the authoritative acker regardless of WHO closed the row —
   * closing the hook-fork-expiry race (the hook's `expireOwnRow` expires the row
   * but sets no reaction, so a ⏳ would otherwise stick on the phone forever) AND
   * any transport-dropped swap (a failed resolve/announce react left the glyph
   * non-terminal). Idempotent: {@link emitStatusReaction} records the terminal
   * glyph on success, so the next tick's query no longer returns the row; the
   * `ackInFlight` guard stops a slow ack re-firing before its glyph is recorded.
   */
  function reconcileStatusAcks(): void {
    for (const row of listApprovalsNeedingStatusAck(db, TERMINAL_STATUS_GLYPHS, now(), RECONCILE_WINDOW_MS)) {
      emitStatusReaction(row.omniMessageId, row.status === 'approved' ? STATUS_APPROVED : STATUS_DENIED);
    }
  }

  return {
    tick(): void {
      // Expire stale rows, then let reconciliation set the terminal ✅/❌ on any
      // row closed here OR by the hook fork's own self-timeout expiry.
      expireStale(db, config.approvals.pollBudgetMs, now());
      reconcileStatusAcks();
      announce();
    },

    handleMessage(subject: string, data: string): void {
      let msg: InboundMessagePayload;
      try {
        msg = JSON.parse(data) as InboundMessagePayload;
      } catch {
        return; // skip malformed
      }
      const chatId = msg.chatId ?? chatIdFromSubject(subject);
      const sender = msg.sender ?? 'whatsapp-user';
      const instance = msg.instanceId ?? config.instance ?? 'unknown';
      const chat = chatId ?? 'unknown';
      const body = msg.content ?? '';

      // Store every inbound message to the inbox — mapped or not.
      const inboundId = recordInbound(db, { instance, chat, sender, body, now: now() });

      // Mapped (instance, chat) → spawn a bounded one-shot; unmapped is store-only.
      // Thread the inbound WhatsApp stanza id so the run can ⏳→✅/❌ react on it.
      const route = findRoute(instance, chat);
      if (route) startRoutedRun(route, inboundId, body, msg.messageId);

      // Only the approval chat can resolve approvals.
      if (!chatId || chatId !== config.approvalChat) return;
      // Instance-scope guard (PR #2507): another instance's reply/reaction must
      // never resolve our approval, even if the approvalChat JID repeats.
      if (msg.instanceId && config.instance && msg.instanceId !== config.instance) return;
      if (!body) return;

      // A reaction reaches genie on THIS subject (SPIKE a) as
      // `[Reaction: <emoji> on message <id>]`; the target id is also the
      // top-level `messageId`. Only this form is a reaction — the dual-emit
      // bare-emoji echo matches neither branch below, so it never double-resolves.
      const reaction = parseReaction(body);
      if (reaction) {
        resolveReaction(reaction.emoji, reaction.targetId || msg.messageId, sender);
        return;
      }

      // Bare text reply → oldest-pending fallback (no quoted id in this build).
      const decision = matchTextToken(body, vocab);
      if (!decision) return;
      resolveOldest(decision, sender, `text:"${body.trim().toLowerCase()}"`);
    },

    async whenIdle(): Promise<void> {
      // Drain one-shot runs, announce sends, AND status reactions in a loop: a
      // send settles by firing the ⏳ status reaction (adds to inFlightReactions
      // mid-drain), and a resolve fires ✅/❌, so the loop must keep going until
      // every set has quiesced.
      while (pending.size > 0 || inFlightSends.size > 0 || inFlightReactions.size > 0) {
        await Promise.allSettled([...pending, ...inFlightSends, ...inFlightReactions]);
      }
    },
  };
}

// ============================================================================
// Serve loop
// ============================================================================

export interface RunOmniServeOptions {
  db: Database;
  config: OmniRuntimeConfig;
  natsFactory?: NatsFactory;
  /** Abort to stop the loop (unsubscribe, clear timer, close connection). */
  signal?: AbortSignal;
  /** Fired once subscriptions + tick loop are live (tests await this). */
  onReady?: () => void;
  log?: (line: string) => void;
}

/** Drain one subscription into a handler, tolerating per-message failures. */
async function consume(
  sub: NatsSubscription,
  handle: (subject: string, data: string) => void,
  log: (line: string) => void,
): Promise<void> {
  const dec = new TextDecoder();
  try {
    for await (const m of sub) {
      try {
        handle(m.subject, dec.decode(m.data));
      } catch (err) {
        log(`[omni] handler error on ${m.subject}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch {
    // Subscription closed (unsubscribe / connection teardown) — normal exit.
  }
}

export async function runOmniServe(opts: RunOmniServeOptions): Promise<void> {
  const { db, config } = opts;
  const log = opts.log ?? (() => {});
  const factory = opts.natsFactory ?? defaultNatsFactory;

  const nc = await factory({ servers: config.natsUrl });
  const runner = createOmniRunner({ db, config, publish: nc.publish, log });

  // Both text replies AND reactions arrive on `omni.message.{instance}.>` in this
  // Omni build; the legacy `omni.event.>` subject has no publishers (SPIKE a), so
  // it is no longer subscribed.
  const msgSub = nc.subscribe(`omni.message.${config.instance}.>`);
  void consume(msgSub, runner.handleMessage, log);

  const timer = setInterval(() => {
    try {
      runner.tick();
    } catch (err) {
      log(`[omni] tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, config.approvals.pollIntervalMs);

  runner.tick(); // announce anything already queued
  log(`[omni] serving — instance=${config.instance} chat=${config.approvalChat} nats=${config.natsUrl}`);
  opts.onReady?.();

  await new Promise<void>((resolve) => {
    if (opts.signal?.aborted) return resolve();
    opts.signal?.addEventListener('abort', () => resolve(), { once: true });
  });

  clearInterval(timer);
  msgSub.unsubscribe();
  await nc.close();
  log('[omni] stopped');
}
