/**
 * Omni runner — the one resident process (`genie omni serve`).
 *
 * Owns the NATS transport and the two-way bridge between the phone and the
 * global approval queue:
 *   - subscribes `omni.message.{instance}.>` (text replies) and `omni.event.>`
 *     (reactions);
 *   - on each new pending approval row, PUBLISHES an approval-request to
 *     `omni.reply.{instance}.{chat}` (outbound send subject, mirroring v4's
 *     omni-bridge) and tags the row with a correlation id;
 *   - matches inbound replies/reactions against the approve/deny vocabulary and
 *     resolves the oldest pending approval (or the reaction-correlated one);
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
import type { OmniRuntimeConfig } from './omni-config.js';
import { matchReaction, matchTextToken } from './omni-matching.js';
import {
  ApprovalConflictError,
  type ApprovalDecision,
  attachOmniMessageId,
  expireStale,
  listPendingApprovals,
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
}

interface ReactionEventPayload {
  type?: string;
  emoji?: string;
  messageId?: string;
  chatId?: string;
  instanceId?: string;
  sender?: string;
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
  /** Injectable correlation-id generator (tagged onto the outbound request). */
  genCorrelationId?: () => string;
}

export interface OmniRunner {
  /** Publish any un-announced pending approvals + expire stale rows. */
  tick(): void;
  /** Handle one inbound `omni.message.*` frame. */
  handleMessage(subject: string, data: string): void;
  /** Handle one inbound `omni.event.*` frame (reactions). */
  handleEvent(subject: string, data: string): void;
}

function formatApprovalMessage(tool: string, inputSummary: string, correlationId: string): string {
  const preview = inputSummary.length > 200 ? `${inputSummary.slice(0, 197)}...` : inputSummary;
  return [
    '\u{1F514} *Approval Required*',
    '',
    `Tool: \`${tool}\``,
    `Preview: ${preview}`,
    '',
    'Reply *y* to approve or *n* to deny',
    'Or react \u{1F44D} / \u{1F44E}',
    '',
    `_ref: ${correlationId}_`,
  ].join('\n');
}

/** Outbound reply payload shape — mirrors origin/v4 omni-bridge replies. */
function buildOutboundPayload(
  config: OmniRuntimeConfig,
  content: string,
  correlationId: string,
  nowMs: number,
): string {
  return JSON.stringify({
    content,
    agent: 'genie',
    chat_id: config.approvalChat,
    instance_id: config.instance,
    request_id: correlationId,
    timestamp: new Date(nowMs).toISOString(),
  });
}

/** chat id from payload, else parsed from `omni.message.{instance}.{chat...}`. */
function chatIdFromSubject(subject: string): string | undefined {
  const parts = subject.split('.');
  return parts.length >= 4 ? parts.slice(3).join('.') : undefined;
}

export function createOmniRunner(deps: OmniRunnerDeps): OmniRunner {
  const { db, config, publish } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const genId =
    deps.genCorrelationId ?? (() => `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  const vocab = {
    approveTokens: config.approveTokens,
    denyTokens: config.denyTokens,
    approveReactions: config.approveReactions,
    denyReactions: config.denyReactions,
  };

  function announce(): void {
    for (const appr of listPendingApprovals(db)) {
      if (appr.omniMessageId) continue; // already announced
      const correlationId = genId();
      const text = formatApprovalMessage(appr.tool, appr.inputSummary, correlationId);
      const subject = `omni.reply.${config.instance}.${config.approvalChat}`;
      publish(subject, buildOutboundPayload(config, text, correlationId, now()));
      // Tag AFTER publishing so a crash mid-publish re-announces rather than
      // silently dropping the request.
      attachOmniMessageId(db, appr.id, correlationId);
      log(`[omni] announced approval ${appr.id} (ref ${correlationId})`);
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

      // Store every inbound message to the inbox (Group 4 will spawn from it).
      recordInbound(db, {
        instance: msg.instanceId ?? config.instance ?? 'unknown',
        chat: chatId ?? 'unknown',
        sender,
        body: msg.content ?? '',
        now: now(),
      });

      // Only the approval chat can resolve approvals.
      if (!chatId || chatId !== config.approvalChat) return;
      if (!msg.content) return;
      const decision = matchTextToken(msg.content, vocab);
      if (!decision) return;
      resolveOldest(decision, sender, `text:"${msg.content.trim().toLowerCase()}"`);
    },

    handleEvent(subject: string, data: string): void {
      let evt: ReactionEventPayload;
      try {
        evt = JSON.parse(data) as ReactionEventPayload;
      } catch {
        return;
      }
      if (evt.type !== 'reaction' || !evt.emoji) return;
      const chatId = evt.chatId ?? chatIdFromSubject(subject);
      if (!chatId || chatId !== config.approvalChat) return;
      const decision = matchReaction(evt.emoji, vocab);
      if (!decision) return;
      const sender = evt.sender ?? 'whatsapp-user';

      // Correlate by the ref we tagged onto the row, else fall back to oldest.
      if (evt.messageId) {
        const match = listPendingApprovals(db).find((a) => a.omniMessageId === evt.messageId);
        if (match) {
          tryResolve(match.id, decision, sender, `reaction ${evt.emoji}`);
          return;
        }
      }
      resolveOldest(decision, sender, `reaction ${evt.emoji} (fallback)`);
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

  const msgSub = nc.subscribe(`omni.message.${config.instance}.>`);
  const evtSub = nc.subscribe('omni.event.>');
  void consume(msgSub, runner.handleMessage, log);
  void consume(evtSub, runner.handleEvent, log);

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
  evtSub.unsubscribe();
  await nc.close();
  log('[omni] stopped');
}
