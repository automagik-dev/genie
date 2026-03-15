/**
 * Agent lifecycle — top-level command handlers.
 *
 * Exported handlers (registered in genie.ts as top-level commands):
 *   handleWorkerSpawn  - genie spawn <name>
 *   handleWorkerKill   - genie kill <name>
 *   handleWorkerStop   - genie stop <name>
 *   handleLsCommand    - genie ls
 */

import * as directory from '../lib/agent-directory.js';
import * as registry from '../lib/agent-registry.js';
import { getBuiltin } from '../lib/builtin-agents.js';
import * as nativeTeams from '../lib/claude-native-teams.js';
import { OTEL_RELAY_PORT, ensureCodexOtelConfig } from '../lib/codex-config.js';
import { buildLayoutCommand, resolveLayoutMode } from '../lib/mosaic-layout.js';
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

// ============================================================================
// Helper Functions
// ============================================================================

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

// ============================================================================
// Helper: Generate Worker ID (teams)
// ============================================================================

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
    // When first agent spawns into a newly created team window, use send-keys
    // to run the command in the existing (blank) pane — no split-window needed.
    // Only split-window for 2nd+ agent in the same window.
    if (teamWindow?.created) {
      // Get the existing pane ID from the newly created window
      paneId = execSync(`tmux list-panes -t '${teamWindow.windowId}' -F '#{pane_id}'`, { encoding: 'utf-8' }).trim().split('\n')[0];
      // cd into the working directory and run the command
      if (ctx.cwd) {
        execSync(`tmux send-keys -t '${paneId}' 'cd ${ctx.cwd.replace(/'/g, "'\\''")}' Enter`, { encoding: 'utf-8' });
      }
      execSync(`tmux send-keys -t '${paneId}' '${ctx.fullCommand.replace(/'/g, "'\\''")}' Enter`, { encoding: 'utf-8' });
    } else {
      const cwdFlag = ctx.cwd ? `-c '${ctx.cwd}'` : '';
      const splitCmd = `tmux split-window -d ${splitTarget} ${cwdFlag} -P -F '#{pane_id}' ${ctx.fullCommand}`;
      paneId = execSync(splitCmd, { encoding: 'utf-8' }).trim();
    }
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
  _repoPath: string,
  options: { provider: string; role?: string; color?: string; planMode?: boolean; permissionMode?: string },
): Promise<{ parentSessionId: string; spawnColor: ClaudeTeamColor; nativeTeam?: SpawnParams['nativeTeam'] }> {
  const teamConfig = await teamManager.getTeam(team);
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

export interface SpawnOptions {
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
  /** Initial prompt to send as the first user message (Claude Code positional [prompt] arg). */
  initialPrompt?: string;
}

/** Resolve agent from directory, returning entry + derived CWD/identity/model/systemPrompt. */
async function resolveAgentForSpawn(
  name: string,
  options: SpawnOptions,
): Promise<{
  entry: directory.DirectoryEntry;
  repoPath: string;
  identityPath: string | null;
  model: string | undefined;
  systemPrompt: string | undefined;
}> {
  const resolved = await directory.resolve(name);
  if (!resolved) {
    console.error(`Error: Agent "${name}" not found in directory or built-ins.`);
    console.error(`  Register with: genie dir add ${name} --dir <path>`);
    console.error('  Or use a built-in: engineer, reviewer, qa, fix, ...');
    process.exit(1);
  }
  const entry = resolved.entry;

  // For built-in agents, look up their inline system prompt
  let systemPrompt: string | undefined;
  if (resolved.builtin) {
    const builtin = getBuiltin(name);
    systemPrompt = builtin?.systemPrompt;
  }

  return {
    entry,
    repoPath: options.cwd ?? (entry.dir || undefined) ?? process.cwd(),
    identityPath: entry.dir ? directory.loadIdentity(entry) : null,
    model: options.model ?? entry.model,
    systemPrompt,
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
    systemPrompt: agent.systemPrompt,
    promptMode: agent.entry.promptMode,
    initialPrompt: options.initialPrompt,
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

export async function handleWorkerSpawn(name: string, options: SpawnOptions): Promise<void> {
  // 1. Resolve agent from directory or built-ins
  let agent = await resolveAgentForSpawn(name, options);

  // 2. Resolve team
  const team = options.team || (await nativeTeams.discoverTeamName());
  if (!team) {
    console.error('Error: --team is required (or set GENIE_TEAM, or run inside a genie session)');
    process.exit(1);
  }
  await rejectDuplicateRole(team, name);

  // 2b. Override CWD with team worktree path if available
  const teamConfig = await teamManager.getTeam(team);
  if (teamConfig?.worktreePath) {
    agent = { ...agent, repoPath: teamConfig.worktreePath };
  }

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
// Kill helpers
// ============================================================================

/** Clean up a worker's native team registration. */
async function cleanupWorkerNativeTeam(w: registry.Agent): Promise<void> {
  if (!w.team || !w.nativeAgentId) return;
  const agentName = w.nativeAgentId.split('@')[0];
  await nativeTeams.clearNativeInbox(w.team, agentName).catch(() => {});
  await nativeTeams.unregisterNativeMember(w.team, agentName).catch(() => {});
}

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
// Name resolution — resolve agent name to running worker
// ============================================================================

/** Resolve an agent name to a running worker entry. */
async function resolveWorkerByName(name: string): Promise<registry.Agent> {
  // Try exact ID match
  const exact = await registry.get(name);
  if (exact) return exact;

  const workers = await registry.list();

  // Try matching by role
  const byRole = workers.filter((w) => w.role === name);
  if (byRole.length === 1) return byRole[0];
  if (byRole.length > 1) {
    console.error(`Multiple agents with role "${name}". Specify full ID:`);
    for (const w of byRole) console.error(`  ${w.id} (team: ${w.team})`);
    process.exit(1);
  }

  // Try matching by ID suffix (e.g., "implementor" matches "genie-implementor")
  const bySuffix = workers.filter((w) => w.id.endsWith(`-${name}`));
  if (bySuffix.length === 1) return bySuffix[0];
  if (bySuffix.length > 1) {
    console.error(`Multiple agents matching "${name}". Specify full ID:`);
    for (const w of bySuffix) console.error(`  ${w.id}`);
    process.exit(1);
  }

  console.error(`Agent "${name}" not found.`);
  console.error('  Run `genie ls` to see agents.');
  process.exit(1);
}

// ============================================================================
// Exported top-level command handlers
// ============================================================================

/**
 * genie kill <name> — Force kill an agent by name.
 */
export async function handleWorkerKill(name: string): Promise<void> {
  const w = await resolveWorkerByName(name);

  killWorkerPane(w);
  cleanupRelayFiles(w.id);
  await cleanupWorkerNativeTeam(w);

  // Save last session ID into template before unregistering so
  // ensureWorkerAlive can resume with --resume on next message.
  if (w.claudeSessionId) {
    const templates = await registry.listTemplates();
    const tmpl = templates.find((t) => t.id === w.id || t.id === w.role || t.role === w.role);
    if (tmpl) {
      await registry.saveTemplate({ ...tmpl, lastSessionId: w.claudeSessionId });
    }
  }

  await registry.unregister(w.id);
  console.log(`Agent "${w.id}" killed and unregistered (template preserved).`);
}

/**
 * genie stop <name> — Stop an agent (kill pane, preserve session for resume).
 */
export async function handleWorkerStop(name: string): Promise<void> {
  const w = await resolveWorkerByName(name);

  if (w.state === 'suspended') {
    console.log(`Agent "${w.id}" is already stopped.`);
    return;
  }

  const { suspendWorker } = await import('../lib/idle-timeout.js');
  const ok = await suspendWorker(w.id);
  if (ok) {
    console.log(`Agent "${w.id}" stopped.`);
    if (w.claudeSessionId) {
      console.log(`  Session preserved: ${w.claudeSessionId}`);
    }
    console.log(`  Send a message to auto-resume: genie send '...' --to ${w.id}`);
  } else {
    console.error(`Failed to stop agent "${w.id}".`);
    process.exit(1);
  }
}

/**
 * genie ls — Smart view of registered agents with runtime status.
 */
export async function handleLsCommand(options: { json?: boolean }): Promise<void> {
  const dirEntries = await directory.ls();
  const workers = await registry.list();

  // Build status map: name → running worker info
  const statusMap = new Map<string, { state: string; team: string }>();
  for (const w of workers) {
    const name = w.role || w.id;
    const alive = await isPaneAlive(w.paneId);
    if (alive) {
      statusMap.set(name, { state: w.state, team: w.team || '-' });
    }
  }

  type LsEntry = { name: string; dir: string; status: string; team: string; model: string };
  const entries: LsEntry[] = [];

  // Add directory entries with runtime status
  for (const entry of dirEntries) {
    const running = statusMap.get(entry.name);
    entries.push({
      name: entry.name,
      dir: entry.dir || '-',
      status: running ? running.state : 'offline',
      team: running?.team || '-',
      model: entry.model || '-',
    });
    statusMap.delete(entry.name);
  }

  // Add running built-in agents not in the directory
  for (const [name, info] of statusMap) {
    entries.push({
      name,
      dir: '(built-in)',
      status: info.state,
      team: info.team,
      model: '-',
    });
  }

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log('No agents registered. Use `genie dir add <name> --dir <path>` to register one.');
    return;
  }

  console.log('');
  console.log(formatLsRow('NAME', 'DIR', 'STATUS', 'TEAM', 'MODEL'));
  console.log('-'.repeat(94));
  for (const e of entries) {
    console.log(formatLsRow(e.name, e.dir, e.status, e.team, e.model));
  }
  console.log('');
}

function formatLsRow(name: string, dir: string, status: string, team: string, model: string): string {
  return `${name.padEnd(20).substring(0, 20)}${dir.padEnd(40).substring(0, 40)}${status.padEnd(12).substring(0, 12)}${team.padEnd(12).substring(0, 12)}${model}`;
}
