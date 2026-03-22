/**
 * NATS Emit Handlers — Publish ALL agent activity to NATS for real-time observability.
 *
 * Hooks:
 *   PreToolUse (all tools)    → genie.tool.{agent}.call
 *   PostToolUse:SendMessage   → genie.msg.{to}
 *   UserPromptSubmit          → genie.user.{agent}.prompt
 *   Stop                      → genie.agent.{agent}.response
 *
 * Priority: 30 (runs after identity-inject and auto-spawn)
 * Fire-and-forget — does not block execution.
 */

import type { HandlerResult, HookPayload } from '../types.js';

const getAgent = () => process.env.GENIE_AGENT_NAME ?? 'unknown';
const getTeam = () => process.env.GENIE_TEAM;

async function emit(subject: string, event: Record<string, unknown>): Promise<void> {
  try {
    const { publish } = await import('../../lib/nats-client.js');
    await publish(subject, event);
  } catch {
    // NATS unavailable — silent degradation
  }
}

/** Emit tool call events on PreToolUse (all tools). */
export async function natsEmitToolCall(payload: HookPayload): Promise<HandlerResult> {
  const toolName = payload.tool_name;
  const input = payload.tool_input;
  if (!toolName || !input) return;

  await emit(`genie.tool.${getAgent()}.call`, {
    timestamp: new Date().toISOString(),
    kind: 'tool_call',
    agent: getAgent(),
    team: getTeam(),
    text: summarizeToolCall(toolName, input),
    data: { toolCall: { name: toolName, input } },
    source: 'hook',
  });

  return;
}

/** Emit message events on PostToolUse:SendMessage. */
export async function natsEmit(payload: HookPayload): Promise<HandlerResult> {
  const input = payload.tool_input;
  if (!input) return;

  const msgType = input.type as string | undefined;
  if (msgType !== 'message' && msgType !== 'broadcast') return;

  const to = input.to as string | undefined;
  const content = input.content as string | undefined;
  if (!to || !content) return;

  const subject = msgType === 'broadcast' ? 'genie.msg.broadcast' : `genie.msg.${to}`;
  await emit(subject, {
    timestamp: new Date().toISOString(),
    kind: 'message',
    agent: getAgent(),
    peer: to,
    direction: 'out',
    text: content,
    source: 'hook',
  });

  return;
}

/** Emit user prompt on UserPromptSubmit. */
export async function natsEmitUserPrompt(payload: HookPayload): Promise<HandlerResult> {
  const prompt = payload.prompt as string | undefined;
  if (!prompt) return;

  await emit(`genie.user.${getAgent()}.prompt`, {
    timestamp: new Date().toISOString(),
    kind: 'user',
    agent: getAgent(),
    team: getTeam(),
    text: prompt,
    source: 'hook',
  });

  return;
}

/** Emit assistant response on Stop. */
export async function natsEmitAssistantResponse(payload: HookPayload): Promise<HandlerResult> {
  const lastMessage = payload.last_assistant_message as string | undefined;
  if (!lastMessage) return;

  await emit(`genie.agent.${getAgent()}.response`, {
    timestamp: new Date().toISOString(),
    kind: 'assistant',
    agent: getAgent(),
    team: getTeam(),
    text: lastMessage,
    source: 'hook',
  });

  return;
}

function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return `${name} ${input.file_path ?? ''}`;
    case 'Bash': {
      const cmd = String(input.command ?? '').split('\n')[0];
      return `$ ${cmd}`;
    }
    case 'Grep':
      return `Grep "${input.pattern}" ${input.path ?? ''}`;
    case 'Glob':
      return `Glob ${input.pattern}`;
    case 'Agent':
      return `Agent: ${input.description ?? ''}`;
    case 'SendMessage':
      return `SendMessage → ${input.to}: ${String(input.message ?? '').slice(0, 80)}`;
    default:
      return name;
  }
}
