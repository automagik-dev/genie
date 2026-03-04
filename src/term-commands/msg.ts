/**
 * Message Namespace — Mailbox-first messaging between workers.
 *
 * Commands:
 *   genie msg send --to <worker> <body>
 *   genie msg inbox <worker>
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import * as protocolRouter from '../lib/protocol-router.js';
import * as registry from '../lib/worker-registry.js';

/**
 * Auto-detect the sender identity based on execution context.
 *
 * Detection cascade:
 *   1. GENIE_AGENT_NAME env var (explicit override)
 *   2. TMUX_PANE → worker registry (findByPane) → role or id
 *   3. TMUX_PANE → native team config members (match tmuxPaneId) → name
 *   4. Fallback: 'cli'
 */
async function detectSenderIdentity(teamName: string): Promise<string> {
  const envName = process.env.GENIE_AGENT_NAME;
  if (envName) return envName;

  const paneId = process.env.TMUX_PANE;
  if (!paneId) return 'cli';

  const worker = await registry.findByPane(paneId);
  if (worker) return worker.role ?? worker.id;

  return (await findMemberByPane(teamName, paneId)) ?? 'cli';
}

/** Look up a pane ID in the native team config and return the member name. */
async function findMemberByPane(teamName: string, paneId: string): Promise<string | null> {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const sanitized = teamName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  const cfgPath = join(configDir, 'teams', sanitized, 'config.json');
  try {
    const raw = await readFile(cfgPath, 'utf-8');
    const config = JSON.parse(raw);
    const members: { tmuxPaneId?: string; name: string }[] = config.members ?? [];
    const match = members.find((m) => m.tmuxPaneId === paneId);
    return match?.name ?? null;
  } catch {
    return null;
  }
}

function printInbox(
  worker: string,
  messages: Awaited<ReturnType<typeof protocolRouter.getInbox>>,
  unread?: boolean,
): void {
  if (messages.length === 0) {
    console.log(`No ${unread ? 'unread ' : ''}messages for "${worker}".`);
    return;
  }

  console.log('');
  console.log(`INBOX: ${worker}`);
  console.log('-'.repeat(60));

  for (const msg of messages) {
    const status = msg.read ? 'read' : 'UNREAD';
    const delivered = msg.deliveredAt ? 'delivered' : 'pending';
    const time = new Date(msg.createdAt).toLocaleTimeString();
    console.log(`  [${status}] [${delivered}] ${time} from=${msg.from}`);
    console.log(`    ${msg.body}`);
    console.log('');
  }
}

export function registerMsgNamespace(program: Command): void {
  const msg = program.command('msg').description('Mailbox-first messaging between workers');

  // msg send
  msg
    .command('send <body>')
    .description('Send a message to a worker')
    .option('--to <worker>', 'Recipient worker ID (default: team-lead)', 'team-lead')
    .option('--from <sender>', 'Sender ID (auto-detected from context)')
    .option('--team <team>', 'Team name (default: genie)', 'genie')
    .action(async (body: string, options: { to: string; from?: string; team: string }) => {
      try {
        const repoPath = process.cwd();
        const from = options.from ?? (await detectSenderIdentity(options.team));
        const result = await protocolRouter.sendMessage(repoPath, from, options.to, body, options.team);

        if (result.delivered) {
          console.log(`Message sent to "${result.workerId}".`);
          console.log(`  ID: ${result.messageId}`);
        } else {
          console.error(`Failed to send: ${result.reason}`);
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // msg inbox
  msg
    .command('inbox <worker>')
    .description('View message inbox for a worker')
    .option('--json', 'Output as JSON')
    .option('--unread', 'Show only unread messages')
    .action(async (worker: string, options: { json?: boolean; unread?: boolean }) => {
      try {
        const repoPath = process.cwd();
        let messages = await protocolRouter.getInbox(repoPath, worker);

        if (options.unread) {
          messages = messages.filter((m) => !m.read);
        }

        if (options.json) {
          console.log(JSON.stringify(messages, null, 2));
          return;
        }

        printInbox(worker, messages, options.unread);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
