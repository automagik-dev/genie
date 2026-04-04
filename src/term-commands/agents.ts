/**
 * Agent lifecycle — top-level command handlers.
 *
 * Exported handlers (registered in genie.ts as top-level commands):
 *   handleWorkerSpawn  - genie spawn <name>
 *   handleWorkerResume - genie resume <name> / genie resume --all
 *   handleWorkerKill   - genie kill <name>
 *   handleWorkerStop   - genie stop <name>
 *   handleLsCommand    - genie ls
 */

import * as directory from '../lib/agent-directory.js';
import * as registry from '../lib/agent-registry.js';
import { getActor, recordAuditEvent } from '../lib/audit.js';
import { resolveBuiltinAgentPath } from '../lib/builtin-agents.js';
import * as nativeTeams from '../lib/claude-native-teams.js';
import { OTEL_RELAY_PORT, ensureCodexOtelConfig } from '../lib/codex-config.js';
import { tmuxBin } from '../lib/ensure-tmux.js';
import * as executorRegistry from '../lib/executor-registry.js';
import type { TransportType as ExecutorTransport } from '../lib/executor-types.js';
import { buildLayoutCommand, resolveLayoutMode } from '../lib/mosaic-layout.js';
import { getOtelPort, startOtelReceiver } from '../lib/otel-receiver.js';
import { injectResumeContext } from '../lib/protocol-router-spawn.js';
import {
  type ClaudeTeamColor,
  type ProviderName,
  type SpawnParams,
  buildLaunchCommand,
  validateSpawnParams,
} from '../lib/provider-adapters.js';
import { getProvider } from '../lib/providers/registry.js';
import { waitForAgentReady } from '../lib/spawn-command.js';
import * as teamManager from '../lib/team-manager.js';
import { genieTmuxCmd } from '../lib/tmux-wrapper.js';
import * as tmux from '../lib/tmux.js';
import { executeTmux, isPaneAlive } from '../lib/tmux.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolve the leader name for a team from team config.
 * Never returns 'team-lead' — uses resolveLeaderName() which falls back to teamName.
 */
async function resolveTeamLeaderName(teamNameOrDefault: string): Promise<string> {
  return teamManager.resolveLeaderName(teamNameOrDefault);
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
  const leaderInboxName = nativeTeams.sanitizeTeamName(await resolveTeamLeaderName(team));
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

const TMUX_BIN = '${tmuxBin().replace(/\\/g, '\\\\').replace(/'/g, "\\'")}';
const RELAY_DIR = '${escapedRelayDir}';
const INBOX_DIR = '${escapedInboxDir}';
const INBOX = join(INBOX_DIR, '${leaderInboxName}.json');
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
      output = execSync(\`\${TMUX_BIN} -L genie capture-pane -p -t '\${paneId}' -S -80\`, { encoding: 'utf-8' }).trim();
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

// Reset in_progress groups assigned to a dead worker and notify team-lead (PG-backed)
async function handleDeadWorkerLiveness(workerId, meta) {
  if (!meta || !meta.repoPath) return;
  try {
    const wishState = await import('../lib/wish-state.js');
    // Try both workerId and agent name
    const match =
      (await wishState.findAnyGroupByAssignee(workerId, meta.repoPath)) ??
      (meta.agent ? await wishState.findAnyGroupByAssignee(meta.agent, meta.repoPath) : null);
    if (!match) return;

    await wishState.resetGroup(match.slug, match.groupName, meta.repoPath);
    const agentLabel = meta.agent || workerId;
    writeInbox(
      { agent: 'genie-relay', color: 'red' },
      'Agent ' + agentLabel + ' crashed while working on group ' + match.groupName + ' of wish ' + match.slug + '. Group has been reset to ready for retry.',
      '[crash] ' + agentLabel + ' crashed on ' + match.slug + '#' + match.groupName + '. Reset to ready.'
    );
  } catch {}
}

// Clean up dead panes every 30s
setInterval(async () => {
  let paneFiles;
  try { paneFiles = readdirSync(RELAY_DIR).filter(f => f.endsWith('-pane')); }
  catch { return; }
  for (const file of paneFiles) {
    try {
      const paneId = readFileSync(join(RELAY_DIR, file), 'utf-8').trim();
      if (!/^%\\d+$/.test(paneId)) throw new Error('invalid pane id');
      execSync(\`\${TMUX_BIN} -L genie display -t '\${paneId}' -p '#{pane_id}'\`, { stdio: 'ignore' });
    } catch {
      const workerId = file.replace(/-pane$/, '');
      // Read meta before cleanup (for liveness reset)
      let meta = null;
      try { meta = JSON.parse(readFileSync(join(RELAY_DIR, workerId + '-meta'), 'utf-8')); } catch {}
      for (const suffix of ['-pane', '-meta']) {
        try { unlinkSync(join(RELAY_DIR, workerId + suffix)); } catch {}
      }
      lastHashes.delete(workerId);
      workerFirstSeen.delete(workerId);
      bootstrapDone.delete(workerId);
      stoppedWorkers.add(workerId);
      // Liveness check: reset in_progress groups assigned to this dead worker
      await handleDeadWorkerLiveness(workerId, meta);
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
// Executor Model Helpers
// ============================================================================

/** Capture the PID of the process running in a tmux pane via #{pane_pid}. */
async function capturePanePid(paneId: string): Promise<number | null> {
  if (paneId === 'inline') return null;
  try {
    const { execSync } = require('node:child_process');
    const output = execSync(genieTmuxCmd(`display -t '${paneId}' -p '#{pane_pid}'`), { encoding: 'utf-8' }).trim();
    const pid = Number.parseInt(output, 10);
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Resolve the executor transport type from provider and spawn transport. */
function resolveExecutorTransport(provider: ProviderName, spawnTransport: 'tmux' | 'inline'): ExecutorTransport {
  if (provider === 'codex') return 'api';
  if (provider === 'claude-sdk') return 'process';
  return spawnTransport === 'inline' ? 'process' : 'tmux';
}

/**
 * Concurrent executor guard: terminate active executor before spawning new one.
 * Uses the provider's terminate() for process cleanup, then updates DB state.
 */
async function terminateActiveExecutorWithCleanup(agentIdentityId: string): Promise<void> {
  try {
    const currentExec = await executorRegistry.getCurrentExecutor(agentIdentityId);
    if (!currentExec || currentExec.state === 'terminated' || currentExec.state === 'done') return;

    const provider = getProvider(currentExec.provider);
    if (provider) {
      try {
        await provider.terminate(currentExec);
      } catch {
        /* best-effort process cleanup */
      }
    }
    await executorRegistry.terminateActiveExecutor(agentIdentityId);
  } catch {
    /* best-effort — don't block spawn if executor cleanup fails */
  }
}

/**
 * Create an executor record and link it as the agent's current executor.
 * Best-effort: executor tracking is additive, failure doesn't block spawn.
 */
async function createAndLinkExecutor(
  agentIdentityId: string,
  provider: ProviderName,
  transport: ExecutorTransport,
  opts: executorRegistry.CreateExecutorOpts,
): Promise<string | null> {
  try {
    const executor = await executorRegistry.createExecutor(agentIdentityId, provider, transport, opts);
    await registry.setCurrentExecutor(agentIdentityId, executor.id);
    return executor.id;
  } catch {
    return null;
  }
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
  /** When true, spawn into the current tmux window instead of resolving/creating a team window. */
  spawnIntoCurrentWindow: boolean;
  /** Explicit tmux session name override (from --session flag). */
  sessionOverride?: string;
  /** Auto-resume on pane death (default true, false disables). */
  autoResume?: boolean;
  /** Durable agent identity ID (from findOrCreateAgent). */
  agentIdentityId?: string;
  /** Pre-generated executor ID for the executor record. */
  executorId?: string;
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
    session: ctx.validated.team,
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
    // Resume tracking
    autoResume: ctx.autoResume === false ? false : undefined,
    resumeAttempts: 0,
  };
  await registry.register(workerEntry);

  // Auto-add to team config members (enables scope checks for genie send)
  // Skip 'council' — hireAgent has a special path that bulk-adds all council members
  const role = ctx.validated.role ?? ctx.agentName;
  if (role !== 'council') {
    try {
      await teamManager.hireAgent(ctx.validated.team, role);
    } catch {
      // Team may not exist in team-manager (e.g., native-only teams) — that's fine
    }
  }

  return workerEntry;
}

async function notifySpawnJoin(ctx: SpawnCtx, paneId: string): Promise<void> {
  const nt = ctx.validated.nativeTeam;

  // Only register native-team-enabled agents (Claude) as SendMessage recipients.
  // Non-native agents (Codex) can't read the Claude Code inbox, so registering them
  // causes SendMessage to silently succeed but never deliver (#777).
  if (!nt?.enabled) return;

  await nativeTeams.registerNativeMember(ctx.validated.team, {
    agentName: ctx.agentName,
    agentType: nt.agentType ?? ctx.validated.role ?? 'general-purpose',
    color: nt.color ?? ctx.spawnColor ?? 'blue',
    tmuxPaneId: paneId,
    cwd: ctx.cwd,
    planModeRequired: nt.planModeRequired,
  });
  // Resolve the actual leader name for the inbox notification
  const leaderName = await resolveTeamLeaderName(ctx.validated.team);
  await nativeTeams.writeNativeInbox(ctx.validated.team, leaderName, {
    from: ctx.agentName,
    text: `Worker ${ctx.agentName} (${ctx.validated.provider}) joined team ${ctx.validated.team}. cwd: ${ctx.cwd}. Ready for tasks.`,
    summary: `${ctx.agentName} (${ctx.validated.provider}) joined`,
    timestamp: new Date().toISOString(),
    color: nt.color ?? ctx.spawnColor ?? 'blue',
    read: false,
  });
}

function registerOtelRelayPane(
  workerId: string,
  paneId: string,
  agentName: string,
  spawnColor: string,
  repoPath?: string,
): void {
  const { writeFileSync: wfs } = require('node:fs');
  const { join: pjoin } = require('node:path');
  const { homedir: hdir } = require('node:os');
  const rd = pjoin(hdir(), '.genie', 'relay');
  wfs(pjoin(rd, `${workerId}-pane`), paneId);
  wfs(pjoin(rd, `${workerId}-meta`), JSON.stringify({ agent: agentName, color: spawnColor, repoPath }));
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

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Write a temporary launch script for complex tmux spawns.
 *
 * Native Claude team launches carry many quoted flags and prompt-file args. In
 * some shells that last outer-shell → tmux → inner-shell hop can mangle argv.
 * Executing a script path removes one parsing layer and keeps the worker launch
 * stable.
 */
function writeTmuxLaunchScript(workerId: string, fullCommand: string): string {
  const { chmodSync, mkdirSync, writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const { homedir } = require('node:os');

  const dir = join(homedir(), '.genie', 'spawn-scripts');
  mkdirSync(dir, { recursive: true });
  const safeId = workerId.replace(/[^a-zA-Z0-9._-]/g, '-');
  const scriptPath = join(dir, `${safeId}-${Date.now().toString(36)}.sh`);
  writeFileSync(scriptPath, `#!/bin/sh\nexec ${fullCommand}\n`, { mode: 0o700 });
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}

/**
 * Build the split-window command for the first agent in a newly created team window.
 *
 * Reusing the blank pane via send-keys corrupts long Claude commands with multiple
 * quoted args (notably QA prompts + prompt files). Spawning a real pane with the
 * exact same split-window path used elsewhere is more reliable; the blank pane is
 * removed afterwards.
 */
export function buildInitialSplitWindowCommand(windowId: string, cwd: string | undefined, fullCommand: string): string {
  const cwdFlag = cwd ? ` -c ${shellQuote(cwd)}` : '';
  return genieTmuxCmd(
    `split-window -d -t ${shellQuote(windowId)}${cwdFlag} -P -F '#{pane_id}' ${shellQuote(fullCommand)}`,
  );
}

/**
 * Resolve team window for spawn. Returns null if team is unset or resolution fails.
 *
 * Session resolution order:
 *   1. Explicit `sessionOverride` (from --tmux-session flag)
 *   2. Team config `tmuxSessionName` (stored during team create — source of truth)
 *   3. `resolveRepoSession(cwd)` (derive from repo path)
 *   4. Team name as session name (absolute last resort)
 */
async function resolveSpawnTeamWindow(
  team: string | undefined,
  cwd: string,
  sessionOverride?: string,
): Promise<TeamWindowInfo | null> {
  if (!team) return null;
  try {
    let sessionName = sessionOverride;
    if (!sessionName) {
      const teamConfig = await teamManager.getTeam(team);
      sessionName = teamConfig?.tmuxSessionName;
    }
    if (!sessionName) {
      sessionName = await tmux.resolveRepoSession(cwd);
    }
    if (!sessionName) {
      sessionName = team;
    }
    return await tmux.ensureTeamWindow(sessionName, team, cwd);
  } catch (err) {
    console.warn(`Warning: could not ensure team window for "${team}": ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Watch a tmux pane for Claude Code's workspace trust prompt and auto-confirm it.
 * Polls the pane content for up to 15s. If the trust prompt is detected, sends Enter.
 * If the session starts normally (no trust prompt), returns immediately.
 *
 * Workaround for: https://github.com/anthropics/claude-code/issues/36342
 * --dangerously-skip-permissions does not bypass the trust dialog.
 */
async function autoConfirmTrustPrompt(paneId: string): Promise<void> {
  const { execSync } = require('node:child_process');
  const maxWaitMs = 15000;
  const pollMs = 500;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollMs));

    let content: string;
    try {
      content = execSync(genieTmuxCmd(`capture-pane -t '${paneId}' -p`), { encoding: 'utf-8' });
    } catch {
      return; // Pane gone — nothing to do
    }

    // Trust prompt detected — send Enter to confirm "Yes, I trust this folder"
    if (content.includes('trust this folder') || content.includes('Quick safety check')) {
      try {
        execSync(genieTmuxCmd(`send-keys -t '${paneId}' Enter`), { encoding: 'utf-8' });
      } catch {
        // Best effort
      }
      return;
    }

    // Session already started — no trust prompt needed
    if (content.includes('Claude Code') || content.includes('❯') || content.includes('Churning')) {
      return;
    }
  }
  // Timeout — proceed anyway, agent may have started
}

/**
 * Create a tmux pane for the worker.
 *
 * First agent in a newly created team window reuses the blank pane via send-keys.
 * Subsequent agents split-window into the same team window.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing tmux pane routing logic, split targets and launch modes are interdependent
function createTmuxPane(ctx: SpawnCtx & { sessionOverride?: string }, teamWindow: TeamWindowInfo | null): string {
  const { execSync } = require('node:child_process');
  const useLaunchScript = ctx.validated.provider === 'claude' && Boolean(ctx.validated.nativeTeam?.enabled);
  const tmuxCommand = useLaunchScript
    ? shellQuote(writeTmuxLaunchScript(ctx.workerId, ctx.fullCommand))
    : shellQuote(ctx.fullCommand);

  const tmuxPrefix = genieTmuxCmd('');

  // --window: split into a specific tmux window target (e.g., "genie:3")
  if (ctx.validated.windowTarget) {
    const cwdFlag = ctx.cwd ? ` -c ${shellQuote(ctx.cwd)}` : '';
    const cmd = `${tmuxPrefix}split-window -d -t ${shellQuote(ctx.validated.windowTarget)}${cwdFlag} -P -F '#{pane_id}' ${tmuxCommand}`;
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  }

  // --new-window: create a dedicated window instead of splitting
  if (ctx.validated.newWindow) {
    const session = ctx.sessionOverride ?? teamWindow?.windowId?.split(':')[0] ?? ctx.validated.team;
    const cwdFlag = ctx.cwd ? ` -c ${shellQuote(ctx.cwd)}` : '';
    const cmd = `${tmuxPrefix}new-window -a -d -t ${shellQuote(`${session}:`)}${cwdFlag} -P -F '#{pane_id}' ${tmuxCommand}`;
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  }

  if (teamWindow?.created) {
    const cwdFlag = ctx.cwd ? ` -c ${shellQuote(ctx.cwd)}` : '';
    const paneId = execSync(
      `${tmuxPrefix}split-window -d -t ${shellQuote(teamWindow.windowId)}${cwdFlag} -P -F '#{pane_id}' ${tmuxCommand}`,
      {
        encoding: 'utf-8',
      },
    ).trim();
    try {
      execSync(genieTmuxCmd(`kill-pane -t '${teamWindow.paneId}'`), { stdio: 'ignore' });
    } catch {
      /* best-effort */
    }
    return paneId;
  }

  const splitTarget = teamWindow ? `-t '${teamWindow.windowId}'` : '';
  const cwdFlag = ctx.cwd ? `-c '${ctx.cwd}'` : '';
  if (useLaunchScript) {
    const splitCmd = `${tmuxPrefix}split-window -d ${splitTarget} ${cwdFlag} -P -F '#{pane_id}' ${tmuxCommand}`;
    return execSync(splitCmd, { encoding: 'utf-8' }).trim();
  }
  // Wrap fullCommand in shell quotes so it survives the outer-shell → tmux → inner-shell pipeline.
  // Without this, single quotes from escapeShellArg (e.g. around the initialPrompt) are consumed
  // by the outer shell, and tmux's inner shell sees unquoted args — splitting multi-word prompts.
  const escapedCmd = ctx.fullCommand.replace(/'/g, "'\\''");
  const splitCmd = `${tmuxPrefix}split-window -d ${splitTarget} ${cwdFlag} -P -F '#{pane_id}' '${escapedCmd}'`;
  return execSync(splitCmd, { encoding: 'utf-8' }).trim();
}

/** Apply mosaic layout to the team window (or first window in session as fallback). */
async function applySpawnLayout(ctx: SpawnCtx, teamWindow: TeamWindowInfo | null): Promise<void> {
  const { execSync } = require('node:child_process');
  const session = (await tmux.getCurrentSessionName()) ?? ctx.validated.team;
  let layoutTarget = `${session}:${teamWindow?.windowName ?? ''}`;
  if (!teamWindow) {
    const wins = await tmux.listWindows(session);
    layoutTarget = wins[0] ? wins[0].id : `${session}:`;
  }
  try {
    execSync(genieTmuxCmd(buildLayoutCommand(layoutTarget, ctx.layoutMode)), { stdio: 'ignore' });
  } catch {
    /* best-effort */
  }
}

// biome-ignore lint/suspicious/noExplicitAny: SpawnCtx + teamWindow types from complex internal types
async function createTmuxExecutor(ctx: SpawnCtx, paneId: string, pid: number | null, teamWindow: any): Promise<void> {
  if (!ctx.agentIdentityId || !ctx.executorId) return;
  await createAndLinkExecutor(
    ctx.agentIdentityId,
    ctx.validated.provider,
    resolveExecutorTransport(ctx.validated.provider, 'tmux'),
    {
      id: ctx.executorId,
      pid,
      tmuxSession: ctx.validated.team,
      tmuxPaneId: paneId,
      tmuxWindow: teamWindow?.windowName ?? null,
      tmuxWindowId: teamWindow?.windowId ?? null,
      claudeSessionId: ctx.claudeSessionId ?? null,
      state: 'spawning',
      repoPath: ctx.cwd,
      paneColor: ctx.spawnColor,
    },
  );
}

// biome-ignore lint/suspicious/noExplicitAny: worker entry type from registry
async function finalizeTmuxSpawn(ctx: SpawnCtx, paneId: string, teamWindow: any, workerEntry: any): Promise<void> {
  if (ctx.spawnColor && paneId !== 'inline') {
    await tmux.applyPaneColor(paneId, ctx.spawnColor, teamWindow?.windowId);
  }

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
  });

  if (ctx.otelRelayActive && paneId !== '%0') {
    registerOtelRelayPane(ctx.workerId, paneId, ctx.agentName, ctx.spawnColor, ctx.cwd);
  }

  if (teamWindow) {
    console.log(`  Window:   ${teamWindow.windowName} (${teamWindow.windowId})`);
  }
  printSpawnInfo(ctx, paneId, workerEntry);
}

async function awaitAgentReadiness(paneId: string): Promise<void> {
  if (paneId === 'inline') return;
  const result = await waitForAgentReady(paneId);
  if (result.ready) {
    console.log(`  ✓ Agent ready (${(result.elapsedMs / 1000).toFixed(1)}s)`);
  } else {
    console.log(`  ⚠ Agent readiness timeout (${Math.round(result.elapsedMs / 1000)}s) — proceeding anyway`);
  }
}

async function launchTmuxSpawn(ctx: SpawnCtx): Promise<string> {
  const teamWindow = ctx.spawnIntoCurrentWindow
    ? null
    : await resolveSpawnTeamWindow(ctx.validated.team, ctx.cwd, ctx.sessionOverride);

  let paneId: string;
  try {
    paneId = createTmuxPane(ctx, teamWindow);
  } catch (err) {
    console.error(`Failed to create tmux pane: ${err instanceof Error ? err.message : 'unknown error'}`);
    return process.exit(1) as never;
  }

  const pid = await capturePanePid(paneId);
  await createTmuxExecutor(ctx, paneId, pid, teamWindow);
  await applySpawnLayout(ctx, teamWindow);

  if (ctx.validated.provider === 'claude') {
    await autoConfirmTrustPrompt(paneId);
  }

  const workerEntry = await registerSpawnWorker(ctx, paneId, teamWindow);
  await notifySpawnJoin(ctx, paneId);
  await finalizeTmuxSpawn(ctx, paneId, teamWindow, workerEntry);

  await awaitAgentReadiness(paneId);

  // Transition executor + legacy worker from 'spawning' to 'running'
  if (ctx.executorId) {
    await executorRegistry.updateExecutorState(ctx.executorId, 'running').catch(() => {});
  }
  await registry.update(ctx.workerId, { state: 'idle' }).catch(() => {});

  return paneId;
}

// resolveSdkPermissions removed — use resolvePermissionConfig from claude-sdk-permissions

async function runSdkQuery(
  ctx: SpawnCtx,
  permConfig: { allow: string[]; bashAllowPatterns?: string[] },
): Promise<void> {
  const { ClaudeSdkProvider } = await import('../lib/providers/claude-sdk.js');
  const sdkProvider = new ClaudeSdkProvider();
  const spawnContext = {
    agentId: ctx.agentIdentityId ?? ctx.workerId,
    executorId: ctx.executorId ?? crypto.randomUUID(),
    team: ctx.validated.team,
    role: ctx.validated.role,
    skill: ctx.validated.skill,
    cwd: ctx.cwd,
    model: ctx.validated.model,
    systemPrompt: ctx.validated.systemPrompt,
    systemPromptFile: ctx.validated.systemPromptFile,
    initialPrompt: ctx.validated.initialPrompt,
    name: ctx.validated.name,
  };

  const prompt =
    ctx.validated.initialPrompt ??
    `You are ${ctx.validated.role ?? 'an agent'} on team "${ctx.validated.team}". Awaiting instructions.`;
  const { messages } = sdkProvider.runQuery(spawnContext, prompt, permConfig);

  if (ctx.executorId) {
    await executorRegistry.updateExecutorState(ctx.executorId, 'running').catch(() => {});
  }

  try {
    for await (const message of messages) {
      if (message.type === 'assistant' && message.message) {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text) process.stdout.write(block.text);
        }
      }
      if (message.type === 'result' && message.subtype === 'success' && message.result) {
        console.log(message.result);
      }
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === 'AbortError')) {
      console.error(`SDK query error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function launchSdkSpawn(
  ctx: SpawnCtx,
  permissionsConfig?: directory.DirectoryEntry['permissions'],
): Promise<string> {
  if (ctx.agentIdentityId && ctx.executorId) {
    await createAndLinkExecutor(ctx.agentIdentityId, 'claude-sdk' as ProviderName, 'process', {
      id: ctx.executorId,
      claudeSessionId: null,
      state: 'spawning',
      repoPath: ctx.cwd,
    });
  }

  await registerSpawnWorker(ctx, 'sdk');

  console.log(`Agent "${ctx.workerId}" starting via Claude Agent SDK...`);
  console.log(`  Provider: claude-sdk | Team: ${ctx.validated.team} | Role: ${ctx.validated.role ?? '-'}`);
  console.log('');

  const { resolvePermissionConfig } = await import('../lib/providers/claude-sdk-permissions.js');
  const permConfig = resolvePermissionConfig(permissionsConfig);
  await runSdkQuery(ctx, permConfig);

  if (ctx.executorId) {
    await executorRegistry.updateExecutorState(ctx.executorId, 'done').catch(() => {});
  }
  await registry.unregister(ctx.workerId);
  console.log(`\nAgent "${ctx.workerId}" SDK session ended.`);
  return ctx.workerId;
}

async function launchInlineSpawn(ctx: SpawnCtx): Promise<string> {
  const nt = ctx.validated.nativeTeam;
  const paneId = 'inline';

  // Executor model: create executor before blocking spawn
  if (ctx.agentIdentityId && ctx.executorId) {
    await createAndLinkExecutor(
      ctx.agentIdentityId,
      ctx.validated.provider,
      resolveExecutorTransport(ctx.validated.provider, 'inline'),
      {
        id: ctx.executorId,
        claudeSessionId: ctx.claudeSessionId ?? null,
        state: 'spawning',
        repoPath: ctx.cwd,
      },
    );
  }

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

  // Session ended — clean up executor + legacy registry
  if (ctx.agentIdentityId && ctx.executorId) {
    await executorRegistry.updateExecutorState(ctx.executorId, 'done').catch(() => {});
  }
  await registry.unregister(ctx.workerId);
  if (nt?.enabled && ctx.agentName) {
    await nativeTeams.clearNativeInbox(ctx.validated.team, ctx.agentName).catch(() => {});
    await nativeTeams.unregisterNativeMember(ctx.validated.team, ctx.agentName).catch(() => {});
  }
  console.log(`\nAgent "${ctx.workerId}" session ended.`);
  return process.exit(result.status ?? 0) as never;
}

function prependEnvVars(command: string, env?: Record<string, string>): string {
  if (!env || Object.keys(env).length === 0) return command;
  const envArgs = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return `env ${envArgs} ${command}`;
}

/**
 * Find a dead worker with a resumable Claude session for the given role/team.
 * Must run BEFORE rejectDuplicateRole which would unregister the dead worker
 * and lose the claudeSessionId needed for resume.
 */
async function findDeadResumable(team: string, role: string): Promise<registry.Agent | null> {
  const existing = await registry.list();
  const candidate = existing.find(
    (w) => w.role === role && w.team === team && w.claudeSessionId && w.provider === 'claude',
  );
  if (!candidate) return null;
  const alive = await isPaneAlive(candidate.paneId);
  return alive ? null : candidate;
}

/**
 * Reject spawn if a live worker with the same role already exists in the team.
 * Dead/suspended workers (pane gone) are auto-cleaned from registry — only live panes block.
 */
async function rejectDuplicateRole(team: string, role: string): Promise<void> {
  const existing = await registry.list();
  for (const w of existing) {
    if (w.role === role && w.team === team) {
      const alive = await isPaneAlive(w.paneId);
      // tmux recycles pane IDs — a pane may be "alive" but belong to a
      // completely different session now.  Verify the pane is still in the
      // expected session before blocking.
      if (alive && w.session) {
        const paneSession = await getPaneSession(w.paneId);
        if (paneSession !== w.session) {
          // Pane was recycled — treat as dead
          await registry.unregister(w.id);
          continue;
        }
        console.error(
          `Error: Worker with role "${role}" already exists in team "${team}" (state: ${w.state}, pane: ${w.paneId})\n` +
            `Use a different --role name for a second worker, e.g.: --role ${role}-2`,
        );
        process.exit(1);
      }
      // Dead worker with same role — clean up stale registry entry so spawn can proceed
      await registry.unregister(w.id);
    }
  }
}

/** Get the session name a pane belongs to, or null if unreachable. */
async function getPaneSession(paneId: string): Promise<string | null> {
  try {
    return (await executeTmux(`display-message -t '${paneId}' -p '#{session_name}'`)).trim() || null;
  } catch {
    return null;
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
    parentSessionId = (await nativeTeams.discoverClaudeParentSessionId()) ?? `genie-${team}`;
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
  provider?: string;
  team: string;
  model?: string;
  skill?: string;
  layout?: string;
  color?: string;
  planMode?: boolean;
  permissionMode?: string;
  extraArgs?: string[];
  cwd?: string;
  /** Initial prompt to send as the first user message. */
  initialPrompt?: string;
  /** CLI alias for initialPrompt (--prompt flag). */
  prompt?: string;
  /** Override the role name for registration and duplicate-check (agent directory still resolves by `name`). */
  role?: string;
  /** Explicit tmux session name to spawn into (overrides auto-detection). */
  session?: string;
  /** Auto-resume on pane death (default true, set to false by --no-auto-resume). */
  autoResume?: boolean;
  /** Create a new tmux window instead of splitting into an existing one. */
  newWindow?: boolean;
  /** Tmux window target to spawn into (e.g., "genie:3"). Splits into this exact window. */
  window?: string;
}

/** Resolve agent from directory, returning entry + derived CWD/identity/model/systemPromptFile. */
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
    console.error('  Or use a built-in: engineer, reviewer, qa, fix, ...');
    process.exit(1);
  }
  const entry = resolved.entry;

  // For built-in agents, resolve AGENTS.md file path from built-in registry.
  // For user agents, resolve from their registered directory.
  let identityPath: string | null = null;
  if (resolved.builtin) {
    identityPath = resolveBuiltinAgentPath(name);
  } else if (entry.dir) {
    identityPath = directory.loadIdentity(entry);
  }

  const repoPath = resolveAgentWorkingDir(entry, options.cwd);

  return {
    entry,
    repoPath,
    identityPath,
    model: options.model ?? entry.model,
  };
}

export function resolveAgentWorkingDir(entry: directory.DirectoryEntry, explicitCwd?: string): string {
  if (explicitCwd) return explicitCwd;
  if (entry.dir) return entry.dir;

  const repo = entry.repo;
  if (repo && require('node:fs').existsSync(repo)) {
    return repo;
  }

  return process.cwd();
}

/** Build SpawnParams from resolved agent + options. */
async function buildSpawnParams(
  name: string,
  team: string,
  options: SpawnOptions,
  agent: Awaited<ReturnType<typeof resolveAgentForSpawn>>,
): Promise<{ params: SpawnParams; parentSessionId: string; spawnColor: ClaudeTeamColor }> {
  // Provider resolution chain: CLI --provider > directory entry > default 'claude'
  const resolvedProvider = (options.provider ?? agent.entry.provider ?? 'claude') as ProviderName;

  const params: SpawnParams = {
    provider: resolvedProvider,
    team,
    role: name,
    skill: options.skill,
    extraArgs: options.extraArgs,
    model: agent.model,
    systemPromptFile: agent.identityPath ?? undefined,
    promptMode: agent.entry.promptMode,
    initialPrompt: options.initialPrompt,
    newWindow: options.newWindow,
    windowTarget: options.window,
  };

  const { parentSessionId, spawnColor, nativeTeam } = await resolveNativeTeam(team, agent.repoPath, {
    ...options,
    provider: resolvedProvider,
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

  // Generate a session ID for Claude workers so we can resume by ID later.
  // Stored in the agent registry on spawn for --resume on respawn.
  if (params.provider === 'claude') {
    params.sessionId = crypto.randomUUID();
  }

  // OTel telemetry injection for Claude workers.
  // Starts the OTel receiver lazily on first spawn, injects env vars via SpawnParams.
  // Codex agents use their own OTel relay (port 14318), so skip them.
  if (params.provider === 'claude') {
    const otelStarted = await startOtelReceiver();
    if (otelStarted) {
      params.otelPort = getOtelPort();
      params.otelLogPrompts = true;
    }
  }

  return { params, parentSessionId, spawnColor };
}

export async function handleWorkerSpawn(name: string, options: SpawnOptions): Promise<string> {
  // Effective role: suffixed name for registration/duplicate-check, original name for directory lookup
  const effectiveRole = options.role ?? name;

  // 1. Resolve agent from directory or built-ins (uses original name)
  let agent = await resolveAgentForSpawn(name, options);

  // 2. Resolve team (track whether it was explicitly provided via --team)
  const teamWasExplicit = Boolean(options.team);
  const team = options.team || (await nativeTeams.discoverTeamName());
  if (!team) {
    console.error('Error: --team is required (or set GENIE_TEAM, or run inside a genie session)');
    return process.exit(1) as never;
  }
  // Auto-resume: if a dead worker exists with a Claude session, resume instead of fresh spawn.
  const deadResumable = await findDeadResumable(team, effectiveRole);
  if (deadResumable) {
    console.log(
      `Resuming existing session for "${effectiveRole}" (session: ${deadResumable.claudeSessionId?.slice(0, 8)}...)`,
    );
    await resumeAgent(deadResumable);
    return deadResumable.id;
  }

  await rejectDuplicateRole(team, effectiveRole);

  // 2b. Override CWD with team worktree path if available.
  // Only override for agents without their own registered directory — sub-agents
  // (e.g. genie/brain-engineer at .genie/agents/brain-engineer/) need their own
  // CWD to avoid loading a parent agent's AGENTS.md via directory-tree walk.
  const teamConfig = await teamManager.getTeam(team);
  if (teamConfig?.worktreePath && !agent.entry?.dir) {
    agent = { ...agent, repoPath: teamConfig.worktreePath };
  }

  // 3. Build params
  const { params, parentSessionId, spawnColor } = await buildSpawnParams(effectiveRole, team, options, agent);

  // Set CC session display name if not already set
  if (!params.name) {
    params.name = `${params.team}-${effectiveRole}`;
  }
  const validated = validateSpawnParams(params);
  const launch = buildLaunchCommand(validated);
  const layoutMode = resolveLayoutMode(options.layout);
  const workerId = await generateWorkerId(validated.team, effectiveRole);

  // An explicit session target means "spawn in tmux" even when the caller is outside tmux.
  // This matters for orchestrators like QA, which need detached workers instead of a blocking inline session.
  const insideTmux = Boolean(process.env.TMUX || options.session);
  const nt = validated.nativeTeam;
  const now = new Date().toISOString();
  const agentName = nt?.agentName ?? effectiveRole;

  // Executor model: find/create durable agent identity + concurrent guard
  const agentIdentity = await registry.findOrCreateAgent(agentName, team, effectiveRole);
  await terminateActiveExecutorWithCleanup(agentIdentity.id);
  const executorId = crypto.randomUUID();

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
    claudeSessionId: validated.sessionId,
    otelRelayActive,
    now,
    transport: insideTmux ? 'tmux' : 'inline',
    extraArgs: options.extraArgs,
    cwd: agent.repoPath,
    spawnIntoCurrentWindow: !teamWasExplicit && insideTmux && !options.session,
    sessionOverride: options.session,
    autoResume: options.autoResume,
    agentIdentityId: agentIdentity.id,
    executorId,
  };

  // Audit event for worker spawn (fire-and-forget before launch returns)
  recordAuditEvent('worker', workerId, 'spawn', getActor(), {
    name,
    team: validated.team,
    provider: validated.provider,
  }).catch(() => {});

  // SDK provider: in-process query, no tmux/shell needed
  if (validated.provider === 'claude-sdk') {
    return await launchSdkSpawn(ctx, agent.entry.permissions);
  }

  if (insideTmux) {
    return await launchTmuxSpawn(ctx);
  }
  return await launchInlineSpawn(ctx);
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
    const currentPane = execSync(genieTmuxCmd("display-message -p '#{pane_id}'"), { encoding: 'utf-8' }).trim();
    const validPaneId = w.paneId && /^(%\d+|inline)$/.test(w.paneId);
    if (validPaneId && w.paneId !== currentPane) {
      execSync(genieTmuxCmd(`kill-pane -t ${w.paneId}`), { stdio: 'ignore' });
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
  console.error('  Run `genie agent list` to see agents.');
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

  await registry.unregister(w.id);
  console.log(`Agent "${w.id}" killed and unregistered (template preserved).`);

  // Audit event for worker kill
  recordAuditEvent('worker', w.id, 'kill', getActor(), { name }).catch(() => {});
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
    recordAuditEvent('worker', w.id, 'stop', getActor(), { name }).catch(() => {});
  } else {
    console.error(`Failed to stop agent "${w.id}".`);
    process.exit(1);
  }
}

/**
 * Check if an agent is eligible for resume.
 * Includes agents in working/idle/spawning states whose panes have died (crash recovery).
 */
async function isResumeEligible(w: registry.Agent): Promise<boolean> {
  if (!w.claudeSessionId) return false;
  if (w.state === 'done') return false;
  const paneAlive = await isPaneAlive(w.paneId);
  // Suspended/error agents with dead panes are always eligible
  if ((w.state === 'suspended' || w.state === 'error') && !paneAlive) return true;
  // Working/idle/spawning agents whose panes died (crash) are also eligible
  if (!paneAlive && (w.state === 'working' || w.state === 'idle' || w.state === 'spawning')) return true;
  return false;
}

/** Resume all eligible agents (--all mode). */
async function resumeAllAgents(): Promise<void> {
  const workers = await registry.list();
  const toResume: registry.Agent[] = [];
  for (const w of workers) {
    if (await isResumeEligible(w)) toResume.push(w);
  }

  if (toResume.length === 0) {
    console.log('No eligible agents to resume.');
    return;
  }

  console.log(`Resuming ${toResume.length} agent(s)...`);
  for (const w of toResume) {
    try {
      await resumeAgent(w);
    } catch (err) {
      console.error(`  Failed to resume "${w.id}": ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * genie resume <name> — Resume a suspended/failed agent with its Claude session.
 * genie resume --all  — Resume all eligible agents.
 */
export async function handleWorkerResume(name: string | undefined, options: { all?: boolean }): Promise<void> {
  if (options.all) return resumeAllAgents();

  if (!name) {
    console.error('Error: provide an agent name, or use --all to resume all eligible agents.');
    process.exit(1);
  }

  const w = await resolveWorkerByName(name);

  if (!w.claudeSessionId) {
    console.error(`Error: Agent "${w.id}" has no Claude session ID — cannot resume.`);
    console.error('  Only agents spawned with the Claude provider have resumable sessions.');
    process.exit(1);
  }

  if (await isPaneAlive(w.paneId)) {
    console.log(`Agent "${w.id}" is already running (pane ${w.paneId} is alive).`);
    return;
  }

  await resumeAgent(w);
}

/** Build SpawnParams for a resume operation from agent + template. */
async function buildResumeParams(
  agent: registry.Agent,
  template: registry.WorkerTemplate | undefined,
): Promise<SpawnParams> {
  const agentName = agent.role ?? agent.id;
  const provider = (template?.provider ?? agent.provider ?? 'claude') as ProviderName;
  const team = template?.team ?? agent.team ?? 'genie';

  // Restore identity file on resume so the agent keeps its AGENTS.md identity
  // instead of falling back to CWD-based discovery (which walks up and may find
  // a parent agent's AGENTS.md — e.g. sub-agents loading the root genie identity).
  let systemPromptFile: string | undefined;
  let promptMode: SpawnParams['promptMode'];
  const dirEntry = await directory.get(agentName);
  if (dirEntry?.dir) {
    systemPromptFile = directory.loadIdentity(dirEntry) ?? undefined;
    promptMode = dirEntry.promptMode;
  }

  return {
    provider,
    team,
    role: agentName,
    skill: template?.skill ?? agent.skill,
    extraArgs: template?.extraArgs,
    // biome-ignore lint/style/noNonNullAssertion: caller guarantees claudeSessionId exists
    resume: agent.claudeSessionId!,
    name: `${team}-${agentName}`,
    model: dirEntry?.model,
    systemPromptFile,
    promptMode,
  };
}

/** Format a single group's status line for resume context. */
function formatGroupStatus(
  name: string,
  group: { status: string; startedAt?: string; completedAt?: string; dependsOn: string[] },
  allGroups: Record<string, { status: string }>,
): string {
  let detail = group.status;
  if (group.completedAt) detail += ` (completed at ${group.completedAt})`;
  else if (group.startedAt) detail += ` (started at ${group.startedAt})`;
  if (group.status === 'blocked' && group.dependsOn.length > 0) {
    const pending = group.dependsOn.filter((dep) => allGroups[dep]?.status !== 'done');
    if (pending.length > 0) detail += ` (depends on ${pending.join(', ')})`;
  }
  return `Group ${name}: ${detail}`;
}

/**
 * Build resume context for an agent being resumed.
 * For team-leads with wish context: detailed group status summary.
 * For other agents with team context: simple "you were resumed" message.
 * Returns undefined if no wish context found.
 */
export async function buildResumeContext(agent: registry.Agent): Promise<string | undefined> {
  // Check if this agent is a leader (by role 'team-lead' or matching the team's leader name)
  const isLeader =
    agent.role === 'team-lead' || (agent.team && agent.role === (await resolveTeamLeaderName(agent.team)));
  if (isLeader && agent.wishSlug) {
    try {
      const wishState = await import('../lib/wish-state.js');
      const state = await wishState.getState(agent.wishSlug, agent.repoPath);
      if (state) {
        const groupLines = Object.entries(state.groups).map(([name, group]) =>
          formatGroupStatus(name, group, state.groups),
        );
        return [
          "You were resumed after a crash. Here's where you left off:",
          `Wish: ${state.wish}`,
          '',
          ...groupLines,
          '',
          `Continue from where you left off. Run \`genie status ${state.wish}\` to verify, then dispatch the next wave.`,
        ].join('\n');
      }
    } catch {
      // Fall through to simple message if wish state lookup fails
    }
  }

  if (agent.team) {
    return "You were resumed. Check your team's current state with `genie status`.";
  }

  return undefined;
}

/** Build full spawn params for resume, including initial prompt and native team config. */
async function buildFullResumeParams(
  agent: registry.Agent,
  template: registry.WorkerTemplate | undefined,
): Promise<SpawnParams> {
  const params = await buildResumeParams(agent, template);

  const resumeContext = await buildResumeContext(agent);
  if (resumeContext) {
    params.initialPrompt = resumeContext;
  }

  if (agent.nativeTeamEnabled) {
    const nativeResult = await resolveNativeTeam(params.team, agent.repoPath, {
      provider: params.provider,
      role: params.role,
      color: agent.nativeColor,
    });
    if (nativeResult.nativeTeam) params.nativeTeam = nativeResult.nativeTeam;
  }

  return params;
}

/** Resolve executor identity and create executor record for a resume pane. */
async function createResumeExecutor(
  agent: registry.Agent,
  params: SpawnParams,
  paneId: string,
  teamWindow: { windowName: string; windowId: string } | null,
  cwd: string,
  spawnColor: string,
): Promise<void> {
  const resumeAgentName = agent.role ?? agent.id;
  const resumeTeam = agent.team ?? params.team;
  const agentIdentity = await registry.findOrCreateAgent(resumeAgentName, resumeTeam, agent.role);
  await terminateActiveExecutorWithCleanup(agentIdentity.id);

  const pid = await capturePanePid(paneId);
  await createAndLinkExecutor(agentIdentity.id, params.provider, resolveExecutorTransport(params.provider, 'tmux'), {
    pid,
    tmuxSession: params.team,
    tmuxPaneId: paneId,
    tmuxWindow: teamWindow?.windowName ?? null,
    tmuxWindowId: teamWindow?.windowId ?? null,
    claudeSessionId: agent.claudeSessionId ?? null,
    state: 'spawning',
    repoPath: cwd,
    paneColor: spawnColor,
  });
}

/**
 * Resume a single agent by rebuilding spawn params with --resume <sessionId>.
 * Resets resumeAttempts to 0 (manual resume = fresh retry budget).
 */
async function resumeAgent(agent: registry.Agent): Promise<void> {
  const template = (await registry.listTemplates()).find((t) => t.id === (agent.role ?? agent.id));

  await registry.update(agent.id, { resumeAttempts: 0 });

  const params = await buildFullResumeParams(agent, template);

  const validated = validateSpawnParams(params);
  const launch = buildLaunchCommand(validated);
  const fullCommand = prependEnvVars(launch.command, launch.env);
  const now = new Date().toISOString();

  if (!process.env.TMUX) {
    console.error('Error: resume requires tmux. Start a tmux session first.');
    process.exit(1);
  }

  const ctx: SpawnCtx = {
    workerId: agent.id,
    validated,
    launch,
    layoutMode: resolveLayoutMode(undefined),
    fullCommand,
    agentName: agent.role ?? agent.id,
    spawnColor: agent.nativeColor ?? 'blue',
    parentSessionId: agent.parentSessionId ?? `genie-${params.team}`,
    claudeSessionId: agent.claudeSessionId,
    otelRelayActive: false,
    now,
    transport: 'tmux',
    extraArgs: template?.extraArgs,
    cwd: template?.cwd ?? agent.repoPath,
    spawnIntoCurrentWindow: false,
    autoResume: agent.autoResume,
  };

  const teamWindow = await resolveSpawnTeamWindow(validated.team, ctx.cwd);

  let paneId: string;
  try {
    paneId = createTmuxPane(ctx, teamWindow);
  } catch (err) {
    console.error(`Failed to create tmux pane: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  }

  // Executor model: create new executor for resumed session
  await createResumeExecutor(agent, validated, paneId, teamWindow, ctx.cwd, ctx.spawnColor);

  await applySpawnLayout(ctx, teamWindow);

  await registry.update(agent.id, {
    paneId,
    state: 'spawning',
    startedAt: now,
    lastStateChange: now,
    suspendedAt: undefined,
    windowName: teamWindow?.windowName,
    windowId: teamWindow?.windowId,
    window: teamWindow?.windowName,
  });

  await notifySpawnJoin(ctx, paneId);

  // Inject resume context so the agent knows what wish/group it was working on
  await injectResumeContext(ctx.cwd ?? agent.repoPath ?? process.cwd(), agent.id, agent.role ?? agent.id, params.team);

  if (ctx.spawnColor && paneId !== 'inline') {
    await tmux.applyPaneColor(paneId, ctx.spawnColor, teamWindow?.windowId);
  }

  recordAuditEvent('worker', agent.id, 'resumed', getActor(), {
    claudeSessionId: agent.claudeSessionId,
    team: agent.team,
  }).catch(() => {});

  console.log(`Agent "${agent.id}" resumed.`);
  console.log(`  Session:  ${agent.claudeSessionId}`);
  console.log(`  Pane:     ${paneId}`);
  if (teamWindow) {
    console.log(`  Window:   ${teamWindow.windowName} (${teamWindow.windowId})`);
  }
}

type WorkerStatus = {
  state: string;
  team: string;
  resumeAttempts?: number;
  maxResumeAttempts?: number;
  autoResume?: boolean;
};

/** Build a name → status map from registry workers, including resume info for dead agents. */
async function buildWorkerStatusMap(workers: registry.Agent[]): Promise<Map<string, WorkerStatus>> {
  const statusMap = new Map<string, WorkerStatus>();
  for (const w of workers) {
    const name = w.role || w.id;
    const alive = await isPaneAlive(w.paneId);
    if (alive) {
      statusMap.set(name, { state: w.state, team: w.team || '-' });
    } else if (w.state === 'suspended' || w.state === 'error') {
      const attempts = w.resumeAttempts ?? 0;
      const max = w.maxResumeAttempts ?? 3;
      const autoStr = w.autoResume === false ? 'off' : 'on';
      statusMap.set(name, {
        state: `${w.state} (${attempts}/${max} resumes, auto-resume: ${autoStr})`,
        team: w.team || '-',
        resumeAttempts: attempts,
        maxResumeAttempts: max,
        autoResume: w.autoResume !== false,
      });
    }
  }
  return statusMap;
}

/**
 * genie ls — Smart view of registered agents with runtime status.
 */
export async function handleLsCommand(options: { json?: boolean }): Promise<void> {
  const dirEntries = await directory.ls();
  const workers = await registry.list();
  const statusMap = await buildWorkerStatusMap(workers);

  type LsEntry = {
    name: string;
    dir: string;
    status: string;
    team: string;
    model: string;
    resumeAttempts?: number;
    maxResumeAttempts?: number;
    autoResume?: boolean;
  };
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
      resumeAttempts: running?.resumeAttempts,
      maxResumeAttempts: running?.maxResumeAttempts,
      autoResume: running?.autoResume,
    });
    statusMap.delete(entry.name);
  }

  // Add built-in agents not in the directory (alive or suspended/error)
  for (const [name, info] of statusMap) {
    entries.push({
      name,
      dir: '(built-in)',
      status: info.state,
      team: info.team,
      model: '-',
      resumeAttempts: info.resumeAttempts,
      maxResumeAttempts: info.maxResumeAttempts,
      autoResume: info.autoResume,
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
  console.log('-'.repeat(106));
  for (const e of entries) {
    console.log(formatLsRow(e.name, e.dir, e.status, e.team, e.model));
  }
  console.log('');
}

function formatLsRow(name: string, dir: string, status: string, team: string, model: string): string {
  return `${name.padEnd(20).substring(0, 20)}${dir.padEnd(30).substring(0, 30)}${status.padEnd(44).substring(0, 44)}${team.padEnd(12).substring(0, 12)}${model}`;
}
