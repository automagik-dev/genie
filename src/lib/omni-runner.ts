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
import type { OmniRoute, OmniRuntimeConfig } from './omni-config.js';
import { matchReaction, matchTextToken } from './omni-matching.js';
import { signOmniRequest } from './omni-signature.js';
import {
  ApprovalConflictError,
  type ApprovalDecision,
  attachOmniMessageId,
  expireStale,
  listPendingApprovals,
  markHandled,
  recordInbound,
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
}

export interface SpawnClaudeResult {
  /** Captured stdout of the run (truncated to the reply cap before publishing). */
  stdout: string;
  /** Process exit code; non-zero is surfaced as a bounded error notice. */
  exitCode: number;
}

/** Bounded one-shot `claude -p` executor. Injectable so tests never fork claude. */
export type SpawnClaude = (opts: SpawnClaudeOpts) => Promise<SpawnClaudeResult>;

/**
 * Default executor — a real `claude -p "<message>"` bounded by the caller's
 * abort signal. Never imported at module top-level cost; only invoked once an
 * inbound message actually matches a configured route.
 */
export const defaultSpawnClaude: SpawnClaude = async ({ message, cwd, signal }) => {
  const proc = Bun.spawn(['claude', '-p', message], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // Bun forwards the AbortSignal: aborting SIGKILLs the child, freeing the route.
    signal,
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
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
  const routeKey = (instance: string, chat: string): string => `${instance} ${chat}`;
  const findRoute = (instance: string, chat: string): OmniRoute | undefined =>
    routes.find((r) => r.instance === instance && r.chat === chat);

  /**
   * Drive one bounded `claude -p` for a mapped inbound. Owns the timeout (races
   * the spawn against an abort), the output cap, and the reply publish. Every
   * exit path publishes exactly one reply, marks the inbound handled, and clears
   * the in-flight flag — a child crash NEVER escapes this function.
   */
  async function runOneShot(route: OmniRoute, inboundId: string, message: string, replySubject: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new OneShotTimeoutError()), { once: true });
    });
    try {
      // Wrap so a SYNCHRONOUS throw from the executor becomes a rejection the
      // race can observe — and so `aborted` always gets a handler attached
      // (else a late finally-abort would surface as an unhandled rejection).
      const spawned = Promise.resolve().then(() =>
        spawnClaude({ message, cwd: route.repo, signal: controller.signal }),
      );
      const result = await Promise.race([spawned, aborted]);
      const content =
        result.exitCode === 0
          ? truncateReply(result.stdout, maxReplyChars)
          : errorNotice(`exit code ${result.exitCode}`);
      publish(replySubject, buildRoutedReplyPayload(route.instance, route.chat, content, genId(), now()));
    } catch (err) {
      const content = err instanceof OneShotTimeoutError ? timeoutNotice(timeoutMs) : errorNotice(errText(err));
      publish(replySubject, buildRoutedReplyPayload(route.instance, route.chat, content, genId(), now()));
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
  function startRoutedRun(route: OmniRoute, inboundId: string, message: string): void {
    const replySubject = `omni.reply.${route.instance}.${route.chat}`;
    const key = routeKey(route.instance, route.chat);
    if (inFlight.has(key)) {
      // Busy: reply, leave the inbound stored (already recorded) and unhandled.
      publish(replySubject, buildRoutedReplyPayload(route.instance, route.chat, BUSY_NOTICE, genId(), now()));
      log(`[omni] route ${key} busy — dropped inbound ${inboundId} with notice`);
      return;
    }
    inFlight.add(key);
    const run = runOneShot(route, inboundId, message, replySubject)
      .catch((err) => log(`[omni] one-shot crashed unexpectedly: ${errText(err)}`))
      .finally(() => pending.delete(run));
    pending.add(run);
  }

  /**
   * Announce a single pending approval via the id-returning send and tag the row
   * with the REAL Omni message id (the stanza id) the send returns — so an
   * inbound reaction correlates to THIS approval. Tags only on a successful send;
   * a failed/id-less send leaves the row un-tagged so the next tick retries
   * (mirrors the old tag-after-publish semantics). Never throws.
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
      resolveApproval(db, id, decision, resolvedBy);
      log(`[omni] resolved ${id} → ${decision} by ${resolvedBy} (${note})`);
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
   * message <id>]` content or the top-level `messageId`); falls back to oldest
   * only when no pending row carries that id. Non-vocabulary emoji are ignored.
   */
  function resolveReaction(emoji: string, targetId: string | undefined, sender: string): void {
    const decision = matchReaction(emoji, vocab);
    if (!decision) return;
    if (targetId) {
      const match = listPendingApprovals(db).find((a) => a.omniMessageId === targetId);
      if (match) {
        tryResolve(match.id, decision, sender, `reaction ${emoji}`);
        return;
      }
    }
    resolveOldest(decision, sender, `reaction ${emoji} (fallback)`);
  }

  return {
    tick(): void {
      expireStale(db, config.approvals.pollBudgetMs, now());
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
      const route = findRoute(instance, chat);
      if (route) startRoutedRun(route, inboundId, body);

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
      // Drain both one-shot runs and announce sends in a loop: a settling task
      // must not add new work, but snapshot-await is cheap insurance against
      // future callers that fan out mid-drain.
      while (pending.size > 0 || inFlightSends.size > 0) {
        await Promise.allSettled([...pending, ...inFlightSends]);
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
