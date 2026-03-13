/**
 * Identity Inject Handler — PreToolUse:SendMessage
 *
 * Injects [from:<agent-name>] into SendMessage content so recipients
 * always know who sent the message, even across teams.
 *
 * Priority: 10 (runs before auto-spawn)
 */

import type { HandlerResult, HookPayload } from '../types.js';

export async function identityInject(payload: HookPayload): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  // Only inject on outgoing messages (not shutdown_response, etc.)
  const msgType = input.type as string | undefined;
  if (msgType !== 'message' && msgType !== 'broadcast') return;

  // Resolve agent name from env (set by genie agent spawn via GENIE_AGENT_NAME)
  const agentName = process.env.GENIE_AGENT_NAME;
  if (!agentName) return;

  const content = input.content as string | undefined;
  if (!content) return;

  // Don't double-inject if already tagged
  if (content.startsWith(`[from:${agentName}]`)) return;

  return {
    updatedInput: {
      ...input,
      content: `[from:${agentName}] ${content}`,
    },
  };
}
