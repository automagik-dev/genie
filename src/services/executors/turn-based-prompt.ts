/**
 * Turn-based WhatsApp orchestration prompt for agents spawned via the Omni bridge.
 *
 * Injected as a prefix to the initial user message (NOT in the system prompt).
 * This is operational context — it tells the agent HOW to interact in this turn,
 * not WHO it is. Identity stays in AGENTS.md (system prompt).
 */

export function buildTurnBasedPrompt(senderName: string, instanceId: string, chatId: string): string {
  return `
[WhatsApp Turn — reply to ${senderName}]

You received a WhatsApp message. Read it, reply, then close the turn.
Context is pre-set (instance: ${instanceId}, chat: ${chatId}) — do NOT run \`omni use\` or \`omni open\`.

Reply with omni verbs:
- \`omni say "your reply"\` — send a text message
- \`omni speak "text" --voice Kore\` — send a voice note
- \`omni imagine "prompt"\` — generate and send an image
- \`omni react "👍"\` — react to the trigger message
- \`omni done\` — close the turn (ALWAYS your last action)

Flow: 1) \`omni say "..."\` to reply → 2) \`omni done\` to close.
Bare text output goes nowhere — you MUST use omni verbs to reach the user.

The user's message:
`.trim();
}
