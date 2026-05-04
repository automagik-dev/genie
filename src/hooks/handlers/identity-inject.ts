/**
 * Identity Inject Handler — PreToolUse:SendMessage
 *
 * Injects [from:<agent-name>] into SendMessage content so recipients
 * always know who sent the message, even across teams.
 *
 * Priority: 10 (runs before auto-spawn)
 */

import { readEnvAgentId, readEnvAgentName } from '../env-identity.js';
import type { HandlerResult, HookPayload } from '../types.js';

export async function identityInject(payload: HookPayload): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  // Only inject on outgoing messages (not shutdown_response, etc.)
  // Native CC SendMessage has no type field — treat as message by default.
  const msgType = input.type as string | undefined;
  if (msgType && msgType !== 'message' && msgType !== 'broadcast') return;

  // Read both env forms — UUID is the canonical post-061 identity, name is
  // the human-readable alias spawn exports. Tag prefers the name for
  // recipient UX ([from:engineer-g7] beats [from:<uuid>]); the id is only
  // used as a last-resort identifier when the spawn flow didn't export a name.
  const envAgentId = readEnvAgentId();
  const envAgentName = readEnvAgentName();
  const agentName = envAgentName ?? envAgentId;
  if (!agentName) return;

  // Support both genie-internal (content) and native CC (message) field names
  const contentField = input.content !== undefined ? 'content' : 'message';
  const content = input[contentField] as string | undefined;
  if (!content) return;

  // Don't double-inject if already tagged
  if (content.startsWith(`[from:${agentName}]`)) return;

  return {
    updatedInput: {
      ...input,
      [contentField]: `[from:${agentName}] ${content}`,
    },
  };
}
