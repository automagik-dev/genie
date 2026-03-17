/**
 * Send / Inbox / Broadcast / Chat — Messaging commands between agents.
 *
 * Commands:
 *   genie send '<msg>' --to <name>                    — Direct message (directory-first resolution)
 *   genie broadcast '<msg>'                            — Leader sends to all team members (one-way)
 *   genie inbox [<name>] [--unread]                    — View message inbox
 *   genie chat '<msg>' [--team <name>]                 — Post to team chat channel
 *   genie chat read [--team <name>] [--since <ts>]     — Read team chat channel
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import type * as registryTypes from '../lib/agent-registry.js';
import type * as protocolRouterTypes from '../lib/protocol-router.js';
import type * as teamChatTypes from '../lib/team-chat.js';
import type * as teamManagerTypes from '../lib/team-manager.js';

export interface MsgCommandTestDeps {
  registry?: Pick<typeof registryTypes, 'findByPane'>;
  protocolRouter?: Pick<typeof protocolRouterTypes, 'sendMessage' | 'getInbox'>;
  teamManager?: Pick<typeof teamManagerTypes, 'listTeams'>;
  teamChat?: Pick<typeof teamChatTypes, 'postMessage' | 'readMessages'>;
}

let testDeps: Partial<MsgCommandTestDeps> = {};

export function __setMsgCommandTestDeps(deps: Partial<MsgCommandTestDeps>): void {
  testDeps = { ...testDeps, ...deps };
}

export function __resetMsgCommandTestDeps(): void {
  testDeps = {};
  _registry = undefined;
  _protocolRouter = undefined;
  _teamManager = undefined;
  _teamChat = undefined;
}

// ============================================================================
// Lazy Loaders (avoid pulling heavy deps at module-evaluation time)
// ============================================================================

let _registry: typeof registryTypes | undefined;
async function getRegistry(): Promise<typeof registryTypes> {
  if (testDeps.registry) return testDeps.registry as typeof registryTypes;
  if (!_registry) _registry = await import('../lib/agent-registry.js');
  return _registry;
}

let _protocolRouter: typeof protocolRouterTypes | undefined;
async function getProtocolRouter(): Promise<typeof protocolRouterTypes> {
  if (testDeps.protocolRouter) return testDeps.protocolRouter as typeof protocolRouterTypes;
  if (!_protocolRouter) _protocolRouter = await import('../lib/protocol-router.js');
  return _protocolRouter;
}

let _teamManager: typeof teamManagerTypes | undefined;
async function getTeamManager(): Promise<typeof teamManagerTypes> {
  if (testDeps.teamManager) return testDeps.teamManager as typeof teamManagerTypes;
  if (!_teamManager) _teamManager = await import('../lib/team-manager.js');
  return _teamManager;
}

let _teamChat: typeof teamChatTypes | undefined;
async function getTeamChat(): Promise<typeof teamChatTypes> {
  if (testDeps.teamChat) return testDeps.teamChat as typeof teamChatTypes;
  if (!_teamChat) _teamChat = await import('../lib/team-chat.js');
  return _teamChat;
}

// ============================================================================
// Sender Identity Detection
// ============================================================================

/**
 * Auto-detect the sender identity based on execution context.
 *
 * Detection cascade:
 *   1. GENIE_AGENT_NAME env var (explicit override)
 *   2. TMUX_PANE → worker registry (findByPane) → role or id
 *   3. TMUX_PANE → native team config members (match tmuxPaneId) → name
 *   4. Fallback: 'cli'
 */
export async function detectSenderIdentity(teamName?: string): Promise<string> {
  const envName = process.env.GENIE_AGENT_NAME;
  if (envName) return envName;

  const paneId = process.env.TMUX_PANE;
  if (!paneId) return 'cli';

  const registry = await getRegistry();
  // Guard against Bun's flaky module resolution where dynamic import()
  // occasionally returns a partial module object missing some exports.
  const worker = typeof registry.findByPane === 'function' ? await registry.findByPane(paneId) : null;
  if (worker) return worker.role ?? worker.id;

  const resolvedTeam = teamName ?? process.env.GENIE_TEAM;
  if (resolvedTeam) {
    const memberName = await findMemberByPane(resolvedTeam, paneId);
    if (memberName) return memberName;
  }

  return 'cli';
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

// ============================================================================
// Scope Checking
// ============================================================================

/**
 * Resolve the sender's session name for session-scoped messaging.
 *
 * Resolution order:
 * 1. GENIE_SESSION env var (set by session.ts on every tmux window)
 * 2. Registry lookup by TMUX_PANE → agent.session
 * 3. null (no session scoping)
 */
async function resolveSenderSession(): Promise<string | null> {
  if (process.env.GENIE_SESSION) return process.env.GENIE_SESSION;

  const paneId = process.env.TMUX_PANE;
  if (paneId) {
    const registry = await getRegistry();
    const worker = typeof registry.findByPane === 'function' ? await registry.findByPane(paneId) : null;
    if (worker?.session) return worker.session;
  }

  return null;
}

/**
 * Enforce team scope.
 * Returns an error message if scope is violated, null if OK.
 */
export async function checkSendScope(_repoPath: string, sender: string, recipient: string): Promise<string | null> {
  if (sender === 'cli') return null;

  const teamManager = await getTeamManager();
  const teams = await teamManager.listTeams();

  // Find teams where sender is a member
  let senderTeams = teams.filter((t) => t.members.includes(sender));

  // team-lead belongs to the team indicated by GENIE_TEAM
  if (sender === 'team-lead') {
    const envTeam = process.env.GENIE_TEAM;
    if (envTeam) {
      const leaderTeam = teams.find((t) => t.name === envTeam);
      if (leaderTeam && !senderTeams.some((t) => t.name === leaderTeam.name)) {
        senderTeams = [...senderTeams, leaderTeam];
      }
    }
  }

  // Not in any team → no scope restriction
  if (senderTeams.length === 0) return null;

  // Recipient is valid if they're in any of sender's teams (as member or team-lead)
  for (const team of senderTeams) {
    if (team.members.includes(recipient) || recipient === 'team-lead') return null;
  }

  const teamNames = senderTeams.map((t) => t.name).join(', ');
  return `Scope violation: "${recipient}" is not in sender's team(s): ${teamNames}`;
}

/**
 * Find the team for a given agent (for broadcast and chat auto-detection).
 */
async function findAgentTeam(_repoPath: string, agentName: string): Promise<teamManagerTypes.TeamConfig | null> {
  const teamManager = await getTeamManager();
  const teams = await teamManager.listTeams();

  // Check membership
  const memberTeam = teams.find((t) => t.members.includes(agentName));
  if (memberTeam) return memberTeam;

  // team-lead uses GENIE_TEAM env
  if (agentName === 'team-lead') {
    const envTeam = process.env.GENIE_TEAM;
    if (envTeam) return teams.find((t) => t.name === envTeam) ?? null;
  }

  return null;
}

// ============================================================================
// Display Helpers
// ============================================================================

function printInbox(
  worker: string,
  messages: Awaited<ReturnType<typeof protocolRouterTypes.getInbox>>,
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

function printChatMessages(teamName: string, messages: teamChatTypes.ChatMessage[]): void {
  if (messages.length === 0) {
    console.log(`No messages in "${teamName}" channel.`);
    return;
  }

  console.log('');
  console.log(`CHAT: ${teamName}`);
  console.log('-'.repeat(60));

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    console.log(`  [${time}] ${msg.sender}: ${msg.body}`);
  }
  console.log('');
}

/** Resolve team name from explicit option, agent lookup, or env var. Exits on failure. */
async function resolveTeamName(explicit: string | undefined, repoPath: string, from: string): Promise<string> {
  if (explicit) return explicit;
  const team = await findAgentTeam(repoPath, from);
  const name = team?.name ?? process.env.GENIE_TEAM;
  if (!name) {
    console.error('Error: Could not auto-detect team. Use --team <name>.');
    process.exit(1);
  }
  return name;
}

// ============================================================================
// Command Registration
// ============================================================================

export function registerSendInboxCommands(program: Command): void {
  // ── genie send ──
  program
    .command('send <body>')
    .description('Send a message to an agent')
    .option('--to <agent>', 'Recipient agent name (default: team-lead)', 'team-lead')
    .option('--from <sender>', 'Sender ID (auto-detected from context)')
    .action(async (body: string, options: { to: string; from?: string }) => {
      try {
        const protocolRouter = await getProtocolRouter();
        const repoPath = process.cwd();
        const from = options.from ?? (await detectSenderIdentity());
        const senderSession = await resolveSenderSession();

        // Scope check: sender in a team → recipient must be in same team
        const scopeError = await checkSendScope(repoPath, from, options.to);
        if (scopeError) {
          console.error(`Error: ${scopeError}`);
          process.exit(1);
        }

        const result = await protocolRouter.sendMessage(
          repoPath,
          from,
          options.to,
          body,
          undefined,
          senderSession ?? undefined,
        );

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

  // ── genie broadcast ──
  program
    .command('broadcast <body>')
    .description('Send a message to all members of your team (one-way)')
    .option('--from <sender>', 'Sender ID (auto-detected from context)')
    .action(async (body: string, options: { from?: string }) => {
      try {
        const protocolRouter = await getProtocolRouter();
        const repoPath = process.cwd();
        const from = options.from ?? (await detectSenderIdentity());
        const senderSession = await resolveSenderSession();

        const team = await findAgentTeam(repoPath, from);
        if (!team) {
          console.error(`Error: Could not find team for sender "${from}".`);
          process.exit(1);
        }

        const recipients = team.members.filter((m) => m !== from);
        if (recipients.length === 0) {
          console.log('No team members to broadcast to.');
          return;
        }

        let delivered = 0;
        let failed = 0;

        for (const recipient of recipients) {
          const result = await protocolRouter.sendMessage(
            repoPath,
            from,
            recipient,
            body,
            undefined,
            senderSession ?? undefined,
          );
          if (result.delivered) {
            delivered++;
          } else {
            failed++;
            console.error(`  Failed to deliver to "${recipient}": ${result.reason}`);
          }
        }

        console.log(`Broadcast complete: ${delivered} delivered, ${failed} failed (${recipients.length} total).`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // ── genie inbox ──
  program
    .command('inbox [agent]')
    .description('View message inbox for an agent (auto-detected if omitted)')
    .option('--json', 'Output as JSON')
    .option('--unread', 'Show only unread messages')
    .action(async (agent: string | undefined, options: { json?: boolean; unread?: boolean }) => {
      try {
        const protocolRouter = await getProtocolRouter();
        const repoPath = process.cwd();
        const resolvedAgent = agent ?? (await detectSenderIdentity());

        let messages = await protocolRouter.getInbox(repoPath, resolvedAgent);

        if (options.unread) {
          messages = messages.filter((m) => !m.read);
        }

        if (options.json) {
          console.log(JSON.stringify(messages, null, 2));
          return;
        }

        printInbox(resolvedAgent, messages, options.unread);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // ── genie chat ──
  program
    .command('chat [args...]')
    .description('Team chat: "genie chat <msg>" to post, "genie chat read" to read history')
    .option('--team <name>', 'Team name (auto-detected from context)')
    .option('--since <timestamp>', 'Show messages since timestamp (read mode)')
    .option('--json', 'Output as JSON')
    .option('--from <sender>', 'Sender ID (auto-detected from context)')
    .action(async (args: string[], options: { team?: string; since?: string; json?: boolean; from?: string }) => {
      try {
        const repoPath = process.cwd();
        const from = options.from ?? (await detectSenderIdentity());
        const teamName = await resolveTeamName(options.team, repoPath, from);

        const teamChat = await getTeamChat();

        if (args.length === 0 || args[0] === 'read') {
          const messages = await teamChat.readMessages(repoPath, teamName, options.since);
          if (options.json) {
            console.log(JSON.stringify(messages, null, 2));
            return;
          }
          printChatMessages(teamName, messages);
        } else {
          const body = args.join(' ');
          const msg = await teamChat.postMessage(repoPath, teamName, from, body);
          console.log(`Posted to "${teamName}" channel.`);
          console.log(`  ID: ${msg.id}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
