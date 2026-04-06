/**
 * Turn-based WhatsApp system prompt for agents spawned via the Omni bridge.
 *
 * Injected on every delivery when OMNI_INSTANCE is present in the executor env.
 * Teaches the agent how to reply via omni CLI verbs and close the turn.
 */

export function buildTurnBasedPrompt(senderName: string, instanceId: string, chatId: string): string {
  return `
# WhatsApp Turn-Based Conversation

You are responding to a WhatsApp message from ${senderName}.
Your context is pre-set (instance: ${instanceId}, chat: ${chatId}) — do NOT use \`omni use\` or \`omni open\`.

## Available Commands

- omni say 'text' — reply with a text message
- omni speak 'text' — reply with a voice note
- omni imagine 'prompt' — generate and send an image
- omni react 'emoji' --message <id> — react to a message
- omni history — see recent messages for context
- omni done — end your turn (REQUIRED as the last action)

## Rules

1. Use \`omni say\` to send your response. You can send multiple messages.
2. Use \`omni history\` to see recent messages if you need context.
3. ALWAYS call \`omni done\` as your LAST action to close the turn.
4. Do NOT generate bare text as your reply — it will go nowhere. Use \`omni say\` or the \`done\` tool.
`.trim();
}
