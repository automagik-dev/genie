/**
 * Omni Approval Handler — matches incoming WhatsApp messages and reactions
 * against pending approvals and resolves them.
 *
 * Architecture:
 *   - Subscribes to NATS `omni.message.{instance}.{chat}` for text replies
 *   - Subscribes to `omni.event.>` for reaction events
 *   - Text replies are matched against configurable approve/deny tokens
 *   - Reactions are matched by emoji and correlated via omni_message_id
 *   - Resolved via the same PG approval queue used by the SDK hook
 */

import { type NatsConnection, StringCodec, type Subscription, connect } from 'nats';
import { getConnection } from './db.js';
import { listPendingApprovals, resolveApproval } from './providers/claude-sdk-remote-approval.js';
import { type PermissionsConfig, findWorkspace, getWorkspaceConfig } from './workspace.js';

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_APPROVE_TOKENS = ['y', 'yes', 'approve', 'sim'];
const DEFAULT_DENY_TOKENS = ['n', 'no', 'deny', 'nao'];
const DEFAULT_APPROVE_REACTIONS = ['\u{1F44D}', '\u{2705}', '\u{1F44C}']; // 👍 ✅ 👌
const DEFAULT_DENY_REACTIONS = ['\u{1F44E}', '\u{274C}', '\u{1F6AB}']; // 👎 ❌ 🚫

// ============================================================================
// Types
// ============================================================================

interface OmniApprovalHandlerConfig {
  natsUrl?: string;
  permissions: PermissionsConfig;
}

/** Inbound NATS message payload from Omni. */
interface InboundMessage {
  content?: string;
  sender?: string;
  instanceId?: string;
  chatId?: string;
  agent?: string;
}

/** Inbound reaction event from Omni event stream. */
interface ReactionEvent {
  type?: string;
  emoji?: string;
  messageId?: string;
  chatId?: string;
  instanceId?: string;
  sender?: string;
}

// ============================================================================
// Handler
// ============================================================================

let handlerInstance: OmniApprovalHandler | null = null;

class OmniApprovalHandler {
  private nc: NatsConnection | null = null;
  private subs: Subscription[] = [];
  private sc = StringCodec();
  private readonly permissions: PermissionsConfig;
  private readonly natsUrl: string;
  private readonly approveTokens: string[];
  private readonly denyTokens: string[];

  constructor(config: OmniApprovalHandlerConfig) {
    this.permissions = config.permissions;
    this.natsUrl = config.natsUrl ?? 'localhost:4222';
    this.approveTokens = (config.permissions.approveTokens ?? DEFAULT_APPROVE_TOKENS).map((t) => t.toLowerCase());
    this.denyTokens = (config.permissions.denyTokens ?? DEFAULT_DENY_TOKENS).map((t) => t.toLowerCase());
  }

  async start(): Promise<void> {
    const { omniChat, omniInstance } = this.permissions;
    if (!omniChat || !omniInstance) return;

    this.nc = await connect({ servers: this.natsUrl });

    // Subscribe to messages on the approval chat
    // WhatsApp chat JIDs contain dots, so use `>` wildcard after instance
    const messageTopic = `omni.message.${omniInstance}.>`;
    const msgSub = this.nc.subscribe(messageTopic);
    this.subs.push(msgSub);
    this.processMessages(msgSub);

    // Subscribe to event stream for reactions
    const eventSub = this.nc.subscribe('omni.event.>');
    this.subs.push(eventSub);
    this.processEvents(eventSub);

    handlerInstance = this;
    console.log(`[omni-approval] Listening for approval replies on ${messageTopic}`);
  }

  async stop(): Promise<void> {
    for (const sub of this.subs) {
      sub.unsubscribe();
    }
    this.subs = [];
    if (this.nc) {
      await this.nc.close();
      this.nc = null;
    }
    if (handlerInstance === this) handlerInstance = null;
  }

  // --------------------------------------------------------------------------
  // Message processing
  // --------------------------------------------------------------------------

  private async processMessages(sub: Subscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const data: InboundMessage = JSON.parse(this.sc.decode(msg.data));

        // Filter: only process messages from the configured approval chat
        const chatId = data.chatId ?? this.extractChatIdFromSubject(msg.subject);
        if (chatId !== this.permissions.omniChat) continue;

        if (data.content) {
          await this.handleTextReply(data.content, data.sender ?? 'whatsapp-user');
        }
      } catch {
        /* skip malformed messages */
      }
    }
  }

  private async processEvents(sub: Subscription): Promise<void> {
    for await (const msg of sub) {
      try {
        const data: ReactionEvent = JSON.parse(this.sc.decode(msg.data));
        if (data.type !== 'reaction') continue;
        if (data.chatId !== this.permissions.omniChat || data.instanceId !== this.permissions.omniInstance) continue;

        if (data.emoji && data.messageId) {
          await this.handleReaction(data.emoji, data.messageId, data.sender ?? 'whatsapp-user');
        }
      } catch {
        /* skip non-JSON or irrelevant events */
      }
    }
  }

  /** Extract chat ID from NATS subject: omni.message.{instance}.{chatId...} */
  private extractChatIdFromSubject(subject: string): string | undefined {
    const parts = subject.split('.');
    // subject: omni.message.{instance}.{chat} — chat may contain dots
    if (parts.length >= 4) return parts.slice(3).join('.');
    return undefined;
  }

  // --------------------------------------------------------------------------
  // Token matching
  // --------------------------------------------------------------------------

  /**
   * Match text content against approve/deny tokens.
   * Resolves the oldest pending approval on match.
   */
  async handleTextReply(content: string, sender: string): Promise<boolean> {
    const normalized = content.trim().toLowerCase();
    if (!normalized) return false;

    let decision: 'allow' | 'deny' | null = null;
    if (this.approveTokens.includes(normalized)) decision = 'allow';
    else if (this.denyTokens.includes(normalized)) decision = 'deny';
    if (!decision) return false;

    // Resolve the oldest pending approval (FIFO)
    const pending = await listPendingApprovals();
    if (pending.length === 0) return false;

    const oldest = pending[0]; // Already sorted by created_at ASC
    const resolved = await resolveApproval(oldest.id, decision, sender);
    if (resolved) {
      console.log(`[omni-approval] Resolved ${oldest.id} as ${decision} by ${sender} (text: "${normalized}")`);
    }
    return resolved;
  }

  /**
   * Match reaction emoji against approval message.
   * Looks up the approval by omni_message_id, falls back to oldest pending.
   */
  async handleReaction(emoji: string, messageId: string, sender: string): Promise<boolean> {
    let decision: 'allow' | 'deny' | null = null;
    if (DEFAULT_APPROVE_REACTIONS.includes(emoji)) decision = 'allow';
    else if (DEFAULT_DENY_REACTIONS.includes(emoji)) decision = 'deny';
    if (!decision) return false;

    // Try exact match via omni_message_id
    try {
      const sql = await getConnection();
      const [approval] = await sql`
        SELECT id FROM approvals
        WHERE omni_message_id = ${messageId} AND decision = 'pending'
      `;
      if (approval) {
        const resolved = await resolveApproval(approval.id, decision, sender);
        if (resolved) {
          console.log(`[omni-approval] Resolved ${approval.id} via reaction ${emoji} by ${sender}`);
        }
        return resolved;
      }
    } catch {
      /* column may not exist yet — fall through to FIFO */
    }

    // Fallback: resolve the oldest pending approval
    const pending = await listPendingApprovals();
    if (pending.length === 0) return false;

    const resolved = await resolveApproval(pending[0].id, decision, sender);
    if (resolved) {
      console.log(`[omni-approval] Resolved ${pending[0].id} via reaction ${emoji} by ${sender} (fallback)`);
    }
    return resolved;
  }
}

// ============================================================================
// Lifecycle helpers
// ============================================================================

/** Start the Omni approval handler using workspace config. */
export async function startOmniApprovalHandler(natsUrl?: string): Promise<OmniApprovalHandler | null> {
  const ws = findWorkspace();
  if (!ws) return null;

  const config = getWorkspaceConfig(ws.root);
  if (!config.permissions?.omniChat || !config.permissions?.omniInstance) return null;

  const handler = new OmniApprovalHandler({
    natsUrl,
    permissions: config.permissions,
  });

  await handler.start();
  return handler;
}
