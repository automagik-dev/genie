/**
 * genie agent inbox — Inbox management (list, watch).
 * Migrated from `genie inbox` in msg.ts.
 */

import type { Command } from 'commander';
import { emitEvent } from '../../lib/emit.js';
import type * as taskServiceTypes from '../../lib/task-service.js';
import { formatTime, padRight, truncate } from '../../lib/term-format.js';
import { detectSenderIdentity } from '../msg.js';

let _taskService: typeof taskServiceTypes | undefined;
async function getTaskService(): Promise<typeof taskServiceTypes> {
  if (!_taskService) _taskService = await import('../../lib/task-service.js');
  return _taskService;
}

/**
 * Extract the channel `source` tag from a message-like object. Defaults to
 * `'agent'` for messages without metadata or with an empty/non-string source.
 *
 * Exported for unit tests and future renderers.
 */
// biome-ignore lint/suspicious/noExplicitAny: message metadata shape varies across stores
export function extractSource(msg: any): string {
  if (!msg || typeof msg !== 'object') return 'agent';
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  const value = typeof meta.source === 'string' ? meta.source : null;
  return value && value.length > 0 ? value : 'agent';
}

/**
 * Build the human-readable inbox lines for a single conversation/preview pair.
 * Returns an array of lines (already padded) rather than printing directly so
 * tests can assert against the rendered shape without capturing stdout.
 */
// biome-ignore lint/suspicious/noExplicitAny: conversation + message from dynamic import
export function renderConversation(conv: any, lastMsg: any): string[] {
  const name = conv.name ?? conv.id;
  const type = conv.type === 'dm' ? 'DM' : 'Group';
  const linked = conv.linkedEntity ? ` [${conv.linkedEntity}:${conv.linkedEntityId}]` : '';
  const preview = lastMsg ? truncate(lastMsg.body, 50) : '(no messages)';
  const time = lastMsg ? formatTime(lastMsg.createdAt) : '';
  const source = extractSource(lastMsg);
  const sourceTag = source !== 'agent' ? `[${source}] ` : '';

  const lines = [`  ${padRight(name, 30)} ${padRight(type, 6)}${linked}`];
  if (lastMsg) {
    lines.push(`    ${sourceTag}${time} ${lastMsg.senderId}: ${preview}`);
  }
  lines.push('');
  return lines;
}

// biome-ignore lint/suspicious/noExplicitAny: conversation + message from dynamic import
function printConversation(conv: any, lastMsg: any): void {
  for (const line of renderConversation(conv, lastMsg)) console.log(line);
}

/**
 * Build an enriched inbox entry per conversation: the conversation row, its
 * last message preview (or null), and the channel source/meta surfaced from
 * the last message's metadata. Pure — exported for tests so callers can
 * verify JSON output without touching stdout.
 */
// biome-ignore lint/suspicious/noExplicitAny: conversation + message from dynamic import
export function buildInboxEntry(conversation: any, lastMessage: any) {
  const source = extractSource(lastMessage);
  const meta = ((lastMessage?.metadata as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  return { conversation, lastMessage, source, meta };
}

async function handleInbox(agent: string | undefined, options: { json?: boolean }): Promise<void> {
  const ts = await getTaskService();
  const resolvedAgent = agent ?? (await detectSenderIdentity());
  const actor: taskServiceTypes.Actor = { actorType: 'local', actorId: resolvedAgent };
  const conversations = await ts.listConversations(actor);

  // Hydrate the last message for every conversation in one pass so JSON and
  // human renders share the same source-of-truth (and source/meta surface
  // verbatim in JSON output).
  const enriched = await Promise.all(
    conversations.map(async (conv) => {
      const messages = await ts.getMessages(conv.id, { limit: 1 });
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
      return buildInboxEntry(conv, lastMessage);
    }),
  );

  if (options.json) {
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }

  if (enriched.length === 0) {
    console.log(`No conversations for "${resolvedAgent}".`);
    return;
  }

  console.log('');
  console.log(`INBOX: ${resolvedAgent}`);
  console.log('─'.repeat(60));

  for (const entry of enriched) {
    printConversation(entry.conversation, entry.lastMessage);
  }
}

export function registerAgentInbox(parent: Command): void {
  const inbox = parent.command('inbox').description('Inbox management — list messages or watch for new ones');

  inbox
    .command('list [agent]', { isDefault: true })
    .description('List conversations with recent messages')
    .option('--json', 'Output as JSON')
    .action(async (agent: string | undefined, options: { json?: boolean }) => {
      try {
        await handleInbox(agent, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  inbox
    .command('watch')
    .description('Run inbox watcher in foreground (Ctrl+C to stop)')
    .action(async () => {
      const { checkInboxes, getInboxPollIntervalMs, startInboxWatcher, stopInboxWatcher } = await import(
        '../../lib/inbox-watcher.js'
      );

      const pollMs = getInboxPollIntervalMs();
      if (pollMs === 0) {
        console.log('Inbox watcher is disabled (GENIE_INBOX_POLL_MS=0)');
        process.exit(0);
      }

      console.log(`Inbox watcher starting (poll every ${pollMs / 1000}s)`);
      console.log('Press Ctrl+C to stop.\n');

      const initial = await checkInboxes();
      if (initial.length > 0) {
        console.log(`[inbox-watcher] Spawned team-leads for: ${initial.join(', ')}`);
      }

      const handle = startInboxWatcher({
        listTeamsWithUnreadInbox: (await import('../../lib/claude-native-teams.js')).listTeamsWithUnreadInbox,
        isTeamActive: async (teamName) => {
          const { isTeamActive } = await import('../../lib/team-auto-spawn.js');
          return isTeamActive(teamName);
        },
        isAgentAlive: async (agentName) => {
          const { isAgentAlive } = await import('../../lib/team-auto-spawn.js');
          return isAgentAlive(agentName);
        },
        ensureTeamLead: async (teamName, workingDir) => {
          const { ensureTeamLead } = await import('../../lib/team-auto-spawn.js');
          const result = await ensureTeamLead(teamName, workingDir);
          console.log(`[inbox-watcher] Spawned team-lead for "${teamName}" in ${workingDir}`);
          return result;
        },
        warn: (msg) => console.log(msg),
        // Pattern 9 — emit on silent-skip transition. Fire-and-forget; errors
        // swallowed so the poll loop never crashes on an emit glitch.
        emitDeadInbox: (payload) => {
          try {
            emitEvent('rot.inbox-watcher-spawn-loop.detected', payload as unknown as Record<string, unknown>);
          } catch {
            // best-effort
          }
        },
      });

      const shutdown = () => {
        console.log('\nStopping inbox watcher...');
        stopInboxWatcher(handle);
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await new Promise(() => {});
    });
}
