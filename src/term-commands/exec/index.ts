/**
 * Exec Namespace — `genie exec` debug subcommand group.
 *
 * Subcommands:
 *   list      — List all executors
 *   show <id> — Show executor detail
 *   terminate <id> — Terminate an executor
 */

import type { Command } from 'commander';
import { padRight } from '../../lib/term-format.js';

// biome-ignore lint/suspicious/noExplicitAny: executor from dynamic import
function printExecutorTable(executors: any[]): void {
  console.log('');
  console.log('EXECUTORS');
  console.log('─'.repeat(100));
  console.log(
    `  ${padRight('ID', 14)} ${padRight('AGENT', 16)} ${padRight('PROVIDER', 10)} ${padRight('STATE', 12)} ${padRight('PID', 8)} ${padRight('PANE', 8)} STARTED`,
  );
  console.log(`  ${'─'.repeat(96)}`);

  for (const e of executors) {
    console.log(
      `  ${padRight(e.id.slice(0, 12), 14)} ${padRight(e.agentId.slice(0, 14), 16)} ${padRight(e.provider, 10)} ${padRight(e.state, 12)} ${padRight(String(e.pid ?? '-'), 8)} ${padRight(e.tmuxPaneId ?? '-', 8)} ${e.startedAt}`,
    );
  }
  console.log('');
}

// biome-ignore lint/suspicious/noExplicitAny: executor from dynamic import
function printExecutorDetail(executor: any): void {
  console.log('');
  console.log(`EXECUTOR: ${executor.id}`);
  console.log('─'.repeat(60));
  console.log(`  ${padRight('Agent ID:', 20)} ${executor.agentId}`);
  console.log(`  ${padRight('Provider:', 20)} ${executor.provider}`);
  console.log(`  ${padRight('Transport:', 20)} ${executor.transport}`);
  console.log(`  ${padRight('State:', 20)} ${executor.state}`);
  if (executor.pid) console.log(`  ${padRight('PID:', 20)} ${executor.pid}`);
  if (executor.tmuxSession) console.log(`  ${padRight('Tmux Session:', 20)} ${executor.tmuxSession}`);
  if (executor.tmuxPaneId) console.log(`  ${padRight('Tmux Pane:', 20)} ${executor.tmuxPaneId}`);
  if (executor.tmuxWindow) console.log(`  ${padRight('Tmux Window:', 20)} ${executor.tmuxWindow}`);
  if (executor.claudeSessionId) console.log(`  ${padRight('Claude Session:', 20)} ${executor.claudeSessionId}`);
  if (executor.worktree) console.log(`  ${padRight('Worktree:', 20)} ${executor.worktree}`);
  if (executor.repoPath) console.log(`  ${padRight('Repo Path:', 20)} ${executor.repoPath}`);
  console.log(`  ${padRight('Started:', 20)} ${executor.startedAt}`);
  if (executor.endedAt) console.log(`  ${padRight('Ended:', 20)} ${executor.endedAt}`);
  console.log('');
}

async function listExecutors(options: { agent?: string; state?: string; json?: boolean }): Promise<void> {
  const executorRegistry = await import('../../lib/executor-registry.js');
  const agentRegistry = await import('../../lib/agent-registry.js');

  let agentId: string | undefined;
  if (options.agent) {
    const agents = await agentRegistry.listAgents({});
    const match = agents.find(
      (a) => a.customName === options.agent || a.role === options.agent || a.id === options.agent,
    );
    agentId = match?.id;
    if (!agentId) {
      console.error(`Agent "${options.agent}" not found.`);
      process.exit(1);
    }
  }

  let executors = await executorRegistry.listExecutors(agentId);
  if (options.state) {
    executors = executors.filter((e) => e.state === options.state);
  }

  if (options.json) {
    console.log(JSON.stringify(executors, null, 2));
    return;
  }

  if (executors.length === 0) {
    console.log('No executors found.');
    return;
  }

  printExecutorTable(executors);
}

export function registerExecCommands(program: Command): void {
  const exec = program.command('exec').description('Executor management (debug)');

  // exec list
  exec
    .command('list')
    .alias('ls')
    .description('List all executors')
    .option('--agent <name>', 'Filter by agent name/ID')
    .option('--state <state>', 'Filter by state (running, idle, terminated, etc.)')
    .option('--json', 'Output as JSON')
    .action(async (options: { agent?: string; state?: string; json?: boolean }) => {
      try {
        await listExecutors(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // exec show <id>
  exec
    .command('show <id>')
    .description('Show executor detail (pid, tmux, provider)')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        const executorRegistry = await import('../../lib/executor-registry.js');
        const executor = await executorRegistry.getExecutor(id);

        if (!executor) {
          console.error(`Executor "${id}" not found.`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(executor, null, 2));
          return;
        }

        printExecutorDetail(executor);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // exec terminate <id>
  exec
    .command('terminate <id>')
    .description('Terminate an executor')
    .action(async (id: string) => {
      try {
        const executorRegistry = await import('../../lib/executor-registry.js');
        const executor = await executorRegistry.getExecutor(id);

        if (!executor) {
          console.error(`Executor "${id}" not found.`);
          process.exit(1);
        }

        if (executor.state === 'terminated' || executor.state === 'done') {
          console.log(`Executor "${id}" is already ${executor.state}.`);
          return;
        }

        await executorRegistry.terminateExecutor(id);
        console.log(`Executor "${id}" terminated.`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
