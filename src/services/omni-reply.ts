/**
 * Omni Reply Publisher — Publish agent replies to NATS.
 *
 * Two modes:
 *   1. Library: import and call publishReply() from TypeScript
 *   2. CLI: pipe JSON via stdin (used by omni-reply.sh fallback)
 *
 * The reply is published to `omni.reply.{instance}.{chat_id}` so
 * Omni's NATS subscriber can route it to the correct WhatsApp chat.
 */

import { StringCodec, connect } from 'nats';

// ============================================================================
// Types
// ============================================================================

export interface OmniReply {
  content: string;
  agent: string;
  chat_id: string;
  instance_id: string;
  timestamp: string;
  auto_reply?: boolean;
}

// ============================================================================
// Publisher
// ============================================================================

/**
 * Publish a reply to NATS for Omni delivery.
 *
 * @param reply - The reply payload
 * @param natsUrl - NATS server URL (default: localhost:4222)
 */
export async function publishReply(reply: OmniReply, natsUrl?: string): Promise<void> {
  const url = natsUrl ?? process.env.OMNI_NATS_URL ?? 'localhost:4222';
  const topic = process.env.OMNI_REPLY_TOPIC ?? `omni.reply.${reply.instance_id}.${reply.chat_id}`;

  const nc = await connect({ servers: url, name: 'genie-omni-reply' });
  const sc = StringCodec();

  nc.publish(topic, sc.encode(JSON.stringify(reply)));
  await nc.flush();
  await nc.close();
}

// ============================================================================
// CLI Mode — read JSON from stdin
// ============================================================================

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('omni-reply.ts')) {
  (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString('utf-8').trim();
    if (!input) process.exit(0);

    try {
      const reply: OmniReply = JSON.parse(input);
      await publishReply(reply);
    } catch (err) {
      console.error('[omni-reply] Failed to publish:', err);
      process.exit(1);
    }
  })();
}
