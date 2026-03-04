/**
 * Worker Namespace — unified worker lifecycle commands.
 *
 * genie worker:
 *   spawn     - Spawn a worker with provider selection
 *   list      - List all workers with provider metadata
 *   kill <id> - Force kill a worker
 *   dashboard - Live status of all workers
 *   suspend   - Suspend a worker (kill pane, preserve session)
 *   watchdog  - Idle timeout watchdog
 *   approve   - Auto-approve engine management
 *   history   - Compressed session catch-up
 *   answer    - Answer worker question
 *   events    - Stream Claude Code events
 *   close     - Close task and cleanup worker
 *   ship      - Mark done, merge, cleanup
 *   read      - Read worker pane output
 *   exec      - Execute command in worker pane
 */

import type { Command } from 'commander';
import * as approveCmd from './approve.js';
import * as closeCmd from './close.js';
import * as eventsCmd from './events.js';
import * as execCmd from './exec.js';
import * as historyCmd from './history.js';
import * as orchestrateCmd from './orchestrate.js';
import * as readCmd from './read.js';
import * as shipCmd from './ship.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import * as nativeTeams from '../lib/claude-native-teams.js';
import { OTEL_RELAY_PORT, ensureCodexOtelConfig } from '../lib/codex-config.js';
import { buildLayoutCommand, resolveLayoutMode } from '../lib/mosaic-layout.js';
import { detectState } from '../lib/orchestrator/index.js';
import {
  type ClaudeTeamColor,
  type ProviderName,
  type SpawnParams,
  buildLaunchCommand,
  validateSpawnParams,
} from '../lib/provider-adapters.js';
import { getBackend } from '../lib/task-backend.js';
import * as teamManager from '../lib/team-manager.js';
import * as tmux from '../lib/tmux.js';
import { isPaneAlive } from '../lib/tmux.js';
import * as registry from '../lib/worker-registry.js';
import * as mailbox from '../lib/mailbox.js';

// Use beads registry only when enabled AND bd exists on PATH
// @ts-ignore
const useBeads =
  beadsRegistry.isBeadsRegistryEnabled() &&
  (typeof (Bun as any).which === 'function' ? Boolean((Bun as any).which('bd')) : true);

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
 * Ensure the shared OTel relay is running on OTEL_RELAY_PORT.
 *
 * A single OTLP HTTP listener handles ALL codex workers. When
 * telemetry events stop arriving (5s silence), the relay iterates
 * all registered worker pane files in ~/.genie/relay/ and captures
 * any changed panes, writing to the team-lead's native inbox.
 *
 * Idempotent — skips if the relay process is already alive.
 */
async function ensureOtelRelay(team: string): Promise<boolean> {
  const { spawn: spawnChild, execSync: execSyncLocal } = require('node:child_process');
  const { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } = require('node:fs');
  const { join } = require('node:path');
  const { homedir } = require('node:os');

  const relayDir = join(homedir(), '.genie', 'relay');
  mkdirSync(relayDir, { recursive: true });

  const pidFile = join(relayDir, 'otel-relay.pid');
  const scriptFile = join(relayDir, 'otel-relay.mjs');

  // Check if relay is already running
  if (existsSync(pidFile)) {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim());
      if (pid > 0) {
        process.kill(pid, 0); // Throws if process doesn't exist
        return true; // Already running
      }
    } catch {
      // Process dead — restart below
    }
  }

  const inboxDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'teams', team, 'inboxes');
  const escapedRelayDir = relayDir.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const escapedInboxDir = inboxDir.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const escapedPidFile = pidFile.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  try {
    // Shared OTLP HTTP listener with state detection.
    // On OTel silence, captures the pane and detects codex state:
    //   - 'idle'       → codex waiting for input (relay output)
    //   - 'permission' → codex asking for approval (relay with alert)
    //   - 'working'    → still processing (skip, false alarm)
    //   - 'finished'   → pane dead or process exited (final relay, stop)
    // Only relays on idle/permission/finished — never during work.
    // Bootstrap grace period: skip first 25s after worker registration
    // to avoid noise from codex loading skills/config and initial approvals.
    writeFileSync(
      scriptFile,
      `import { createServer } from 'http';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

const RELAY_DIR = '${escapedRelayDir}';
const INBOX_DIR = '${escapedInboxDir}';
const INBOX = join(INBOX_DIR, 'team-lead.json');
const PID_FILE = '${escapedPidFile}';
const PORT = ${OTEL_RELAY_PORT};
const SILENCE_MS = 5000;
const BOOTSTRAP_GRACE_MS = 20000; // Hard skip during first 20s after worker appears
// After grace period, wait for first idle state (= bootstrap done) before relaying.
// This avoids noise from codex reading context files and asking for permission.

let silenceTimer = null;
const lastHashes = new Map();       // workerId → content hash
const workerFirstSeen = new Map();  // workerId → timestamp (ms)
const bootstrapDone = new Set();    // Workers whose bootstrap is complete (stable idle seen)
const bootstrapIdleCount = new Map(); // workerId → consecutive idle poll count during bootstrap
const stoppedWorkers = new Set();   // Workers that finished — no more relays

// Detect codex state from pane content
function detectState(output) {
  const lines = output.split('\\n').filter(l => l.trim());
  const tail = lines.slice(-8).join('\\n');

  // Permission prompt — codex is asking for approval
  if (/Press enter to confirm or esc to cancel/.test(tail)) return 'permission';
  if (/Would you like to run/.test(tail)) return 'permission';

  // Working indicators — check BEFORE idle because the › prompt placeholder
  // is visible even while codex is actively processing
  if (/[◦◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(tail)) return 'working';  // Spinner chars
  if (/esc to interrupt/.test(tail)) return 'working';  // Active processing hint

  // Idle — codex prompt waiting for input (› at start of a line near bottom)
  // The status bar (gpt-5.3-codex...) appears below the prompt
  if (/^\\s*[>›]\\s/m.test(tail)) return 'idle';

  // Still working
  return 'working';
}

// Extract meaningful summary from codex pane output
function extractSummary(output, state) {
  const lines = output.split('\\n');

  if (state === 'permission') {
    // Find the command being requested (lines with $ or ✘ near the bottom)
    const tail = lines.slice(-15);
    // Look for the command line (starts with $ or contains the command after "Run")
    const cmdLine = tail.reverse().find(l =>
      /^\\s*\\$\\s/.test(l) || /^\\s*[•✘].*(?:Run|run|patch|write|exec)/.test(l)
    );
    if (cmdLine) {
      const cleaned = cmdLine.replace(/^\\s*\\$\\s*/, '').replace(/^\\s*[•✘]\\s*/, '').trim().slice(0, 80);
      return '[needs approval] ' + cleaned;
    }
    return '[needs approval]';
  }

  // Idle state — find the last codex response (• prefixed lines)
  // Work backwards from the idle prompt to find the response block
  const responseLines = [];
  let foundPrompt = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    // Skip empty lines, status bar, and idle prompt
    if (!line) continue;
    if (/^[>›]\\s/.test(line)) {
      if (foundPrompt) break; // Hit the user's input prompt — stop
      foundPrompt = true;
      continue;
    }
    if (/gpt-\\d|codex|left\\s*·|^Tip:/.test(line)) continue;
    // Collect response lines (• prefixed or continuation)
    if (foundPrompt || /^[•✔✘─]/.test(line)) {
      foundPrompt = true;
      responseLines.unshift(line);
      if (responseLines.length >= 3) break; // Enough for summary
    }
  }

  if (responseLines.length > 0) {
    // Clean up the • prefix for summary
    const summary = responseLines
      .map(l => l.replace(/^[•✔✘]\\s*/, '').trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 120);
    return summary || '(idle)';
  }

  return '(idle)';
}

function relayAll() {
  let paneFiles;
  try { paneFiles = readdirSync(RELAY_DIR).filter(f => f.endsWith('-pane')); }
  catch { return; }

  const now = Date.now();

  for (const file of paneFiles) {
    const workerId = file.replace(/-pane$/, '');
    if (stoppedWorkers.has(workerId)) continue;

    // Bootstrap grace period — skip relaying during first 25s
    if (!workerFirstSeen.has(workerId)) {
      // Use file mtime as registration time
      try {
        const stat = statSync(join(RELAY_DIR, file));
        workerFirstSeen.set(workerId, stat.mtimeMs);
      } catch {
        workerFirstSeen.set(workerId, now);
      }
    }
    const age = now - workerFirstSeen.get(workerId);
    if (age < BOOTSTRAP_GRACE_MS) continue;

    let paneId;
    try { paneId = readFileSync(join(RELAY_DIR, file), 'utf-8').trim(); }
    catch { continue; }
    if (!paneId || !/^%\\d+$/.test(paneId)) continue;

    let meta = { agent: workerId, color: 'blue' };
    try {
      const raw = readFileSync(join(RELAY_DIR, workerId + '-meta'), 'utf-8');
      meta = JSON.parse(raw);
    } catch {}

    let output;
    try {
      output = execSync(\`tmux capture-pane -p -t '\${paneId}' -S -80\`, { encoding: 'utf-8' }).trim();
    } catch {
      // Pane gone — final relay if we had previous content
      const lastContent = lastHashes.get(workerId + ':content');
      if (lastContent) {
        const summary = extractSummary(lastContent, 'idle');
        writeInbox(meta, lastContent, '[finished] ' + summary);
      }
      stoppedWorkers.add(workerId);
      continue;
    }
    if (!output) continue;

    // Detect state — only relay on idle or permission
    const state = detectState(output);
    if (state === 'working') continue;

    // Bootstrap detection: require 2 consecutive idle polls before marking done.
    // Permission prompts are ALWAYS relayed (they block progress).
    // Brief idle states between actions are skipped (codex shows › between tasks).
    if (!bootstrapDone.has(workerId)) {
      if (state === 'idle') {
        const count = (bootstrapIdleCount.get(workerId) || 0) + 1;
        bootstrapIdleCount.set(workerId, count);
        if (count >= 2) {
          bootstrapDone.add(workerId);
          // Fall through to relay this stable idle (bootstrap complete)
        } else {
          continue; // First idle poll — might be brief between actions
        }
      } else if (state === 'permission') {
        bootstrapIdleCount.set(workerId, 0); // Reset — codex is still working
        // Permission during bootstrap — falls through to relay
      } else {
        bootstrapIdleCount.set(workerId, 0); // Reset on working state
        continue;
      }
    }

    // Skip if content unchanged
    const hash = createHash('md5').update(output).digest('hex');
    if (lastHashes.get(workerId) === hash) continue;
    lastHashes.set(workerId, hash);
    lastHashes.set(workerId + ':content', output);

    const summary = extractSummary(output, state);
    writeInbox(meta, output, summary);
  }
}

function writeInbox(meta, text, summary) {
  mkdirSync(INBOX_DIR, { recursive: true });
  let messages = [];
  try { messages = JSON.parse(readFileSync(INBOX, 'utf-8')); } catch {}
  // Trim old read messages to prevent inbox bloat — keep only last 5 read + all unread
  const unread = messages.filter(m => !m.read);
  const read = messages.filter(m => m.read);
  messages = [...read.slice(-5), ...unread];
  messages.push({
    from: meta.agent,
    text,
    summary,
    timestamp: new Date().toISOString(),
    color: meta.color,
    read: false,
  });
  writeFileSync(INBOX, JSON.stringify(messages, null, 2));
}

// Clean up dead panes every 30s
setInterval(() => {
  let paneFiles;
  try { paneFiles = readdirSync(RELAY_DIR).filter(f => f.endsWith('-pane')); }
  catch { return; }
  for (const file of paneFiles) {
    try {
      const paneId = readFileSync(join(RELAY_DIR, file), 'utf-8').trim();
      if (!/^%\\d+$/.test(paneId)) throw new Error('invalid pane id');
      execSync(\`tmux display -t '\${paneId}' -p '#{pane_id}'\`, { stdio: 'ignore' });
    } catch {
      const workerId = file.replace(/-pane$/, '');
      for (const suffix of ['-pane', '-meta']) {
        try { unlinkSync(join(RELAY_DIR, workerId + suffix)); } catch {}
      }
      lastHashes.delete(workerId);
      workerFirstSeen.delete(workerId);
      bootstrapDone.delete(workerId);
      stoppedWorkers.add(workerId);
    }
  }
  try {
    const remaining = readdirSync(RELAY_DIR).filter(f => f.endsWith('-pane'));
    if (remaining.length === 0) process.exit(0);
  } catch {}
}, 30000);

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => relayAll(), SILENCE_MS);
    res.writeHead(200);
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  writeFileSync(PID_FILE, String(process.pid));
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT', () => { server.close(); process.exit(0); });
`,
      { mode: 0o644 },
    );

    // Launch relay as a detached background process
    const child = spawnChild('node', [scriptFile], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Wait for PID file (up to 3 seconds)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (existsSync(pidFile)) {
        try {
          const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim());
          if (pid > 0) {
            process.kill(pid, 0);
            return true;
          }
        } catch {}
      }
    }

    return false;
  } catch {
    return false;
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
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return '<1m';
}

// ============================================================================
// Legacy Workers Command (genie worker list)
// ============================================================================

export async function workersCommand(options: WorkersOptions = {}): Promise<void> {
  try {
    let workers: registry.Worker[] = [];

    if (useBeads) {
      workers = await beadsRegistry.listWorkers();
    } else {
      workers = await registry.list();
    }

    // Gather display data for each worker
    const displayData: WorkerDisplay[] = [];

    for (const worker of workers) {
      const alive = await isPaneAlive(worker.paneId);
      let currentState: string = worker.state;

      if (alive) {
        // Get live state from pane
        currentState = await getCurrentState(worker.paneId);

        // Update registry if state differs
        const mappedState = mapDisplayStateToRegistry(currentState);
        if (mappedState && mappedState !== worker.state) {
          if (useBeads) {
            await beadsRegistry.updateState(worker.id, mappedState).catch(() => {});
          } else {
            await registry.updateState(worker.id, mappedState);
          }
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
    const activeTaskIds = workers
      .filter((w) => displayData.find((d) => d.name === w.id && d.alive))
      .map((w) => w.taskId);
    const actuallyReady = queue.ready.filter((id) => !activeTaskIds.includes(id));

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            workers: displayData,
            queue: {
              ready: actuallyReady,
              blocked: queue.blocked,
            },
          },
          null,
          2,
        ),
      );
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
      console.log('\nReady: (none - all assigned or blocked)');
    }

    // Cleanup dead workers (optional - could prompt)
    const deadWorkers = displayData.filter((w) => !w.alive);
    if (deadWorkers.length > 0) {
      console.log(`\n⚠️  ${deadWorkers.length} dead worker(s) detected. Run \`genie worker kill <name>\` to clean up.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
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

async function getLastMessageTime(w: registry.Worker): Promise<string | null> {
  try {
    const repoPath = w.repoPath ?? process.cwd();
    const messages = await mailbox.inbox(repoPath, w.id);
    if (messages.length === 0) return null;
    const last = messages[messages.length - 1];
    const ago = Date.now() - new Date(last.createdAt).getTime();
    const mins = Math.floor(ago / 60000);
    if (mins < 1) return '<1m ago';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  } catch {
    return null;
  }
}

async function generateWorkerId(team: string, role?: string): Promise<string> {
  const base = role ? `${team}-${role}` : team;
  const existing = await registry.list();
  if (!existing.some((w) => w.id === base)) return base;

  // Use crypto.randomUUID() for the suffix to avoid race conditions
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${base}-${suffix}`;
}

// ============================================================================
// Worker Namespace (genie worker — provider-selectable orchestration)
// ============================================================================

export function registerWorkerNamespace(program: Command): void {
  const worker = program.command('worker').description('Worker lifecycle (spawn, list, kill, dashboard)');

  // worker spawn
  worker
    .command('spawn')
    .description('Spawn a new worker with provider selection')
    .option('--provider <provider>', 'Provider: claude or codex', 'claude')
    .option('--team <team>', 'Team name', process.env.GENIE_TEAM ?? 'genie')
    .requiredOption('--role <role>', 'Worker role (e.g., implementor, tester)')
    .option('--skill <skill>', 'Skill to load (optional)')
    .option('--layout <layout>', 'Layout mode: mosaic (default) or vertical')
    .option('--color <color>', 'Teammate pane border color')
    .option('--plan-mode', 'Start teammate in plan mode')
    .option('--permission-mode <mode>', 'Permission mode (e.g., acceptEdits)')
    .option('--extra-args <args...>', 'Extra CLI args forwarded to provider')
    .action(
      async (options: {
        provider: string;
        team: string;
        role?: string;
        skill?: string;
        layout?: string;
        color?: string;
        planMode?: boolean;
        permissionMode?: string;
        extraArgs?: string[];
      }) => {
        try {
          // 1. Resolve team name from flag, env, or session discovery
          const team = options.team || (await nativeTeams.discoverTeamName());
          if (!team) {
            console.error('Error: --team is required (or set GENIE_TEAM, or run inside a genie tui session)');
            process.exit(1);
          }

          // 1b. Validate spawn parameters (Group A contract)
          const params: SpawnParams = {
            provider: options.provider as ProviderName,
            team,
            role: options.role,
            skill: options.skill,
            extraArgs: options.extraArgs,
          };

          // 2. Ensure native team infrastructure exists (all providers).
          //    The team-lead is always Claude Code, so the native team
          //    directory + inbox must exist for join notifications to land.
          const repoPath = process.cwd();
          const teamConfig = await teamManager.getTeam(repoPath, team);

          let parentSessionId = teamConfig?.nativeTeamParentSessionId;
          if (!parentSessionId) {
            parentSessionId = (await nativeTeams.discoverClaudeSessionId()) ?? crypto.randomUUID();
          }

          await nativeTeams.ensureNativeTeam(team, `Genie team: ${team}`, parentSessionId);

          const spawnColor = (options.color as ClaudeTeamColor) ?? (await nativeTeams.assignColor(team));

          // 2b. Enable native teammate CLI flags for Claude only.
          //     Codex doesn't speak the native IPC protocol, but still
          //     gets registered in the team config for visibility.
          if (options.provider === 'claude') {
            params.nativeTeam = {
              enabled: true,
              parentSessionId,
              color: spawnColor,
              agentType: options.role ?? 'general-purpose',
              planModeRequired: options.planMode,
              permissionMode: options.permissionMode,
              agentName: options.role,
            };
          }

          // Session ID only for Claude — Codex doesn't support --session-id/--resume
          const isClaude = params.provider === 'claude';
          const claudeSessionId = isClaude ? crypto.randomUUID() : undefined;
          if (claudeSessionId) {
            params.sessionId = claudeSessionId;
          }

          const validated = validateSpawnParams(params);

          // 2. Build launch command (Group C adapters)
          const launch = buildLaunchCommand(validated);

          // 3. Resolve layout (Group D)
          const layoutMode = resolveLayoutMode(options.layout);

          // 4. Generate worker ID
          const workerId = await generateWorkerId(validated.team, validated.role);

          // 5. Launch tmux pane with the provider command
          const { execSync } = require('node:child_process');

          const insideTmux = Boolean(process.env.TMUX);
          const nt = validated.nativeTeam;
          const now = new Date().toISOString();
          const transport = insideTmux ? 'tmux' : 'inline';

          // 6. Register worker + native team BEFORE launching
          //    (inline mode execs into claude, so post-launch code won't run)
          const agentName = nt?.agentName ?? validated.role ?? 'worker';

          // 6b. Ensure shared OTel relay for non-native workers (Codex).
          //     The relay listens for OTLP events and captures the pane
          //     when codex goes idle (3s silence after last event).
          let otelRelayActive = false;
          if (!nt?.enabled && validated.provider === 'codex' && insideTmux) {
            ensureCodexOtelConfig();
            otelRelayActive = await ensureOtelRelay(validated.team);
          }

          // Prepend env vars via `env` command (tmux exec's directly, no shell)
          let fullCommand = launch.command;
          if (launch.env && Object.keys(launch.env).length > 0) {
            const envArgs = Object.entries(launch.env)
              .map(([k, v]) => `${k}=${v}`)
              .join(' ');
            fullCommand = `env ${envArgs} ${launch.command}`;
          }

          const registerWorker = async (paneId: string) => {
            const workerEntry: registry.Worker = {
              id: workerId,
              paneId,
              session: 'genie',
              provider: validated.provider,
              transport,
              role: validated.role,
              skill: validated.skill,
              team: validated.team,
              worktree: null,
              startedAt: now,
              state: 'spawning',
              lastStateChange: now,
              repoPath: process.cwd(),
              claudeSessionId,
              nativeTeamEnabled: nt?.enabled ?? false,
              nativeAgentId: `${agentName}@${validated.team}`,
              nativeColor: nt?.color ?? spawnColor,
              parentSessionId: nt?.parentSessionId ?? parentSessionId,
            };
            await registry.register(workerEntry);
            return workerEntry;
          };

          // Register in native team config + send join notification.
          // Runs for ALL providers — the team-lead is always Claude Code
          // and polls its native inbox, so the notification always lands.
          const registerNative = async (paneId: string) => {
            await nativeTeams.registerNativeMember(validated.team, {
              agentName,
              agentType: nt?.agentType ?? validated.role ?? 'general-purpose',
              color: nt?.color ?? spawnColor ?? 'blue',
              tmuxPaneId: paneId,
              cwd: process.cwd(),
              planModeRequired: nt?.planModeRequired,
            });
            await nativeTeams.writeNativeInbox(validated.team, 'team-lead', {
              from: agentName,
              text: `Worker ${agentName} (${validated.provider}) joined team ${validated.team}. cwd: ${process.cwd()}. Ready for tasks.`,
              summary: `${agentName} (${validated.provider}) joined`,
              timestamp: new Date().toISOString(),
              color: nt?.color ?? spawnColor ?? 'blue',
              read: false,
            });
          };

          let paneId: string;

          if (insideTmux) {
            try {
              paneId = execSync(`tmux split-window -d -P -F '#{pane_id}' ${fullCommand}`, { encoding: 'utf-8' }).trim();
            } catch (err) {
              console.error(`Failed to create tmux pane: ${err instanceof Error ? err.message : 'unknown error'}`);
              process.exit(1);
            }

            try {
              execSync(`tmux ${buildLayoutCommand('genie:0', layoutMode)}`, { stdio: 'ignore' });
            } catch {
              /* best-effort */
            }

            const workerEntry = await registerWorker(paneId);
            await registerNative(paneId);

            // Save spawn template for auto-respawn on message delivery
            await registry.saveTemplate({
              id: validated.role ?? workerId,
              provider: validated.provider,
              team: validated.team,
              role: validated.role,
              skill: validated.skill,
              cwd: process.cwd(),
              extraArgs: options.extraArgs,
              nativeTeamEnabled: workerEntry.nativeTeamEnabled,
              lastSpawnedAt: new Date().toISOString(),
              lastSessionId: workerEntry.claudeSessionId,
            });

            // Register pane with the shared OTel relay.
            if (otelRelayActive && paneId !== '%0') {
              const { writeFileSync: wfs } = require('node:fs');
              const { join: pjoin } = require('node:path');
              const { homedir: hdir } = require('node:os');
              const rd = pjoin(hdir(), '.genie', 'relay');
              wfs(pjoin(rd, `${workerId}-pane`), paneId);
              wfs(
                pjoin(rd, `${workerId}-meta`),
                JSON.stringify({
                  agent: agentName,
                  color: spawnColor,
                }),
              );
            }

            console.log(`Worker "${workerId}" spawned.`);
            console.log(`  Provider: ${launch.provider}`);
            console.log(`  Command:  ${fullCommand}`);
            console.log(`  Team:     ${validated.team}`);
            console.log(`  Pane:     ${paneId}`);
            if (validated.role) console.log(`  Role:     ${validated.role}`);
            if (validated.skill) console.log(`  Skill:    ${validated.skill}`);
            if (workerEntry.claudeSessionId) {
              console.log(`  Session:  ${workerEntry.claudeSessionId}`);
            }
            console.log(`  Layout:   ${layoutMode}`);
            if (nt?.enabled) {
              console.log('  Native:   enabled');
              console.log(`  AgentID:  ${workerEntry.nativeAgentId}`);
              console.log(`  Color:    ${nt.color}`);
            }
            if (otelRelayActive) {
              console.log(`  OTel:     relay on port ${OTEL_RELAY_PORT}`);
            }
          } else {
            // Outside tmux — register first, then exec foreground (blocking)
            paneId = 'inline';
            const workerEntry = await registerWorker(paneId);
            await registerNative(paneId);

            console.log(`Worker "${workerId}" starting inline...`);
            console.log(`  Provider: ${launch.provider} | Team: ${validated.team} | Role: ${validated.role ?? '-'}`);
            if (nt?.enabled) {
              console.log(`  Native:   enabled | AgentID: ${workerEntry.nativeAgentId}`);
            }
            console.log('');

            // Exec into claude — this blocks until the session ends
            const { spawnSync } = require('node:child_process');
            const envVars = { ...process.env, ...(launch.env ?? {}) };
            const result = spawnSync('sh', ['-c', launch.command], {
              env: envVars,
              stdio: 'inherit',
            });

            // Session ended — clean up
            await registry.unregister(workerId);
            if (nt?.enabled && agentName) {
              await nativeTeams.clearNativeInbox(validated.team, agentName).catch(() => {});
              await nativeTeams.unregisterNativeMember(validated.team, agentName).catch(() => {});
            }
            console.log(`\nWorker "${workerId}" session ended.`);
            process.exit(result.status ?? 0);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Error: ${message}`);
          process.exit(1);
        }
      },
    );

  // worker list
  worker
    .command('list')
    .alias('ls')
    .description('List all workers with provider metadata')
    .option('--json', 'Output as JSON')
    .option('--prune', 'Auto-remove dead workers from registry')
    .action(async (options: { json?: boolean; prune?: boolean }) => {
      try {
        const workers = await registry.list();

        const entries: { worker: registry.Worker; liveState: string; lastMsg: string | null; dead: boolean }[] = [];
        const pruned: string[] = [];

        for (const w of workers) {
          // Suspended workers
          if (w.state === 'suspended') {
            const SUSPEND_EXPIRY_MS = 24 * 60 * 60 * 1000;
            const suspendedAge = w.suspendedAt ? Date.now() - new Date(w.suspendedAt).getTime() : Infinity;

            if (options.prune && suspendedAge > SUSPEND_EXPIRY_MS) {
              if (w.team && w.nativeAgentId) {
                const agentName = w.nativeAgentId.split('@')[0];
                await nativeTeams.clearNativeInbox(w.team, agentName).catch(() => {});
                await nativeTeams.unregisterNativeMember(w.team, agentName).catch(() => {});
              }
              if (w.role) await registry.removeTemplate(w.role).catch(() => {});
              await registry.removeTemplate(w.id).catch(() => {});
              await registry.unregister(w.id);
              pruned.push(w.id);
            } else {
              const lastMsg = await getLastMessageTime(w);
              entries.push({ worker: w, liveState: '\u{1F4A4} suspended', lastMsg, dead: false });
            }
            continue;
          }

          const paneAlive = await isPaneAlive(w.paneId);

          if (paneAlive) {
            const liveState = await getCurrentState(w.paneId);
            const mapped = mapDisplayStateToRegistry(liveState);
            if (mapped && mapped !== w.state) {
              await registry.updateState(w.id, mapped);
            }
            const lastMsg = await getLastMessageTime(w);
            entries.push({ worker: w, liveState, lastMsg, dead: false });
          } else if (options.prune) {
            if (w.team && w.nativeAgentId) {
              const agentName = w.nativeAgentId.split('@')[0];
              await nativeTeams.clearNativeInbox(w.team, agentName).catch(() => {});
              await nativeTeams.unregisterNativeMember(w.team, agentName).catch(() => {});
            }
            await registry.unregister(w.id);
            pruned.push(w.id);
          } else {
            const lastMsg = await getLastMessageTime(w);
            entries.push({ worker: w, liveState: '\u{1F480} dead', lastMsg, dead: true });
          }
        }

        if (options.json) {
          const result: any[] = entries.map(({ worker: w, liveState, lastMsg }) => ({
            id: w.id,
            provider: w.provider,
            transport: w.transport,
            team: w.team,
            role: w.role,
            state: liveState,
            elapsed: registry.getElapsedTime(w).formatted,
            lastMessage: lastMsg ?? null,
          }));
          if (pruned.length > 0) {
            result.push(...pruned.map((id) => ({ id, state: 'dead (pruned)' })));
          }
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (entries.length === 0 && pruned.length === 0) {
          console.log('No workers found.');
          console.log('  Spawn one: genie worker spawn --role implementor');
          return;
        }

        console.log('');
        console.log('WORKERS');
        console.log('-'.repeat(90));
        console.log(
          `${'ID'.padEnd(20)}${'PROVIDER'.padEnd(10)}${'TEAM'.padEnd(10)}${'ROLE'.padEnd(14)}${'STATE'.padEnd(16)}${'TIME'.padEnd(8)}LAST MSG`,
        );
        console.log('-'.repeat(90));

        for (const { worker: w, liveState, lastMsg } of entries) {
          const id = w.id.padEnd(20).substring(0, 20);
          const provider = (w.provider || '-').padEnd(10);
          const team = (w.team || '-').padEnd(10).substring(0, 10);
          const role = (w.role || '-').padEnd(14).substring(0, 14);
          const state = liveState.padEnd(16).substring(0, 16);
          const time = registry.getElapsedTime(w).formatted.padEnd(8);
          const msg = lastMsg ?? '-';
          console.log(`${id}${provider}${team}${role}${state}${time}${msg}`);
        }

        if (pruned.length > 0) {
          console.log('');
          console.log(`Pruned ${pruned.length} dead worker(s): ${pruned.join(', ')}`);
        }

        const deadCount = entries.filter((e) => e.dead).length;
        if (deadCount > 0 && !options.prune) {
          console.log(`\n${deadCount} dead worker(s). Use --prune to remove.`);
        }
        console.log('');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // worker kill
  worker
    .command('kill <id>')
    .description('Force kill a worker')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (id: string, _options: { yes?: boolean }) => {
      try {
        const w = await registry.get(id);
        if (!w) {
          console.error(`Worker "${id}" not found.`);
          process.exit(1);
        }

        // Kill the tmux pane (validate paneId format to prevent injection)
        try {
          const { execSync } = require('node:child_process');
          const currentPane = execSync("tmux display-message -p '#{pane_id}'", { encoding: 'utf-8' }).trim();
          const validPaneId = w.paneId && /^(%\d+|inline)$/.test(w.paneId);
          if (validPaneId && w.paneId !== currentPane) {
            execSync(`tmux kill-pane -t ${w.paneId}`, { stdio: 'ignore' });
          } else if (w.paneId === currentPane) {
            console.log('  (skipped pane kill — would kill current session)');
          }
        } catch {
          /* pane may already be gone */
        }

        // Clean up OTel relay worker files (pane + meta).
        // The shared relay auto-exits when no pane files remain.
        try {
          const { join } = require('node:path');
          const { homedir } = require('node:os');
          const { unlinkSync } = require('node:fs');
          const relayDir = join(homedir(), '.genie', 'relay');
          for (const suffix of ['-pane', '-meta']) {
            try {
              unlinkSync(join(relayDir, `${id}${suffix}`));
            } catch {}
          }
        } catch {
          /* best-effort */
        }

        // Clean up native team: clear inbox + unregister member.
        // All providers register in native team now (not just Claude),
        // so clean up based on nativeAgentId presence, not nativeTeamEnabled.
        if (w.team && w.nativeAgentId) {
          try {
            const agentName = w.nativeAgentId.split('@')[0];
            await nativeTeams.clearNativeInbox(w.team, agentName);
            await nativeTeams.unregisterNativeMember(w.team, agentName);
          } catch {
            /* best-effort */
          }
        }

        await registry.unregister(id);

        // Remove spawn template to prevent auto-respawn of killed workers
        if (w.role) {
          await registry.removeTemplate(w.role).catch(() => {});
        }
        await registry.removeTemplate(id).catch(() => {});

        console.log(`Worker "${id}" killed and unregistered.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // worker suspend
  worker
    .command('suspend <id>')
    .description('Suspend a worker (kill pane, preserve session for resume)')
    .action(async (id: string) => {
      try {
        const w = await registry.get(id);
        if (!w) {
          console.error(`Worker "${id}" not found.`);
          process.exit(1);
        }
        if (w.state === 'suspended') {
          console.log(`Worker "${id}" is already suspended.`);
          return;
        }
        const { suspendWorker } = await import('../lib/idle-timeout.js');
        const ok = await suspendWorker(id);
        if (ok) {
          console.log(`Worker "${id}" suspended.`);
          if (w.claudeSessionId) {
            console.log(`  Session preserved: ${w.claudeSessionId}`);
          }
          console.log(`  Send a message to auto-resume: genie msg send ${id} "your message"`);
        } else {
          console.error(`Failed to suspend worker "${id}".`);
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // worker watchdog
  worker
    .command('watchdog')
    .description('Start idle timeout watchdog (suspends idle workers)')
    .option('--once', 'Run a single check and exit')
    .action(async (options: { once?: boolean }) => {
      try {
        const { checkIdleWorkers, runWatchdogLoop, getIdleTimeoutMs } = await import('../lib/idle-timeout.js');
        const timeoutMs = getIdleTimeoutMs();

        if (timeoutMs === 0) {
          console.log('Idle timeout is disabled (GENIE_IDLE_TIMEOUT_MS=0).');
          return;
        }

        console.log(`Idle timeout: ${Math.round(timeoutMs / 60000)}m`);

        if (options.once) {
          const suspended = await checkIdleWorkers();
          if (suspended.length > 0) {
            console.log(`Suspended ${suspended.length} worker(s): ${suspended.join(', ')}`);
          } else {
            console.log('No idle workers to suspend.');
          }
          return;
        }

        console.log('Starting watchdog loop (Ctrl+C to stop)...');
        await runWatchdogLoop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
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
              claude: workers.filter((w) => w.provider === 'claude').length,
              codex: workers.filter((w) => w.provider === 'codex').length,
            },
            byState: {
              spawning: workers.filter((w) => w.state === 'spawning').length,
              working: workers.filter((w) => w.state === 'working').length,
              idle: workers.filter((w) => w.state === 'idle').length,
              done: workers.filter((w) => w.state === 'done').length,
              suspended: workers.filter((w) => w.state === 'suspended').length,
            },
          };
          console.log(
            JSON.stringify(
              {
                summary,
                workers: workers.map((w) => ({
                  id: w.id,
                  provider: w.provider,
                  team: w.team,
                  role: w.role,
                  skill: w.skill,
                  state: w.state,
                  paneId: w.paneId,
                  transport: w.transport,
                })),
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log('');
        console.log('WORKER DASHBOARD');
        console.log('='.repeat(80));
        console.log(`Workers: ${workers.length}`);
        console.log(`  Claude: ${workers.filter((w) => w.provider === 'claude').length}`);
        console.log(`  Codex:  ${workers.filter((w) => w.provider === 'codex').length}`);
        console.log('');

        if (workers.length === 0) {
          console.log('No active workers.');
          return;
        }

        for (const w of workers) {
          const elapsed = registry.getElapsedTime(w).formatted;
          console.log(
            `  [${w.provider || 'claude'}] ${w.id} (${w.team || 'default'}/${w.role || 'default'}) — ${w.state} — ${elapsed}`,
          );
          if (w.skill) console.log(`    Skill: ${w.skill}`);
          console.log(`    Pane: ${w.paneId} | Session: ${w.session} | Transport: ${w.transport || 'tmux'}`);
        }

        console.log('');

        if (options.watch) {
          console.log('Watch mode: would auto-refresh every 2s (tmux required)');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // ============================================================================
  // Commands migrated from genie term
  // ============================================================================

  // worker approve — auto-approve engine management
  worker
    .command('approve [request-id]')
    .description('Auto-approve engine management and manual approval')
    .option('--status', 'Show pending/approved/denied requests')
    .option('--deny <request-id>', 'Manually deny a pending request')
    .option('--start', 'Start the auto-approve engine')
    .option('--stop', 'Stop the auto-approve engine')
    .action(
      async (
        requestId: string | undefined,
        options: { status?: boolean; deny?: string; start?: boolean; stop?: boolean },
      ) => {
        await approveCmd.approveCommand(requestId, options);
      },
    );

  // worker history — compressed session catch-up
  worker
    .command('history <worker>')
    .description('Show compressed session history for a worker (catch-up)')
    .option('--full', 'Show full conversation without compression')
    .option('--since <n>', 'Show last N user/assistant exchanges', Number.parseInt)
    .option('--json', 'Output as JSON')
    .option('--raw', 'Output raw JSONL entries')
    .option('--log-file <path>', 'Direct path to log file (for testing)')
    .action(async (w: string, options: historyCmd.HistoryOptions) => {
      await historyCmd.historyCommand(w, options);
    });

  // worker answer — answer worker question
  worker
    .command('answer <worker> <choice>')
    .description('Answer a question for a worker (use "text:..." for text input)')
    .action(async (w: string, choice: string) => {
      await orchestrateCmd.answerQuestion(w, choice);
    });

  // worker events — stream Claude Code events
  worker
    .command('events [pane-id]')
    .description('Stream Claude Code events from a pane or all workers')
    .option('--json', 'Output events as JSON')
    .option('-f, --follow', 'Continuous tailing (like tail -f)')
    .option('-n, --lines <number>', 'Number of recent events to show (default: 20)', '20')
    .option('--emit', 'Write events to .genie/events/<pane-id>.jsonl while tailing')
    .option('--all', 'Aggregate events from all active workers')
    .action(
      async (
        paneId: string | undefined,
        options: { json?: boolean; follow?: boolean; lines?: string; emit?: boolean; all?: boolean },
      ) => {
        await eventsCmd.eventsCommand(paneId, {
          json: options.json,
          follow: options.follow,
          lines: options.lines ? Number.parseInt(options.lines, 10) : undefined,
          emit: options.emit,
          all: options.all,
        });
      },
    );

  // worker close — close task and cleanup worker
  worker
    .command('close <task-id>')
    .description('Close task/issue and cleanup worker')
    .option('--no-sync', 'Skip bd sync (beads only)')
    .option('--keep-worktree', "Don't remove the worktree")
    .option('--merge', 'Merge worktree changes to main branch')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (taskId: string, options: closeCmd.CloseOptions) => {
      await closeCmd.closeCommand(taskId, options);
    });

  // worker ship — mark done, merge, cleanup
  worker
    .command('ship <task-id>')
    .description('Mark task as done and cleanup worker')
    .option('--keep-worktree', "Don't remove the worktree")
    .option('--merge', 'Merge worktree changes to main branch')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (taskId: string, options: shipCmd.ShipOptions) => {
      await shipCmd.shipCommand(taskId, options);
    });

  // worker read — read worker pane output
  worker
    .command('read <target>')
    .description('Read terminal output from a worker pane')
    .option('-n, --lines <number>', 'Number of lines to read')
    .option('--from <line>', 'Start line')
    .option('--to <line>', 'End line')
    .option('--range <range>', 'Line range (e.g., "10-20")')
    .option('--search <text>', 'Search for text')
    .option('--grep <pattern>', 'Grep for pattern')
    .option('-f, --follow', 'Follow mode (like tail -f)')
    .option('--all', 'Show all output')
    .option('-r, --reverse', 'Reverse order')
    .option('--json', 'Output as JSON')
    .action(async (target: string, options: readCmd.ReadOptions) => {
      await readCmd.readSessionLogs(target, options);
    });

  // worker exec — execute command in worker pane
  worker
    .command('exec <target> <command>')
    .description('Execute command in a worker pane')
    .option('-q, --quiet', 'Suppress output')
    .option('-t, --timeout <ms>', 'Timeout in milliseconds')
    .action(async (target: string, command: string, options: execCmd.ExecOptions) => {
      await execCmd.executeInSession(target, command, options);
    });
}
