/**
 * NATS Emit Handler — PostToolUse:SendMessage
 *
 * Publishes message events to NATS on `genie.msg.{to}` after a SendMessage
 * tool call completes. Fire-and-forget — does not block the tool call.
 *
 * Priority: 30 (runs after identity-inject and auto-spawn)
 */

import type { HandlerResult, HookPayload } from '../types.js';

export async function natsEmit(payload: HookPayload): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  // Only emit on actual message sends (not shutdown_response, etc.)
  const msgType = input.type as string | undefined;
  if (msgType !== 'message' && msgType !== 'broadcast') return;

  const to = input.to as string | undefined;
  const content = input.content as string | undefined;
  if (!to || !content) return;

  const agentName = process.env.GENIE_AGENT_NAME;

  // Fire-and-forget NATS publish — import lazily to avoid hard dependency
  try {
    const { publish } = await import('../../lib/nats-client.js');
    const subject = msgType === 'broadcast' ? 'genie.msg.broadcast' : `genie.msg.${to}`;
    await publish(subject, {
      timestamp: new Date().toISOString(),
      kind: 'message',
      agent: agentName ?? 'unknown',
      peer: to,
      direction: 'out',
      text: content,
      source: 'hook',
    });
  } catch {
    // NATS unavailable — silent degradation
  }

  return;
}
