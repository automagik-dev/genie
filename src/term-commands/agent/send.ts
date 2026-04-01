/**
 * genie agent send <name> <message> — Hierarchy-enforced messaging.
 *
 * Absorbs:
 *   - `genie send` (DM) — direct message to another agent
 *   - `genie broadcast` (team) — send to all direct reports via --broadcast
 *
 * Hierarchy ACL:
 *   - Is target my manager (reports_to chain upward)? → allow
 *   - Does target report to me (reports_to = sender)? → allow
 *   - Otherwise → reject with escalation suggestion
 *   - 'cli' sender bypasses hierarchy checks
 */

import type { Command } from 'commander';
import { detectSenderIdentity } from '../msg.js';

export function registerAgentSend(parent: Command): void {
  parent
    .command('send <body>')
    .description('Send a direct message to an agent (hierarchy-enforced)')
    .option('--to <agent>', 'Recipient agent name (default: team leader)', 'team-lead')
    .option('--from <sender>', 'Sender ID (auto-detected from context)')
    .option('--team <name>', 'Explicit team context for sender/recipient resolution')
    .option('--broadcast', 'Send to all direct reports')
    .action(async (body: string, options: { to: string; from?: string; team?: string; broadcast?: boolean }) => {
      try {
        const from = options.from ?? (await detectSenderIdentity(options.team));

        if (options.broadcast) {
          await handleBroadcast(from, body, options.team);
          return;
        }

        await handleDirectMessage(from, options.to, body, options.team);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}

// ============================================================================
// Hierarchy ACL
// ============================================================================

/** Check if an agent name matches the team's leader (by resolved name). */
async function isTeamLeader(agentName: string, teamName: string): Promise<boolean> {
  try {
    const { resolveLeaderName } = await import('../../lib/team-manager.js');
    const leaderName = await resolveLeaderName(teamName);
    return agentName === leaderName;
  } catch {
    return false;
  }
}

/**
 * Check hierarchy: sender can reach recipient if:
 * 1. sender is 'cli' (bypass)
 * 2. recipient reports_to sender (direct report)
 * 3. sender reports_to recipient (manager)
 * 4. they share the same manager (siblings — allowed for team coordination)
 */
async function checkHierarchy(from: string, to: string): Promise<{ allowed: boolean; reason?: string }> {
  if (from === 'cli') return { allowed: true };
  if (from === to) return { allowed: true };

  try {
    const registry = await import('../../lib/agent-registry.js');
    const agents = await registry.listAgents({});

    const sender = agents.find((a) => a.customName === from || a.role === from || a.id === from);
    const recipient = agents.find((a) => a.customName === to || a.role === to || a.id === to);

    // If either isn't in the registry, allow (might be external or unregistered)
    if (!sender || !recipient) return { allowed: true };

    // Direct report: recipient reports to sender
    if (recipient.reportsTo === from || recipient.reportsTo === sender.id) return { allowed: true };

    // Manager: sender reports to recipient
    if (sender.reportsTo === to || sender.reportsTo === recipient.id) return { allowed: true };

    // Siblings: same manager
    if (sender.reportsTo && sender.reportsTo === recipient.reportsTo) return { allowed: true };

    // Leader can reach anyone in their team
    if (sender.team && sender.team === recipient.team && (await isTeamLeader(from, sender.team))) {
      return { allowed: true };
    }

    const manager = sender.reportsTo ?? 'your manager';
    return {
      allowed: false,
      reason: `Cannot reach "${to}". Escalate to ${manager}.`,
    };
  } catch {
    // If registry is unavailable, allow (best-effort hierarchy)
    return { allowed: true };
  }
}

// ============================================================================
// Direct Message
// ============================================================================

async function handleDirectMessage(from: string, to: string, body: string, team?: string): Promise<void> {
  // Hierarchy check
  const { allowed, reason } = await checkHierarchy(from, to);
  if (!allowed) {
    console.error(`Error: ${reason}`);
    process.exit(1);
  }

  // Scope check (team boundary)
  const { checkSendScope } = await import('../msg.js');
  const repoPath = process.cwd();
  const scopeError = await checkSendScope(repoPath, from, to);
  if (scopeError) {
    console.error(`Error: ${scopeError}`);
    process.exit(1);
  }

  // Send via PG conversation + mailbox
  const taskService = await import('../../lib/task-service.js');
  const mailbox = await import('../../lib/mailbox.js');

  const senderActor = { actorType: 'local' as const, actorId: from };
  const recipientActor = { actorType: 'local' as const, actorId: to };

  const conv = await taskService.findOrCreateConversation({
    type: 'dm',
    members: [senderActor, recipientActor],
    createdBy: senderActor,
  });

  await taskService.addMember(conv.id, senderActor);
  await taskService.addMember(conv.id, recipientActor);

  await mailbox.send(repoPath, from, to, body);
  const msg = await taskService.sendMessage(conv.id, senderActor, body);

  // Runtime event for observability
  try {
    const { publishSubjectEvent } = await import('../../lib/runtime-events.js');
    await publishSubjectEvent(repoPath, `genie.msg.${to}`, {
      kind: 'message',
      agent: from,
      direction: 'out',
      peer: to,
      text: body,
      data: { messageId: msg.id, conversationId: conv.id, from, to },
      source: 'mailbox',
    });
  } catch {
    // Silent degradation
  }

  // Native inbox bridge (best-effort)
  try {
    const nativeTeams = await import('../../lib/claude-native-teams.js');
    const nativeMsg = {
      from,
      text: body,
      summary: body.length > 50 ? `${body.substring(0, 50)}...` : body,
      timestamp: new Date().toISOString(),
      color: 'blue' as const,
      read: false as const,
    };

    const currentTeam = team ?? process.env.GENIE_TEAM;
    if (currentTeam) {
      const nativeName = await nativeTeams.resolveNativeMemberName(currentTeam, to);
      if (nativeName) await nativeTeams.writeNativeInbox(currentTeam, nativeName, nativeMsg);
    }
  } catch {
    // Silent degradation
  }

  console.log(`Message sent to "${to}".`);
  console.log(`  ID: ${msg.id}`);
  console.log(`  Conversation: ${conv.id}`);
}

// ============================================================================
// Broadcast (--broadcast)
// ============================================================================

async function handleBroadcast(from: string, body: string, team?: string): Promise<void> {
  const taskService = await import('../../lib/task-service.js');
  const repoPath = process.cwd();

  const teamName = team ?? process.env.GENIE_TEAM;
  if (!teamName) {
    console.error('Error: Could not detect team. Use --team <name>.');
    process.exit(1);
  }

  const senderActor = { actorType: 'local' as const, actorId: from };

  const conv = await taskService.findOrCreateConversation({
    type: 'group',
    name: `Team: ${teamName}`,
    linkedEntity: 'team',
    linkedEntityId: teamName,
    createdBy: senderActor,
    members: [senderActor],
  });

  await taskService.addMember(conv.id, senderActor);
  const msg = await taskService.sendMessage(conv.id, senderActor, body);

  // Runtime event
  try {
    const { publishSubjectEvent } = await import('../../lib/runtime-events.js');
    await publishSubjectEvent(repoPath, 'genie.msg.broadcast', {
      kind: 'message',
      agent: from,
      direction: 'out',
      peer: teamName,
      text: body,
      data: { messageId: msg.id, conversationId: conv.id, from, team: teamName },
      source: 'mailbox',
    });
  } catch {
    // Silent degradation
  }

  console.log(`Broadcast sent to team "${teamName}".`);
  console.log(`  Message ID: ${msg.id}`);
  console.log(`  Conversation: ${conv.id}`);
}
