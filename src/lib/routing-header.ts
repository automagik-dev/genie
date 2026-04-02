/**
 * Routing Header Parser + Session Key Resolver
 *
 * Parses bracket-delimited routing headers from Omni-relayed messages
 * and resolves deterministic session keys for per-user/per-chat routing.
 *
 * Header format: [channel:<ch> instance:<id> chat:<jid> msg:<id> from:<name> type:<dm|group>]
 * Optional fields: thread:<id>, replyTo:<id>
 */

import { createHash } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

interface RoutingHeader {
  channel: string; // telegram, whatsapp-baileys, discord, slack
  instance: string; // source instance ID
  chat: string; // chat/conversation ID
  thread?: string; // thread/topic ID
  msg: string; // message ID
  from: string; // sender display name
  type: 'dm' | 'group'; // message type
  replyTo?: string; // referenced message ID
}

/** Required fields that must be present for a valid routing header. */
const REQUIRED_FIELDS = ['channel', 'instance', 'chat', 'msg', 'from', 'type'] as const;

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse a routing header from the first line of a message.
 *
 * Matches: `[key:value key:value ...]`
 * Returns null if the first line is not a valid routing header.
 */
export function parseRoutingHeader(text: string): RoutingHeader | null {
  if (!text) return null;

  const firstLine = text.split('\n')[0].trim();
  const match = firstLine.match(/^\[(.+)\]$/);
  if (!match) return null;

  const inner = match[1];
  const pairs = inner.split(/\s+/);
  const fields: Record<string, string> = {};

  for (const pair of pairs) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = pair.slice(0, colonIdx);
    const value = pair.slice(colonIdx + 1);
    if (key && value) {
      fields[key] = value;
    }
  }

  // Validate required fields
  for (const field of REQUIRED_FIELDS) {
    if (!fields[field]) return null;
  }

  // Validate type field
  if (fields.type !== 'dm' && fields.type !== 'group') return null;

  return {
    channel: fields.channel,
    instance: fields.instance,
    chat: fields.chat,
    msg: fields.msg,
    from: fields.from,
    type: fields.type as 'dm' | 'group',
    thread: fields.thread,
    replyTo: fields.replyTo,
  };
}

// ============================================================================
// Session Key Resolver
// ============================================================================

/**
 * Hash a string to 8 hex chars for readable, collision-resistant IDs.
 */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * Resolve a deterministic session key from an agent name and routing header.
 *
 * Rules:
 * - DM (no thread):  `{agent}-{hash(channel-instance-chat)}`
 * - DM (threaded):   `{agent}-{hash(channel-instance-chat)}-{thread}`
 * - Group (no thread): `{agent}-{hash(channel-instance-chat)}`
 * - Group (threaded):  `{agent}-{hash(channel-instance-chat)}-{thread}`
 */
export function resolveSessionKey(agentName: string, header: RoutingHeader): string {
  const chatId = shortHash(`${header.channel}-${header.instance}-${header.chat}`);
  const base = `${agentName}-${chatId}`;

  if (header.thread) {
    return `${base}-${header.thread}`;
  }

  return base;
}

/**
 * Extract the message body (everything after the routing header line).
 * Returns the full text if no routing header is present.
 */
export function stripRoutingHeader(text: string): string {
  if (!text) return text;

  const firstNewline = text.indexOf('\n');
  if (firstNewline === -1) {
    // Single line — if it's a header, body is empty
    const firstLine = text.trim();
    return firstLine.match(/^\[(.+)\]$/) ? '' : text;
  }

  const firstLine = text.slice(0, firstNewline).trim();
  if (firstLine.match(/^\[(.+)\]$/)) {
    return text.slice(firstNewline + 1);
  }

  return text;
}
