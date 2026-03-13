/**
 * Agent Namespace — unified agent lifecycle commands.
 *
 * genie agent:
 *   spawn     - Spawn an agent with provider selection
 *   list      - List all agents with provider metadata
 *   kill <id> - Force kill an agent
 *   dashboard - Live status of all agents
 *   suspend   - Suspend an agent (kill pane, preserve session)
 *   watchdog  - Idle timeout watchdog
 *   approve   - Auto-approve engine management
 *   history   - Compressed session catch-up
 *   answer    - Answer agent question
 *   events    - Stream Claude Code events
 *   close     - Close task and cleanup agent
 *   ship      - Mark done, merge, cleanup
 *   read      - Read agent pane output
 *   exec      - Execute command in agent pane
 */

import type { Command } from 'commander';
import * as directory from '../lib/agent-directory.js';
import * as registry from '../lib/agent-registry.js';
import * as nativeTeams from '../lib/claude-native-teams.js';
import { OTEL_RELAY_PORT, ensureCodexOtelConfig } from '../lib/codex-config.js';
import * as mailbox from '../lib/mailbox.js';
import { buildLayoutCommand, resolveLayoutMode } from '../lib/mosaic-layout.js';
import { detectState } from '../lib/orchestrator/index.js';
import {
  type ClaudeTeamColor,
  type ProviderName,
  type SpawnParams,
  buildLaunchCommand,
  validateSpawnParams,
} from '../lib/provider-adapters.js';
import * as teamManager from '../lib/team-manager.js';
import * as tmux from '../lib/tmux.js';
import { isPaneAlive } from '../lib/tmux.js';
import * as approveCmd from './approve.js';
import * as closeCmd from './close.js';
import * as eventsCmd from './events.js';
import * as execCmd from './exec.js';
import * as historyCmd from './history.js';
import * as orchestrateCmd from './orchestrate.js';
import * as readCmd from './read.js';
import * as shipCmd from './ship.js';

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

/** Check if a process is alive by PID file. */
function isRelayAlive(pidFile: string): boolean {
  const { readFileSync, existsSync } = require('node:fs');
  if (!existsSync(pidFile)) return false;
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim());
    if (pid > 0) {
      process.kill(pid, 0);
      return true;
    }
  } catch {
    // Process dead
  }
  return false;
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
  const { writeFileSync, mkdirSync } = require('node:fs');
  const { join } = require('node:path');
  const { homedir } = require('node:os');

  const relayDir = join(homedir(), '.genie', 'relay');
  mkdirSync(relayDir, { recursive: true });

  const pidFile = join(relayDir, 'otel-relay.pid');
  const scriptFile = join(relayDir, 'otel-relay.mjs');

  // Check if relay is already running
  if (isRelayAlive(pidFile)) return true;

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
    const { spawn: spawnChild } = require('node:child_process');
    const child = spawnChild('node', [scriptFile], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    // Wait for PID file (up to 3 seconds)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (isRelayAlive(pidFile)) return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Map display state to registry state
 */
function mapDisplayStateToRegistry(displayState: string): registry.AgentState | null {
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

async function getLastMessageTime(w: registry.Agent): Promise<string | null> {
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
// Spawn helpers (extracted for cognitive complexity)
// ============================================================================

/** Shared context between spawn helper functions. */
interface SpawnCtx {
  workerId: string;
  validated: SpawnParams;
  launch: { command: string; provider: string; env?: Record<string, string> };
  layoutMode: 'mosaic' | 'vertical';
  fullCommand: string;
  agentName: string;
  spawnColor: string;
  parentSessionId: string;
  claudeSessionId: string | undefined;
  otelRelayActive: boolean;
  now: string;
  transport: registry.TransportType;
  extraArgs?: string[];
  /** Working directory for the worker (defaults to process.cwd()). */
  cwd: string;
}

async function registerSpawnWorker(
  ctx: SpawnCtx,
  paneId: string,
  windowInfo?: { windowId: string; windowName: string } | null,
): Promise<registry.Agent> {
  const nt = ctx.validated.nativeTeam;
  const workerEntry: registry.Agent = {
    id: ctx.workerId,
    paneId,
    session: 'genie',
    provider: ctx.validated.provider,
    transport: ctx.transport,
    role: ctx.validated.role,
    skill: ctx.validated.skill,
    team: ctx.validated.team,
    worktree: null,
    startedAt: ctx.now,
    state: 'spawning',
    lastStateChange: ctx.now,
    repoPath: ctx.cwd,
    claudeSessionId: ctx.claudeSessionId,
    nativeTeamEnabled: nt?.enabled ?? false,
    nativeAgentId: `${ctx.agentName}@${ctx.validated.team}`,
    nativeColor: nt?.color ?? ctx.spawnColor,
    parentSessionId: nt?.parentSessionId ?? ctx.parentSessionId,
    // Team window tracking
    window: windowInfo?.windowName,
    windowName: windowInfo?.windowName,
    windowId: windowInfo?.windowId,
  };
  await registry.register(workerEntry);
  return workerEntry;
}

async function notifySpawnJoin(ctx: SpawnCtx, paneId: string): Promise<void> {
  const nt = ctx.validated.nativeTeam;
  await nativeTeams.registerNativeMember(ctx.validated.team, {
    agentName: ctx.agentName,
    agentType: nt?.agentType ?? ctx.validated.role ?? 'general-purpose',
    color: nt?.color ?? ctx.spawnColor ?? 'blue',
    tmuxPaneId: paneId,
    cwd: ctx.cwd,
    planModeRequired: nt?.planModeRequired,
  });
  await nativeTeams.writeNativeInbox(ctx.validated.team, 'team-lead', {
    from: ctx.agentName,
    text: `Worker ${ctx.agentName} (${ctx.validated.provider}) joined team ${ctx.validated.team}. cwd: ${ctx.cwd}. Ready for tasks.`,
    summary: `${ctx.agentName} (${ctx.validated.provider}) joined`,
    timestamp: new Date().toISOString(),
    color: nt?.color ?? ctx.spawnColor ?? 'blue',
    read: false,
  });
}

function registerOtelRelayPane(workerId: string, paneId: string, agentName: string, spawnColor: string): void {
  const { writeFileSync: wfs } = require('node:fs');
  const { join: pjoin } = require('node:path');
  const { homedir: hdir } = require('node:os');
  const rd = pjoin(hdir(), '.genie', 'relay');
  wfs(pjoin(rd, `${workerId}-pane`), paneId);
  wfs(pjoin(rd, `${workerId}-meta`), JSON.stringify({ agent: agentName, color: spawnColor }));
}

function printSpawnInfo(ctx: SpawnCtx, paneId: string, workerEntry: registry.Agent): void {
  const nt = ctx.validated.nativeTeam;
  console.log(`Agent "${ctx.workerId}" spawned.`);
  console.log(`  Provider: ${ctx.launch.provider}`);
  console.log(`  Command:  ${ctx.fullCommand}`);
  console.log(`  Team:     ${ctx.validated.team}`);
  console.log(`  Pane:     ${paneId}`);
  if (ctx.validated.role) console.log(`  Role:     ${ctx.validated.role}`);
  if (ctx.validated.skill) console.log(`  Skill:    ${ctx.validated.skill}`);
  if (workerEntry.claudeSessionId) {
    console.log(`  Session:  ${workerEntry.claudeSessionId}`);
  }
  console.log(`  Layout:   ${ctx.layoutMode}`);
  if (nt?.enabled) {
    console.log('  Native:   enabled');
    console.log(`  AgentID:  ${workerEntry.nativeAgentId}`);
    console.log(`  Color:    ${nt.color}`);
  }
  if (ctx.otelRelayActive) {
    console.log(`  OTel:     relay on port ${OTEL_RELAY_PORT}`);
  }
}

type TeamWindowInfo = { windowId: string; windowName: string; paneId: string; created: boolean };

/** Resolve team window for spawn. Returns null if team is unset or resolution fails. */
async function resolveSpawnTeamWindow(team: string | undefined, cwd: string): Promise<TeamWindowInfo | null> {
  if (!team) return null;
  try {
    return await tmux.ensureTeamWindow('genie', team, cwd);
  } catch (err) {
    console.warn(`Warning: could not ensure team window for "${team}": ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function launchTmuxSpawn(ctx: SpawnCtx): Promise<void> {
  const { execSync } = require('node:child_process');

  const teamWindow = await resolveSpawnTeamWindow(ctx.validated.team, ctx.cwd);
  const splitTarget = teamWindow ? `-t '${teamWindow.windowId}'` : '';

  let paneId: string;
  try {
    const splitCmd = `tmux split-window -d ${splitTarget} -P -F '#{pane_id}' ${ctx.fullCommand}`;
    paneId = execSync(splitCmd, { encoding: 'utf-8' }).trim();
  } catch (err) {
    console.error(`Failed to create tmux pane: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  }

  // Apply layout to team window (or fallback to first window in session)
  const session = 'genie';
  let layoutTarget = `${session}:${teamWindow?.windowName ?? ''}`;
  if (!teamWindow) {
    const wins = await tmux.listWindows(session);
    layoutTarget = wins[0] ? wins[0].id : `${session}:`;
  }
  try {
    execSync(`tmux ${buildLayoutCommand(layoutTarget, ctx.layoutMode)}`, { stdio: 'ignore' });
  } catch {
    /* best-effort */
  }

  const workerEntry = await registerSpawnWorker(ctx, paneId, teamWindow);
  await notifySpawnJoin(ctx, paneId);

  // Apply agent color to tmux pane border (focus-driven)
  if (ctx.spawnColor && paneId !== 'inline') {
    await tmux.applyPaneColor(paneId, ctx.spawnColor, teamWindow?.windowId);
  }

  // Save spawn template for auto-respawn on message delivery
  await registry.saveTemplate({
    id: ctx.validated.role ?? ctx.workerId,
    provider: ctx.validated.provider,
    team: ctx.validated.team,
    role: ctx.validated.role,
    skill: ctx.validated.skill,
    cwd: ctx.cwd,
    extraArgs: ctx.extraArgs,
    nativeTeamEnabled: workerEntry.nativeTeamEnabled,
    lastSpawnedAt: new Date().toISOString(),
    lastSessionId: workerEntry.claudeSessionId,
  });

  // Register pane with the shared OTel relay.
  if (ctx.otelRelayActive && paneId !== '%0') {
    registerOtelRelayPane(ctx.workerId, paneId, ctx.agentName, ctx.spawnColor);
  }

  if (teamWindow) {
    console.log(`  Window:   ${teamWindow.windowName} (${teamWindow.windowId})`);
  }
  printSpawnInfo(ctx, paneId, workerEntry);
}

async function launchInlineSpawn(ctx: SpawnCtx): Promise<void> {
  const nt = ctx.validated.nativeTeam;
  const paneId = 'inline';
  const workerEntry = await registerSpawnWorker(ctx, paneId);
  await notifySpawnJoin(ctx, paneId);

  console.log(`Agent "${ctx.workerId}" starting inline...`);
  console.log(`  Provider: ${ctx.launch.provider} | Team: ${ctx.validated.team} | Role: ${ctx.validated.role ?? '-'}`);
  if (nt?.enabled) {
    console.log(`  Native:   enabled | AgentID: ${workerEntry.nativeAgentId}`);
  }
  console.log('');

  // Exec into claude — this blocks until the session ends
  const { spawnSync } = require('node:child_process');
  const envVars = { ...process.env, ...(ctx.launch.env ?? {}) };
  const result = spawnSync('sh', ['-c', ctx.launch.command], {
    env: envVars,
    stdio: 'inherit',
  });

  // Session ended — clean up
  await registry.unregister(ctx.workerId);
  if (nt?.enabled && ctx.agentName) {
    await nativeTeams.clearNativeInbox(ctx.validated.team, ctx.agentName).catch(() => {});
    await nativeTeams.unregisterNativeMember(ctx.validated.team, ctx.agentName).catch(() => {});
  }
  console.log(`\nAgent "${ctx.workerId}" session ended.`);
  process.exit(result.status ?? 0);
}

function prependEnvVars(command: string, env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return command;
  const envArgs = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return `env ${envArgs} ${command}`;
}

/**
 * Reject spawn if a live worker with the same role already exists in the team.
 * Dead/suspended workers (pane gone) are ignored — only live panes block.
 */
async function rejectDuplicateRole(team: string, role: string): Promise<void> {
  const existing = await registry.list();
  for (const w of existing) {
    if (w.role === role && w.team === team && (await isPaneAlive(w.paneId))) {
      console.error(
        `Error: Worker with role "${role}" already exists in team "${team}" (state: ${w.state}, pane: ${w.paneId})\n` +
          `Use a different --role name for a second worker, e.g.: --role ${role}-2`,
      );
      process.exit(1);
    }
  }
}

/** Resolve parent session ID and set up native team infrastructure. */
async function resolveNativeTeam(
  team: string,
  repoPath: string,
  options: { provider: string; role?: string; color?: string; planMode?: boolean; permissionMode?: string },
): Promise<{ parentSessionId: string; spawnColor: ClaudeTeamColor; nativeTeam?: SpawnParams['nativeTeam'] }> {
  const teamConfig = await teamManager.getTeam(repoPath, team);
  let parentSessionId = teamConfig?.nativeTeamParentSessionId;
  if (!parentSessionId) {
    parentSessionId = (await nativeTeams.discoverClaudeSessionId()) ?? crypto.randomUUID();
  }
  await nativeTeams.ensureNativeTeam(team, `Genie team: ${team}`, parentSessionId);
  const spawnColor = (options.color as ClaudeTeamColor) ?? (await nativeTeams.assignColor(team));

  let nativeTeam: SpawnParams['nativeTeam'];
  if (options.provider === 'claude') {
    nativeTeam = {
      enabled: true,
      parentSessionId,
      color: spawnColor,
      agentType: options.role ?? 'general-purpose',
      planModeRequired: options.planMode,
      permissionMode: options.permissionMode,
      agentName: options.role,
    };
  }

  return { parentSessionId, spawnColor, nativeTeam };
}

interface SpawnOptions {
  provider: string;
  team: string;
  model?: string;
  skill?: string;
  layout?: string;
  color?: string;
  planMode?: boolean;
  permissionMode?: string;
  extraArgs?: string[];
  cwd?: string;
}

/** Resolve agent from directory, returning entry + derived CWD/identity/model. */
async function resolveAgentForSpawn(
  name: string,
  options: SpawnOptions,
): Promise<{
  entry: directory.DirectoryEntry;
  repoPath: string;
  identityPath: string | null;
  model: string | undefined;
}> {
  const resolved = await directory.resolve(name);
  if (!resolved) {
    console.error(`Error: Agent "${name}" not found in directory or built-ins.`);
    console.error(`  Register with: genie dir add ${name} --dir <path>`);
    console.error('  Or use a built-in: implementor, tester, reviewer, debugger, ...');
    process.exit(1);
  }
  const entry = resolved.entry;
  return {
    entry,
    repoPath: options.cwd ?? (entry.dir || undefined) ?? process.cwd(),
    identityPath: entry.dir ? directory.loadIdentity(entry) : null,
    model: options.model ?? entry.model,
  };
}

/** Build SpawnParams from resolved agent + options. */
async function buildSpawnParams(
  name: string,
  team: string,
  options: SpawnOptions,
  agent: Awaited<ReturnType<typeof resolveAgentForSpawn>>,
): Promise<{ params: SpawnParams; parentSessionId: string; spawnColor: ClaudeTeamColor }> {
  const params: SpawnParams = {
    provider: options.provider as ProviderName,
    team,
    role: name,
    skill: options.skill,
    extraArgs: options.extraArgs,
    model: agent.model,
    systemPromptFile: agent.identityPath ?? undefined,
    promptMode: agent.entry.promptMode,
  };

  const { parentSessionId, spawnColor, nativeTeam } = await resolveNativeTeam(team, agent.repoPath, {
    ...options,
    role: name,
  });
  if (nativeTeam) params.nativeTeam = nativeTeam;

  // Inject hook dispatch into team settings.json (idempotent)
  try {
    const { injectTeamHooks } = await import('../hooks/inject.js');
    const injected = await injectTeamHooks(team);
    if (injected) console.log(`  Hooks:    injected genie hook dispatch into team "${team}"`);
  } catch (err) {
    console.warn(`Warning: could not inject hooks for team "${team}": ${err instanceof Error ? err.message : err}`);
  }

  const claudeSessionId = params.provider === 'claude' ? crypto.randomUUID() : undefined;
  if (claudeSessionId) params.sessionId = claudeSessionId;

  return { params, parentSessionId, spawnColor };
}

async function handleWorkerSpawn(name: string, options: SpawnOptions): Promise<void> {
  // 1. Resolve agent from directory or built-ins
  const agent = await resolveAgentForSpawn(name, options);

  // 2. Resolve team
  const team = options.team || (await nativeTeams.discoverTeamName());
  if (!team) {
    console.error('Error: --team is required (or set GENIE_TEAM, or run inside a genie session)');
    process.exit(1);
  }
  await rejectDuplicateRole(team, name);

  // 3. Build params
  const { params, parentSessionId, spawnColor } = await buildSpawnParams(name, team, options, agent);

  const validated = validateSpawnParams(params);
  const launch = buildLaunchCommand(validated);
  const layoutMode = resolveLayoutMode(options.layout);
  const workerId = await generateWorkerId(validated.team, name);

  const insideTmux = Boolean(process.env.TMUX);
  const nt = validated.nativeTeam;
  const now = new Date().toISOString();
  const agentName = nt?.agentName ?? name;

  // OTel relay for non-native workers (Codex)
  let otelRelayActive = false;
  if (!nt?.enabled && validated.provider === 'codex' && insideTmux) {
    ensureCodexOtelConfig();
    otelRelayActive = await ensureOtelRelay(validated.team);
  }

  const fullCommand = prependEnvVars(launch.command, launch.env);

  const ctx: SpawnCtx = {
    workerId,
    validated,
    launch,
    layoutMode,
    fullCommand,
    agentName,
    spawnColor,
    parentSessionId,
    claudeSessionId: params.sessionId,
    otelRelayActive,
    now,
    transport: insideTmux ? 'tmux' : 'inline',
    extraArgs: options.extraArgs,
    cwd: agent.repoPath,
  };

  if (insideTmux) {
    await launchTmuxSpawn(ctx);
  } else {
    await launchInlineSpawn(ctx);
  }
}

// ============================================================================
// List helpers (extracted for cognitive complexity)
// ============================================================================

type WorkerListEntry = { worker: registry.Agent; liveState: string; lastMsg: string | null; dead: boolean };
type StoppedEntry = { template: registry.WorkerTemplate };

/** Find templates with no corresponding active worker. */
async function collectStoppedTemplates(activeEntries: WorkerListEntry[]): Promise<StoppedEntry[]> {
  const templates = await registry.listTemplates();
  const activeIds = new Set(activeEntries.map((e) => e.worker.id));
  const activeRoles = new Set(activeEntries.map((e) => e.worker.role).filter(Boolean));
  const stopped: StoppedEntry[] = [];
  for (const t of templates) {
    if (!activeIds.has(t.id) && !(t.role && activeRoles.has(t.role))) {
      stopped.push({ template: t });
    }
  }
  return stopped;
}

/** Clean up a worker's native team registration. */
async function cleanupWorkerNativeTeam(w: registry.Agent): Promise<void> {
  if (!w.team || !w.nativeAgentId) return;
  const agentName = w.nativeAgentId.split('@')[0];
  await nativeTeams.clearNativeInbox(w.team, agentName).catch(() => {});
  await nativeTeams.unregisterNativeMember(w.team, agentName).catch(() => {});
}

/** Process a single worker for the list view: returns entry or pruned ID. */
async function processWorkerForList(
  w: registry.Agent,
  prune?: boolean,
): Promise<{ entry?: WorkerListEntry; prunedId?: string }> {
  if (w.state === 'suspended') {
    return processSuspendedWorker(w, prune);
  }

  const paneAlive = await isPaneAlive(w.paneId);

  if (paneAlive) {
    const liveState = await getCurrentState(w.paneId);
    const mapped = mapDisplayStateToRegistry(liveState);
    if (mapped && mapped !== w.state) {
      await registry.updateState(w.id, mapped);
    }
    const lastMsg = await getLastMessageTime(w);
    return { entry: { worker: w, liveState, lastMsg, dead: false } };
  }

  if (prune) {
    await cleanupWorkerNativeTeam(w);
    await registry.unregister(w.id);
    return { prunedId: w.id };
  }

  const lastMsg = await getLastMessageTime(w);
  return { entry: { worker: w, liveState: '\u{1F480} dead', lastMsg, dead: true } };
}

async function processSuspendedWorker(
  w: registry.Agent,
  prune?: boolean,
): Promise<{ entry?: WorkerListEntry; prunedId?: string }> {
  const SUSPEND_EXPIRY_MS = 24 * 60 * 60 * 1000;
  const suspendedAge = w.suspendedAt ? Date.now() - new Date(w.suspendedAt).getTime() : Number.POSITIVE_INFINITY;

  if (prune && suspendedAge > SUSPEND_EXPIRY_MS) {
    await cleanupWorkerNativeTeam(w);
    if (w.role) await registry.removeTemplate(w.role).catch(() => {});
    await registry.removeTemplate(w.id).catch(() => {});
    await registry.unregister(w.id);
    return { prunedId: w.id };
  }

  const lastMsg = await getLastMessageTime(w);
  return { entry: { worker: w, liveState: '\u{1F4A4} suspended', lastMsg, dead: false } };
}

function formatWorkerRow(
  id: string,
  provider: string,
  team: string,
  role: string,
  window: string,
  state: string,
  time: string,
  lastMsg: string,
  cwd: string,
): string {
  return `${id.padEnd(20).substring(0, 20)}${(provider || '-').padEnd(10)}${(team || '-').padEnd(10).substring(0, 10)}${(role || '-').padEnd(14).substring(0, 14)}${(window || '-').padEnd(12).substring(0, 12)}${state.padEnd(16).substring(0, 16)}${time.padEnd(8)}${(lastMsg || '-').padEnd(10)}${cwd}`;
}

function printWorkerRows(entries: WorkerListEntry[], stopped: StoppedEntry[]): void {
  for (const { worker: w, liveState, lastMsg } of entries) {
    console.log(
      formatWorkerRow(
        w.id,
        w.provider || '-',
        w.team || '-',
        w.role || '-',
        w.window || w.windowName || '-',
        liveState,
        registry.getElapsedTime(w).formatted,
        lastMsg ?? '-',
        w.repoPath || '-',
      ),
    );
  }

  for (const { template: t } of stopped) {
    const lastActivity = t.lastSpawnedAt ? registry.formatElapsed(new Date(t.lastSpawnedAt)) : '-';
    console.log(
      formatWorkerRow(
        t.id,
        t.provider || '-',
        t.team || '-',
        t.role || '-',
        '-',
        'stopped',
        '-',
        lastActivity,
        t.cwd || '-',
      ),
    );
  }
}

function printWorkerList(
  entries: WorkerListEntry[],
  pruned: string[],
  stopped: StoppedEntry[],
  options: { json?: boolean; prune?: boolean; running?: boolean },
): void {
  if (options.json) {
    printWorkerListJson(entries, pruned, stopped);
    return;
  }

  if (entries.length === 0 && stopped.length === 0 && pruned.length === 0) {
    console.log('No agents found.');
    console.log('  Spawn one: genie agent spawn implementor');
    return;
  }

  console.log('');
  console.log('WORKERS');
  console.log('-'.repeat(132));
  console.log(formatWorkerRow('ID', 'PROVIDER', 'TEAM', 'ROLE', 'WINDOW', 'STATE', 'TIME', 'LAST MSG', 'CWD'));
  console.log('-'.repeat(132));

  printWorkerRows(entries, stopped);
  printWorkerListFooter(entries, pruned, stopped, options);
}

function printWorkerListFooter(
  entries: WorkerListEntry[],
  pruned: string[],
  stopped: StoppedEntry[],
  options: { prune?: boolean; running?: boolean },
): void {
  if (pruned.length > 0) {
    console.log('');
    console.log(`Pruned ${pruned.length} dead agent(s): ${pruned.join(', ')}`);
  }

  const deadCount = entries.filter((e) => e.dead).length;
  if (deadCount > 0 && !options.prune) {
    console.log(`\n${deadCount} dead agent(s). Use --prune to remove.`);
  }
  if (stopped.length > 0 && !options.running) {
    console.log(`\n${stopped.length} stopped agent(s) (templates). Use -r to hide.`);
  }
  console.log('');
}

function printWorkerListJson(entries: WorkerListEntry[], pruned: string[], stopped: StoppedEntry[]): void {
  const result: Record<string, unknown>[] = entries.map(({ worker: w, liveState, lastMsg }) => ({
    id: w.id,
    provider: w.provider,
    transport: w.transport,
    team: w.team,
    role: w.role,
    window: w.window || w.windowName || null,
    state: liveState,
    elapsed: registry.getElapsedTime(w).formatted,
    lastMessage: lastMsg ?? null,
  }));
  for (const { template: t } of stopped) {
    result.push({
      id: t.id,
      provider: t.provider,
      team: t.team,
      role: t.role ?? null,
      state: 'stopped',
      lastSpawnedAt: t.lastSpawnedAt,
    });
  }
  if (pruned.length > 0) {
    result.push(...pruned.map((id) => ({ id, state: 'dead (pruned)' })));
  }
  console.log(JSON.stringify(result, null, 2));
}

// ============================================================================
// Kill helpers (extracted for cognitive complexity)
// ============================================================================

function killWorkerPane(w: registry.Agent): void {
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
}

function cleanupRelayFiles(id: string): void {
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
}

// ============================================================================
// Dashboard helpers (extracted for cognitive complexity)
// ============================================================================

function printDashboardJson(workers: registry.Agent[]): void {
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
}

function printDashboardText(workers: registry.Agent[], watch?: boolean): void {
  console.log('');
  console.log('AGENT DASHBOARD');
  console.log('='.repeat(80));
  console.log(`Agents: ${workers.length}`);
  console.log(`  Claude: ${workers.filter((w) => w.provider === 'claude').length}`);
  console.log(`  Codex:  ${workers.filter((w) => w.provider === 'codex').length}`);
  console.log('');

  if (workers.length === 0) {
    console.log('No active agents.');
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

  if (watch) {
    console.log('Watch mode: would auto-refresh every 2s (tmux required)');
  }
}

// ============================================================================
// Agent Namespace (genie agent — provider-selectable orchestration)
// ============================================================================

export function registerAgentNamespace(program: Command): void {
  const agent = program.command('agent').description('Agent lifecycle (spawn, list, kill, dashboard)');

  // agent spawn
  agent
    .command('spawn <name>')
    .description('Spawn a new agent by name (resolves from directory or built-ins)')
    .option('--provider <provider>', 'Provider: claude or codex', 'claude')
    .option('--team <team>', 'Team name', process.env.GENIE_TEAM ?? 'genie')
    .option('--model <model>', 'Model override (e.g., sonnet, opus)')
    .option('--skill <skill>', 'Skill to load (optional)')
    .option('--layout <layout>', 'Layout mode: mosaic (default) or vertical')
    .option('--color <color>', 'Teammate pane border color')
    .option('--plan-mode', 'Start teammate in plan mode')
    .option('--permission-mode <mode>', 'Permission mode (e.g., acceptEdits)')
    .option('--extra-args <args...>', 'Extra CLI args forwarded to provider')
    .option('--cwd <path>', 'Working directory for the agent (overrides directory entry)')
    .action(
      async (
        name: string,
        options: {
          provider: string;
          team: string;
          model?: string;
          skill?: string;
          layout?: string;
          color?: string;
          planMode?: boolean;
          permissionMode?: string;
          extraArgs?: string[];
          cwd?: string;
        },
      ) => {
        try {
          await handleWorkerSpawn(name, options);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Error: ${message}`);
          process.exit(1);
        }
      },
    );

  // agent list
  agent
    .command('list')
    .alias('ls')
    .description('List all agents (active + stopped templates)')
    .option('--json', 'Output as JSON')
    .option('--prune', 'Auto-remove dead agents from registry')
    .option('-r, --running', 'Show only active agents (hide stopped)')
    .action(async (options: { json?: boolean; prune?: boolean; running?: boolean }) => {
      try {
        const workers = await registry.list();
        const entries: WorkerListEntry[] = [];
        const pruned: string[] = [];

        for (const w of workers) {
          const result = await processWorkerForList(w, options.prune);
          if (result.entry) entries.push(result.entry);
          if (result.prunedId) pruned.push(result.prunedId);
        }

        const stopped = options.running ? [] : await collectStoppedTemplates(entries);

        printWorkerList(entries, pruned, stopped, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // agent kill
  agent
    .command('kill <id>')
    .description('Force kill an agent')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (id: string, _options: { yes?: boolean }) => {
      try {
        const w = await registry.get(id);
        if (!w) {
          console.error(`Agent "${id}" not found.`);
          process.exit(1);
        }

        killWorkerPane(w);
        cleanupRelayFiles(id);
        await cleanupWorkerNativeTeam(w);

        // Save last session ID into template before unregistering so
        // ensureWorkerAlive can resume with --resume on next message.
        if (w.claudeSessionId) {
          const templates = await registry.listTemplates();
          const tmpl = templates.find((t) => t.id === id || t.id === w.role || t.role === w.role);
          if (tmpl) {
            await registry.saveTemplate({ ...tmpl, lastSessionId: w.claudeSessionId });
          }
        }

        await registry.unregister(id);

        // NOTE: templates are intentionally preserved so that
        // ensureWorkerAlive can auto-respawn the worker on next message.

        console.log(`Agent "${id}" killed and unregistered (template preserved).`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // agent suspend
  agent
    .command('suspend <id>')
    .description('Suspend an agent (kill pane, preserve session for resume)')
    .action(async (id: string) => {
      try {
        const w = await registry.get(id);
        if (!w) {
          console.error(`Agent "${id}" not found.`);
          process.exit(1);
        }
        if (w.state === 'suspended') {
          console.log(`Agent "${id}" is already suspended.`);
          return;
        }
        const { suspendWorker } = await import('../lib/idle-timeout.js');
        const ok = await suspendWorker(id);
        if (ok) {
          console.log(`Agent "${id}" suspended.`);
          if (w.claudeSessionId) {
            console.log(`  Session preserved: ${w.claudeSessionId}`);
          }
          console.log(`  Send a message to auto-resume: genie send ${id} "your message"`);
        } else {
          console.error(`Failed to suspend agent "${id}".`);
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // agent watchdog
  agent
    .command('watchdog')
    .description('Start idle timeout watchdog (suspends idle agents)')
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
            console.log(`Suspended ${suspended.length} agent(s): ${suspended.join(', ')}`);
          } else {
            console.log('No idle agents to suspend.');
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

  // agent dashboard
  agent
    .command('dashboard')
    .description('Live status of all agents with provider metadata')
    .option('--json', 'Output as JSON')
    .option('-w, --watch', 'Auto-refresh every 2 seconds')
    .action(async (options: { json?: boolean; watch?: boolean }) => {
      try {
        const workers = await registry.list();
        if (options.json) {
          printDashboardJson(workers);
        } else {
          printDashboardText(workers, options.watch);
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

  // agent approve — auto-approve engine management
  agent
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

  // agent history — compressed session catch-up
  agent
    .command('history <worker>')
    .description('Show compressed session history for an agent (catch-up)')
    .option('--full', 'Show full conversation without compression')
    .option('--since <n>', 'Show last N user/assistant exchanges', Number.parseInt)
    .option('--json', 'Output as JSON')
    .option('--raw', 'Output raw JSONL entries')
    .option('--log-file <path>', 'Direct path to log file (for testing)')
    .action(async (w: string, options: historyCmd.HistoryOptions) => {
      await historyCmd.historyCommand(w, options);
    });

  // agent answer — answer worker question
  agent
    .command('answer <worker> <choice>')
    .description('Answer a question for an agent (use "text:..." for text input)')
    .action(async (w: string, choice: string) => {
      await orchestrateCmd.answerQuestion(w, choice);
    });

  // agent events — stream Claude Code events
  agent
    .command('events [pane-id]')
    .description('Stream Claude Code events from a pane or all agents')
    .option('--json', 'Output events as JSON')
    .option('-f, --follow', 'Continuous tailing (like tail -f)')
    .option('-n, --lines <number>', 'Number of recent events to show (default: 20)', '20')
    .option('--emit', 'Write events to .genie/events/<pane-id>.jsonl while tailing')
    .option('--all', 'Aggregate events from all active agents')
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

  // agent close — close task and cleanup worker
  agent
    .command('close <task-id>')
    .description('Close task and cleanup agent')
    .option('--keep-worktree', "Don't remove the worktree")
    .option('--merge', 'Merge worktree changes to main branch')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (taskId: string, options: closeCmd.CloseOptions) => {
      await closeCmd.closeCommand(taskId, options);
    });

  // agent ship — mark done, merge, cleanup
  agent
    .command('ship <task-id>')
    .description('Mark task as done and cleanup agent')
    .option('--keep-worktree', "Don't remove the worktree")
    .option('--merge', 'Merge worktree changes to main branch')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (taskId: string, options: shipCmd.ShipOptions) => {
      await shipCmd.shipCommand(taskId, options);
    });

  // agent read — read worker pane output
  agent
    .command('read <target>')
    .description('Read terminal output from an agent pane')
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

  // agent exec — execute command in worker pane
  agent
    .command('exec <target> <command>')
    .description('Execute command in an agent pane')
    .option('-q, --quiet', 'Suppress output')
    .option('-t, --timeout <ms>', 'Timeout in milliseconds')
    .action(async (target: string, command: string, options: execCmd.ExecOptions) => {
      await execCmd.executeInSession(target, command, options);
    });
}
