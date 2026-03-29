/**
 * genie agent send <name> <message> — STUB for hierarchy-enforced messaging.
 * Full implementation in Wave 2, Group 5.
 */

import type { Command } from 'commander';

export function registerAgentSend(parent: Command): void {
  parent
    .command('send <body>')
    .description('Send a direct message to an agent (hierarchy-enforced — stub, Wave 2)')
    .option('--to <agent>', 'Recipient agent name (default: team-lead)', 'team-lead')
    .option('--from <sender>', 'Sender ID (auto-detected from context)')
    .option('--team <name>', 'Explicit team context for sender/recipient resolution')
    .option('--broadcast', 'Send to all direct reports')
    .action(async (body: string, options: { to: string; from?: string; team?: string; broadcast?: boolean }) => {
      // Temporary: delegate to existing send handler
      try {
        const taskService = await import('../../lib/task-service.js');
        const mailbox = await import('../../lib/mailbox.js');
        const { detectSenderIdentity, checkSendScope } = await import('../msg.js');

        const repoPath = process.cwd();
        const from = options.from ?? (await detectSenderIdentity(options.team));

        const scopeError = await checkSendScope(repoPath, from, options.to);
        if (scopeError) {
          console.error(`Error: ${scopeError}`);
          process.exit(1);
        }

        const senderActor = { actorType: 'local' as const, actorId: from };
        const recipientActor = { actorType: 'local' as const, actorId: options.to };

        const conv = await taskService.findOrCreateConversation({
          type: 'dm',
          members: [senderActor, recipientActor],
          createdBy: senderActor,
        });

        await taskService.addMember(conv.id, senderActor);
        await taskService.addMember(conv.id, recipientActor);

        await mailbox.send(repoPath, from, options.to, body);
        const msg = await taskService.sendMessage(conv.id, senderActor, body);

        console.log(`Message sent to "${options.to}".`);
        console.log(`  ID: ${msg.id}`);
        console.log(`  Conversation: ${conv.id}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
