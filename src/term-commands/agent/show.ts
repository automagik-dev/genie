/**
 * genie agent show <name> — Show agent detail + current executor info.
 * New command replacing `session show`.
 */

import type { Command } from 'commander';
import { padRight } from '../../lib/term-format.js';

// biome-ignore lint/suspicious/noExplicitAny: agent from dynamic import
function printAgentFields(agent: any): void {
  console.log('');
  console.log(`AGENT: ${agent.customName ?? agent.role ?? agent.id}`);
  console.log('─'.repeat(60));
  console.log(`  ${padRight('ID:', 20)} ${agent.id}`);
  if (agent.role) console.log(`  ${padRight('Role:', 20)} ${agent.role}`);
  if (agent.customName) console.log(`  ${padRight('Name:', 20)} ${agent.customName}`);
  if (agent.team) console.log(`  ${padRight('Team:', 20)} ${agent.team}`);
  console.log(`  ${padRight('Started:', 20)} ${agent.startedAt}`);
}

// biome-ignore lint/suspicious/noExplicitAny: executor from dynamic import
function printExecutorFields(executor: any): void {
  console.log('');
  console.log('Current Executor:');
  console.log('─'.repeat(60));
  console.log(`  ${padRight('Executor ID:', 20)} ${executor.id}`);
  console.log(`  ${padRight('Provider:', 20)} ${executor.provider}`);
  console.log(`  ${padRight('Transport:', 20)} ${executor.transport}`);
  console.log(`  ${padRight('State:', 20)} ${executor.state}`);
  if (executor.pid) console.log(`  ${padRight('PID:', 20)} ${executor.pid}`);
  if (executor.tmuxSession) console.log(`  ${padRight('Tmux Session:', 20)} ${executor.tmuxSession}`);
  if (executor.tmuxPaneId) console.log(`  ${padRight('Tmux Pane:', 20)} ${executor.tmuxPaneId}`);
  if (executor.worktree) console.log(`  ${padRight('Worktree:', 20)} ${executor.worktree}`);
  console.log(`  ${padRight('Started:', 20)} ${executor.startedAt}`);
  if (executor.endedAt) console.log(`  ${padRight('Ended:', 20)} ${executor.endedAt}`);
}

async function showAgent(name: string, json?: boolean): Promise<void> {
  const registry = await import('../../lib/agent-registry.js');
  const executorRegistry = await import('../../lib/executor-registry.js');

  // Lookup is global (matches `genie ls` semantics) — filtering by GENIE_TEAM
  // made cross-team agents invisible when the env was set. If the name is
  // ambiguous across teams, prefer the one matching GENIE_TEAM, then any match.
  const agents = await registry.listAgents();
  const matches = agents.filter((a) => a.customName === name || a.role === name || a.id === name);
  const preferredTeam = process.env.GENIE_TEAM;
  const agent = (preferredTeam && matches.find((a) => a.team === preferredTeam)) ?? matches[0];

  if (!agent) {
    console.error(`Agent "${name}" not found.`);
    process.exit(1);
  }

  if (json) {
    const executor = agent.currentExecutorId ? await executorRegistry.getExecutor(agent.currentExecutorId) : null;
    console.log(JSON.stringify({ agent, executor }, null, 2));
    return;
  }

  printAgentFields(agent);

  if (agent.currentExecutorId) {
    const executor = await executorRegistry.getExecutor(agent.currentExecutorId);
    if (executor) printExecutorFields(executor);
  } else {
    console.log('\n  No active executor.');
  }
  console.log('');
}

export function registerAgentShow(parent: Command): void {
  parent
    .command('show <name>')
    .description('Show agent identity and current executor detail')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      try {
        await showAgent(name, options.json);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
