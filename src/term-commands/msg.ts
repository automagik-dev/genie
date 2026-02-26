/**
 * Message Namespace — Mailbox-first messaging between workers.
 *
 * Commands:
 *   genie msg send --to <worker> <body>
 *   genie msg inbox <worker>
 */

import { Command } from 'commander';
import * as protocolRouter from '../lib/protocol-router.js';
import * as mailbox from '../lib/mailbox.js';

export function registerMsgNamespace(program: Command): void {
  const msg = program
    .command('msg')
    .description('Mailbox-first messaging between workers');

  // msg send
  msg
    .command('send <body>')
    .description('Send a message to a worker')
    .requiredOption('--to <worker>', 'Recipient worker ID')
    .option('--from <sender>', 'Sender ID (default: operator)', 'operator')
    .action(async (body: string, options: { to: string; from: string }) => {
      try {
        const repoPath = process.cwd();
        const result = await protocolRouter.sendMessage(
          repoPath,
          options.from,
          options.to,
          body,
        );

        if (result.delivered) {
          console.log(`Message sent to "${result.workerId}".`);
          console.log(`  ID: ${result.messageId}`);
        } else {
          console.error(`Failed to send: ${result.reason}`);
          process.exit(1);
        }
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
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
          messages = messages.filter(m => !m.read);
        }

        if (options.json) {
          console.log(JSON.stringify(messages, null, 2));
          return;
        }

        if (messages.length === 0) {
          console.log(`No ${options.unread ? 'unread ' : ''}messages for "${worker}".`);
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
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });
}
