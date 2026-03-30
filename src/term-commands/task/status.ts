/**
 * genie task status <slug> — Show wish state overview.
 * Absorbed from top-level `genie status` in state.ts.
 */

import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { formatTimestamp, padRight } from '../../lib/term-format.js';
import * as wishState from '../../lib/wish-state.js';
import { parseWishGroups } from '../dispatch.js';
import { resolveWishPath } from '../state.js';

const STATUS_ICONS: Record<string, string> = {
  blocked: '🔒',
  ready: '🟢',
  in_progress: '🔄',
  done: '✅',
};

async function loadExecutorInfo() {
  const [registryMod, executorMod, assignmentMod] = await Promise.all([
    import('../../lib/agent-registry.js'),
    import('../../lib/executor-registry.js'),
    import('../../lib/assignment-registry.js'),
  ]);
  return { registry: registryMod, executorRegistry: executorMod, assignmentRegistry: assignmentMod };
}

async function printActiveExecutors(slug: string): Promise<void> {
  try {
    const { registry, executorRegistry, assignmentRegistry } = await loadExecutorInfo();
    const agents = await registry.listAgents({ team: process.env.GENIE_TEAM });
    const executorInfoLines: string[] = [];

    for (const agent of agents) {
      if (!agent.currentExecutorId) continue;
      const executor = await executorRegistry.getExecutor(agent.currentExecutorId);
      if (!executor || executor.state === 'terminated' || executor.state === 'done') continue;

      const assignment = await assignmentRegistry.getActiveAssignment(executor.id);
      const taskLabel =
        assignment?.wishSlug === slug ? `Group ${assignment.groupNumber ?? '?'}` : (assignment?.wishSlug ?? '-');
      const agentName = agent.customName ?? agent.role ?? agent.id.slice(0, 12);
      executorInfoLines.push(
        `  Agent: ${padRight(agentName, 16)} | Executor: ${executor.id.slice(0, 12)} (${executor.provider}) | State: ${padRight(executor.state, 10)} | Task: ${taskLabel}`,
      );
    }

    if (executorInfoLines.length > 0) {
      console.log('\nActive Executors:');
      console.log('─'.repeat(60));
      for (const line of executorInfoLines) {
        console.log(line);
      }
    }
  } catch {
    // Executor info is best-effort
  }
}

async function statusCommand(slug: string): Promise<void> {
  let state = await wishState.getState(slug);
  if (!state) {
    const wishPath = resolveWishPath(slug);
    if (!wishPath) {
      console.error(`❌ No state found for wish "${slug}" and no WISH.md found in cwd or repo root`);
      console.error(`   Create it first: genie wish <agent> ${slug}`);
      process.exit(1);
    }
    const content = await readFile(wishPath, 'utf-8');
    const groups = parseWishGroups(content);
    if (groups.length === 0) {
      console.error(`❌ No execution groups found in ${wishPath}`);
      process.exit(1);
    }
    state = await wishState.createState(slug, groups);
    console.log(`📝 Auto-initialized state for wish "${slug}" (${groups.length} groups)`);
  }

  console.log(`\nWish: ${state.wish}`);
  console.log('─'.repeat(60));

  const entries = Object.entries(state.groups);
  const maxNameLen = Math.max(...entries.map(([name]) => name.length), 5);

  console.log(`  ${padRight('GROUP', maxNameLen)}  STATUS        ASSIGNEE      STARTED        COMPLETED`);
  console.log(`  ${'─'.repeat(maxNameLen + 62)}`);

  for (const [name, group] of entries) {
    const icon = STATUS_ICONS[group.status] ?? '❓';
    const status = padRight(`${icon} ${group.status}`, 13);
    const assignee = padRight(group.assignee ?? '-', 13);
    const started = padRight(formatTimestamp(group.startedAt) || '-', 14);
    const completed = formatTimestamp(group.completedAt) || '-';

    console.log(`  ${padRight(name, maxNameLen)}  ${status} ${assignee} ${started} ${completed}`);
  }

  const total = entries.length;
  const done = entries.filter(([, g]) => g.status === 'done').length;
  const inProgress = entries.filter(([, g]) => g.status === 'in_progress').length;
  const ready = entries.filter(([, g]) => g.status === 'ready').length;
  const blocked = entries.filter(([, g]) => g.status === 'blocked').length;

  console.log('');
  console.log(`  Progress: ${done}/${total} done | ${inProgress} in progress | ${ready} ready | ${blocked} blocked`);

  await printActiveExecutors(slug);

  console.log('');
}

export function registerTaskStatus(parent: Command): void {
  parent
    .command('status <slug>')
    .description('Show wish state overview for all groups')
    .action(async (slug: string) => {
      try {
        await statusCommand(slug);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ ${message}`);
        process.exit(1);
      }
    });
}
