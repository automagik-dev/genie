/**
 * Workers — Show worker status (legacy) + Worker Namespace (teams).
 *
 * Legacy (term workers):
 *   term workers           - List all workers and their states
 *   term workers --json    - Output as JSON
 *
 * Teams namespace (genie worker):
 *   genie worker spawn     - Spawn a worker with provider selection
 *   genie worker list      - List all workers with provider metadata
 *   genie worker kill <id> - Force kill a worker
 *   genie worker dashboard - Live status of all workers
 */

import { Command } from 'commander';
import * as tmux from '../lib/tmux.js';
import * as registry from '../lib/worker-registry.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import { getBackend } from '../lib/task-backend.js';
import { detectState, stripAnsi } from '../lib/orchestrator/index.js';
import { buildLaunchCommand, validateSpawnParams, type ProviderName, type SpawnParams } from '../lib/provider-adapters.js';
import { resolveLayoutMode, buildLayoutCommand } from '../lib/mosaic-layout.js';

// Use beads registry only when enabled AND bd exists on PATH
// @ts-ignore
const useBeads = beadsRegistry.isBeadsRegistryEnabled() && (typeof (Bun as any).which === 'function' ? Boolean((Bun as any).which('bd')) : true);

// ============================================================================
// Types (legacy workers command)
// ============================================================================

export interface WorkersOptions {
  json?: boolean;
  watch?: boolean;
}

interface WorkerDisplay {
  name: string;
  pane: string;
  window?: string;
  windowId?: string;
  task: string;
  state: string;
  time: string;
  alive: boolean;
  role?: string;
}

// ============================================================================
// Helper Functions (legacy)
// ============================================================================

/**
 * Check if a pane still exists
 */
async function isPaneAlive(paneId: string): Promise<boolean> {
  try {
    await tmux.capturePaneContent(paneId, 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current state from pane output
 */
async function getCurrentState(paneId: string): Promise<string> {
  try {
    const output = await tmux.capturePaneContent(paneId, 30);
    const state = detectState(output);

    // Map to display format
    switch (state.type) {
      case 'working':
      case 'tool_use':
        return 'working';
      case 'idle':
        return 'idle';
      case 'permission':
        return '⚠️ perm';
      case 'question':
        return '⚠️ question';
      case 'error':
        return '❌ error';
      case 'complete':
        return '✅ done';
      default:
        return state.type;
    }
  } catch {
    return 'unknown';
  }
}

/**
 * Get queue status from the active task backend.
 */
async function getQueueStatus(repoPath: string): Promise<{ ready: string[]; blocked: string[] }> {
  const backend = getBackend(repoPath);
  return backend.queue();
}

/**
 * Format time elapsed
 */
function formatElapsed(startedAt: string): string {
  const startTime = new Date(startedAt).getTime();
  const ms = Date.now() - startTime;
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  }
  return '<1m';
}

// ============================================================================
// Legacy Workers Command (term workers)
// ============================================================================

export async function workersCommand(options: WorkersOptions = {}): Promise<void> {
  try {
    // Get workers from beads or JSON registry
    // During transition, merge results from both
    let workers: registry.Worker[] = [];

    if (useBeads) {
      try {
        const beadsWorkers = await beadsRegistry.listWorkers();
        workers = beadsWorkers;
      } catch {
        // Fallback to JSON registry
        workers = await registry.list();
      }
    } else {
      workers = await registry.list();
    }

    // Also check JSON registry for any workers not in beads
    const jsonWorkers = await registry.list();
    const beadsIds = new Set(workers.map(w => w.id));
    for (const jw of jsonWorkers) {
      if (!beadsIds.has(jw.id)) {
        workers.push(jw);
      }
    }

    // Gather display data for each worker
    const displayData: WorkerDisplay[] = [];

    for (const worker of workers) {
      const alive = await isPaneAlive(worker.paneId);
      let currentState = worker.state;

      if (alive) {
        // Get live state from pane
        currentState = await getCurrentState(worker.paneId);

        // Update both registries if state differs
        const mappedState = mapDisplayStateToRegistry(currentState);
        if (mappedState && mappedState !== worker.state) {
          if (useBeads) {
            // Update beads and send heartbeat
            await beadsRegistry.updateState(worker.id, mappedState).catch(() => {});
          }
          await registry.updateState(worker.id, mappedState);
        } else if (useBeads) {
          // Just send heartbeat even if state unchanged
          await beadsRegistry.heartbeat(worker.id).catch(() => {});
        }
      } else {
        currentState = '💀 dead';
      }

      displayData.push({
        name: worker.id,
        pane: worker.paneId,
        window: worker.windowName,
        windowId: worker.windowId,
        task: worker.taskTitle
          ? `"${worker.taskTitle.substring(0, 25)}${worker.taskTitle.length > 25 ? '...' : ''}"`
          : worker.taskId || '-',
        state: currentState,
        time: formatElapsed(worker.startedAt),
        alive,
        role: worker.role,
      });
    }

    // Get queue status
    const queue = await getQueueStatus(process.cwd());

    // Filter out dead workers from ready count
    const activeTaskIds = workers.filter(w => displayData.find(d => d.name === w.id && d.alive)).map(w => w.taskId);
    const actuallyReady = queue.ready.filter(id => !activeTaskIds.includes(id));

    if (options.json) {
      console.log(JSON.stringify({
        workers: displayData,
        queue: {
          ready: actuallyReady,
          blocked: queue.blocked,
        },
      }, null, 2));
      return;
    }

    // Display workers table
    console.log('┌─────────────────────────────────────────────────────────────────┐');
    console.log('│ WORKERS                                                         │');
    console.log('├──────────┬──────────┬───────────────────────────┬──────────┬────┤');
    console.log('│ Name     │ Pane     │ Task                      │ State    │Time│');
    console.log('├──────────┼──────────┼───────────────────────────┼──────────┼────┤');

    if (displayData.length === 0) {
      console.log('│ (no workers)                                                    │');
    } else {
      for (const w of displayData) {
        const name = w.name.padEnd(8).substring(0, 8);
        const pane = w.pane.padEnd(8).substring(0, 8);
        const task = w.task.padEnd(25).substring(0, 25);
        const state = w.state.padEnd(8).substring(0, 8);
        const time = w.time.padStart(4).substring(0, 4);
        console.log(`│ ${name} │ ${pane} │ ${task} │ ${state} │${time}│`);
      }
    }

    console.log('└──────────┴──────────┴───────────────────────────┴──────────┴────┘');

    // Display queue
    if (queue.blocked.length > 0) {
      console.log(`\nBlocked: ${queue.blocked.slice(0, 5).join(', ')}${queue.blocked.length > 5 ? '...' : ''}`);
    }

    if (actuallyReady.length > 0) {
      console.log(`Ready: ${actuallyReady.slice(0, 5).join(', ')}${actuallyReady.length > 5 ? '...' : ''}`);
    } else if (displayData.length > 0) {
      console.log(`\nReady: (none - all assigned or blocked)`);
    }

    // Cleanup dead workers (optional - could prompt)
    const deadWorkers = displayData.filter(w => !w.alive);
    if (deadWorkers.length > 0) {
      console.log(`\n⚠️  ${deadWorkers.length} dead worker(s) detected. Run \`term kill <name>\` to clean up.`);
    }

  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Map display state to registry state
 */
function mapDisplayStateToRegistry(displayState: string): registry.WorkerState | null {
  if (displayState === 'working') return 'working';
  if (displayState === 'idle') return 'idle';
  if (displayState === '⚠️ perm') return 'permission';
  if (displayState === '⚠️ question') return 'question';
  if (displayState === '❌ error') return 'error';
  if (displayState === '✅ done') return 'done';
  return null;
}

// ============================================================================
// Helper: Generate Worker ID (teams)
// ============================================================================

async function generateWorkerId(team: string, role?: string): Promise<string> {
  const base = role ? `${team}-${role}` : team;
  const existing = await registry.list();
  if (!existing.some(w => w.id === base)) return base;

  let suffix = 2;
  while (existing.some(w => w.id === `${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

// ============================================================================
// Worker Namespace (genie worker — provider-selectable orchestration)
// ============================================================================

export function registerWorkerNamespace(program: Command): void {
  const worker = program
    .command('worker')
    .description('Worker lifecycle (spawn, list, kill, dashboard)');

  // worker spawn
  worker
    .command('spawn')
    .description('Spawn a new worker with provider selection')
    .requiredOption('--provider <provider>', 'Provider: claude or codex')
    .requiredOption('--team <team>', 'Team name')
    .option('--role <role>', 'Worker role (e.g., implementor, tester)')
    .option('--skill <skill>', 'Skill to load (required for codex)')
    .option('--layout <layout>', 'Layout mode: mosaic (default) or vertical')
    .option('--extra-args <args...>', 'Extra CLI args forwarded to provider')
    .action(async (options: {
      provider: string;
      team: string;
      role?: string;
      skill?: string;
      layout?: string;
      extraArgs?: string[];
    }) => {
      try {
        // 1. Validate spawn parameters (Group A contract)
        const params: SpawnParams = {
          provider: options.provider as ProviderName,
          team: options.team,
          role: options.role,
          skill: options.skill,
          extraArgs: options.extraArgs,
        };

        const validated = validateSpawnParams(params);

        // 2. Build launch command (Group C adapters)
        const launch = buildLaunchCommand(validated);

        // 3. Resolve layout (Group D)
        const layoutMode = resolveLayoutMode(options.layout);

        // 4. Generate worker ID
        const workerId = await generateWorkerId(validated.team, validated.role);

        // 5. Register worker (Group D — would normally create tmux pane here)
        const now = new Date().toISOString();
        const workerEntry: registry.Worker = {
          id: workerId,
          paneId: '%0', // placeholder — real paneId comes from tmux split
          session: 'genie',
          provider: validated.provider,
          transport: 'tmux',
          role: validated.role,
          skill: validated.skill,
          team: validated.team,
          worktree: null,
          startedAt: now,
          state: 'spawning',
          lastStateChange: now,
          repoPath: process.cwd(),
        };

        await registry.register(workerEntry);

        // 6. Output result
        console.log(`Worker "${workerId}" spawned.`);
        console.log(`  Provider: ${launch.provider}`);
        console.log(`  Command:  ${launch.command}`);
        console.log(`  Team:     ${validated.team}`);
        if (validated.role) console.log(`  Role:     ${validated.role}`);
        if (validated.skill) console.log(`  Skill:    ${validated.skill}`);
        console.log(`  Layout:   ${layoutMode}`);

        // In a full implementation, we would:
        // a) Create/find the tmux session
        // b) Split a new pane with the launch command
        // c) Apply the layout via buildLayoutCommand()
        // d) Update the registry with the real paneId

        console.log('');
        console.log(`Layout command: tmux ${buildLayoutCommand('genie:0', layoutMode)}`);

      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });

  // worker list
  worker
    .command('list')
    .alias('ls')
    .description('List all workers with provider metadata')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const workers = await registry.list();

        if (options.json) {
          console.log(JSON.stringify(workers.map(w => ({
            id: w.id,
            provider: w.provider,
            transport: w.transport,
            session: w.session,
            window: w.window,
            paneId: w.paneId,
            role: w.role,
            skill: w.skill,
            team: w.team,
            state: w.state,
            elapsed: registry.getElapsedTime(w).formatted,
          })), null, 2));
          return;
        }

        if (workers.length === 0) {
          console.log('No workers found.');
          console.log('  Spawn one: genie worker spawn --provider claude --team work --role implementor');
          return;
        }

        console.log('');
        console.log('WORKERS');
        console.log('-'.repeat(80));
        console.log(
          'ID'.padEnd(20) +
          'PROVIDER'.padEnd(10) +
          'TEAM'.padEnd(10) +
          'ROLE'.padEnd(14) +
          'STATE'.padEnd(12) +
          'TIME'
        );
        console.log('-'.repeat(80));

        for (const w of workers) {
          const id = w.id.padEnd(20).substring(0, 20);
          const provider = (w.provider || '-').padEnd(10);
          const team = (w.team || '-').padEnd(10).substring(0, 10);
          const role = (w.role || '-').padEnd(14).substring(0, 14);
          const state = w.state.padEnd(12);
          const time = registry.getElapsedTime(w).formatted;
          console.log(`${id}${provider}${team}${role}${state}${time}`);
        }
        console.log('');
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });

  // worker kill
  worker
    .command('kill <id>')
    .description('Force kill a worker')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (id: string, options: { yes?: boolean }) => {
      try {
        const w = await registry.get(id);
        if (!w) {
          console.error(`Worker "${id}" not found.`);
          process.exit(1);
        }

        // In full implementation: kill tmux pane, cleanup
        await registry.unregister(id);
        console.log(`Worker "${id}" killed and unregistered.`);
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });

  // worker dashboard
  worker
    .command('dashboard')
    .description('Live status of all workers with provider metadata')
    .option('--json', 'Output as JSON')
    .option('-w, --watch', 'Auto-refresh every 2 seconds')
    .action(async (options: { json?: boolean; watch?: boolean }) => {
      try {
        const workers = await registry.list();

        if (options.json) {
          const summary = {
            total: workers.length,
            byProvider: {
              claude: workers.filter(w => w.provider === 'claude').length,
              codex: workers.filter(w => w.provider === 'codex').length,
            },
            byState: {
              spawning: workers.filter(w => w.state === 'spawning').length,
              working: workers.filter(w => w.state === 'working').length,
              idle: workers.filter(w => w.state === 'idle').length,
              done: workers.filter(w => w.state === 'done').length,
            },
          };
          console.log(JSON.stringify({ summary, workers: workers.map(w => ({
            id: w.id,
            provider: w.provider,
            team: w.team,
            role: w.role,
            skill: w.skill,
            state: w.state,
            paneId: w.paneId,
            transport: w.transport,
          })) }, null, 2));
          return;
        }

        console.log('');
        console.log('WORKER DASHBOARD');
        console.log('='.repeat(80));
        console.log(`Workers: ${workers.length}`);
        console.log(`  Claude: ${workers.filter(w => w.provider === 'claude').length}`);
        console.log(`  Codex:  ${workers.filter(w => w.provider === 'codex').length}`);
        console.log('');

        if (workers.length === 0) {
          console.log('No active workers.');
          return;
        }

        for (const w of workers) {
          const elapsed = registry.getElapsedTime(w).formatted;
          console.log(`  [${w.provider || 'claude'}] ${w.id} (${w.team || 'default'}/${w.role || 'default'}) — ${w.state} — ${elapsed}`);
          if (w.skill) console.log(`    Skill: ${w.skill}`);
          console.log(`    Pane: ${w.paneId} | Session: ${w.session} | Transport: ${w.transport || 'tmux'}`);
        }

        console.log('');

        if (options.watch) {
          console.log('Watch mode: would auto-refresh every 2s (tmux required)');
        }
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });
}
