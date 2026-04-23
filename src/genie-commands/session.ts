/**
 * Genie Session Command
 *
 * Session-per-folder: running `genie` from any folder creates/attaches
 * a tmux session named after that folder.
 *
 * Architecture:
 *   tmux session: "myapp"              <- named after basename(cwd)
 *     |-- Window 0: "myapp"            <- main window
 *     |-- Window 1: "api-server-c7b1"  <- disambiguated (same basename, different path)
 *     +-- Window 2: "myapp2"           <- genie run from ~/projects/myapp2
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import * as registry from '../lib/agent-registry.js';
import { reconcileStaleSpawns } from '../lib/agent-registry.js';
import {
  deleteNativeTeam,
  ensureNativeTeamWithSessionId,
  registerNativeMember,
  sanitizeTeamName,
} from '../lib/claude-native-teams.js';
import * as executorRegistry from '../lib/executor-registry.js';
import { buildTeamLeadCommand, shellQuote } from '../lib/team-lead-command.js';
import * as tmux from '../lib/tmux.js';
import { scaffoldAgentFiles } from '../templates/index.js';

/**
 * Generate a short 4-char hash of a path for disambiguation.
 */
function shortPathHash(p: string): string {
  return createHash('md5').update(p).digest('hex').slice(0, 4);
}

/**
 * Get the AGENTS.md file path if it exists in the current directory.
 * Returns the absolute file path, or null if not found.
 */
export function getAgentsFilePath(): string | null {
  const agentsPath = join(process.cwd(), 'AGENTS.md');
  if (existsSync(agentsPath)) {
    return agentsPath;
  }
  return null;
}

interface SessionOptions {
  reset?: boolean;
  name?: string;
  dir?: string;
  /** Team name -- when set, focus (or create) a dedicated window for this team. */
  team?: string;
}

/**
 * Pre-create the native team directory so CC starts as team-lead.
 *
 * Creates ~/.claude/teams/<name>/ with config.json + inboxes/team-lead.json.
 * The `leadSessionId` passed in is either (a) a UUID read from an existing
 * JSONL for this team name (resume path) or (b) a freshly-minted UUID that
 * will also be passed to CC via `--session-id` (new-session path). Either
 * way, the team config and the launched CC process reference the same
 * session ID from the first moment.
 *
 * CC recognizes itself as leader because --team-name is passed without --agent-id.
 *
 * See `.genie/wishes/fix-ghost-approval-p0/WISH.md` for the full story —
 * the predecessor of this function hardcoded `leadSessionId: "pending"`
 * with a comment falsely claiming "CC updates it internally once started".
 */
async function resolveSessionLeaderName(teamName: string): Promise<string> {
  try {
    const { resolveLeaderName } = await import('../lib/team-manager.js');
    return await resolveLeaderName(teamName);
  } catch {
    return teamName; // Fallback when DB is unavailable — never return 'team-lead'
  }
}

async function ensureNativeTeamForLeader(teamName: string, cwd: string, sessionId: string): Promise<void> {
  const leaderName = await resolveSessionLeaderName(teamName);
  // Upserts a stale leadSessionId (e.g. legacy "pending" literal) in place.
  await ensureNativeTeamWithSessionId(teamName, `Genie team: ${teamName}`, sessionId, leaderName);

  await registerNativeMember(teamName, {
    agentName: basename(cwd),
    agentType: leaderName,
    color: 'blue',
    cwd,
  });
}

/**
 * Build the claude launch command with native team flags.
 * Delegates to the shared buildTeamLeadCommand (single source of truth).
 *
 * `sessionId` is the CC session UUID. When `resume` is true, emits
 * `--resume <sessionId>`; otherwise `--session-id <sessionId>`. Name-based
 * resume was deleted — callers must always pass a UUID.
 */
export function buildClaudeCommand(
  teamName: string,
  systemPromptFile?: string,
  leaderName?: string,
  sessionId?: string,
  resume?: boolean,
): string {
  return buildTeamLeadCommand(teamName, { systemPromptFile, leaderName, sessionId, resume });
}

/**
 * Register the interactive genie session in `~/.genie/workers.json`.
 *
 * This allows spawned agents to resolve the team-lead for messaging
 * via the agent registry (e.g., for SendMessage bidirectional comms).
 */
async function registerSessionInRegistry(sessionName: string, windowName: string, workspaceDir: string): Promise<void> {
  try {
    const target = `${sessionName}:${windowName}`;
    const paneId = (await tmux.executeTmux(`display -t ${shellQuote(target)} -p '#{pane_id}'`)).trim();
    const now = new Date().toISOString();
    const sanitized = sanitizeTeamName(windowName);
    const leaderName = await resolveSessionLeaderName(windowName);
    const sanitizedLeader = sanitizeTeamName(leaderName);
    await registry.register({
      id: `${sanitized}-${sanitizedLeader}`,
      paneId,
      session: sessionName,
      team: windowName,
      role: leaderName,
      worktree: null,
      startedAt: now,
      state: 'working',
      lastStateChange: now,
      repoPath: workspaceDir,
      provider: 'claude',
      transport: 'tmux',
      nativeTeamEnabled: true,
      nativeAgentId: `${sanitizedLeader}@${sanitized}`,
    });

    // Executor model: create agent identity + executor for leader session
    const agentIdentity = await registry.findOrCreateAgent(leaderName, sanitized, leaderName);

    let pid: number | null = null;
    try {
      const pidStr = (await tmux.executeTmux(`display -t ${shellQuote(target)} -p '#{pane_pid}'`)).trim();
      const parsed = Number.parseInt(pidStr, 10);
      if (parsed > 0) pid = parsed;
    } catch {
      /* best-effort */
    }

    // Atomic: create executor + set as current in a single transaction.
    // state='running' because the team-lead IS the parent Claude Code process —
    // already alive at registration time. Initializing with 'spawning' would
    // leave the row stuck indefinitely (no transition callback ever fires for
    // the parent process itself). Regular workers go through spawnAgent which
    // does 'spawning'→'running' explicitly; team-leads do not.
    // Fixes #1184.
    await executorRegistry.createAndLinkExecutor(agentIdentity.id, 'claude', 'tmux', {
      pid,
      tmuxSession: sessionName,
      tmuxPaneId: paneId,
      tmuxWindow: windowName,
      state: 'running',
      repoPath: workspaceDir,
    });
  } catch {
    // Best-effort — don't block session startup if registration fails
  }
}

/**
 * Resolve the window name for the current working directory.
 *
 * Logic:
 * 1. Window name starts as basename(cwd)
 * 2. Check if a window with that name exists in the session
 * 3. If it exists, read GENIE_CWD env var for that window
 * 4. If GENIE_CWD matches current cwd -> reuse that window (return the name)
 * 5. If GENIE_CWD differs (collision) -> append 4-char hash to disambiguate
 * 6. If no window exists -> use the base name
 */
async function resolveWindowName(sessionName: string, cwd: string): Promise<string> {
  // Sanitize before lookup so collision detection matches what tmux actually stores.
  // Without this, dotted folders (e.g. "foo.bar") bypass disambiguation because
  // findWindowByName looks for "foo.bar" while the existing window is "foo-bar".
  const baseName = sanitizeWindowName(basename(cwd));
  const existing = await tmux.findWindowByName(sessionName, baseName);

  if (!existing) {
    // No window with this name exists, use the base name
    return baseName;
  }

  // Window exists — check if it's for the same cwd
  const storedCwd = await tmux.getWindowEnv(`${sessionName}:${baseName}`, 'GENIE_CWD');
  if (storedCwd === cwd) {
    // Same folder, reuse the window
    return baseName;
  }

  // Different folder with same basename — disambiguate with hash
  return `${baseName}-${shortPathHash(cwd)}`;
}

/**
 * Create the initial tmux session and its first window for the given folder.
 */
async function createSession(
  sessionName: string,
  windowName: string,
  workspaceDir: string,
  systemPromptFile: string | null,
  leaderName?: string,
): Promise<void> {
  // Mint a fresh Claude Code session UUID. Team-lead executor-reuse (resume
  // of the *same* UUID across respawns) is wired up in Group 5 of the
  // claude-resume-by-session-id wish, which queries the current executor row.
  // Until then, every fresh session starts clean.
  const sessionId = randomUUID();
  const shouldResume = false;
  await ensureNativeTeamForLeader(windowName, workspaceDir, sessionId);
  console.log(`Native team "${windowName}" ready at ~/.claude/teams/${sanitizeTeamName(windowName)}/`);

  console.log(`Creating session "${sessionName}"...`);
  const session = await tmux.createSession(sessionName);
  if (!session) {
    console.error(`Failed to create session "${sessionName}"`);
    process.exit(1);
  }

  // Get the initial window ID (respects user's base-index setting -- don't hardcode :0)
  const windows = await tmux.listWindows(sessionName);
  const firstWindow = windows[0];
  if (!firstWindow) {
    console.error(`Failed to find initial window in session "${sessionName}"`);
    process.exit(1);
  }

  // Name the first window after the folder and lock the name
  await tmux.executeTmux(`rename-window -t ${shellQuote(firstWindow.id)} ${shellQuote(windowName)}`);
  await tmux.executeTmux(`set-window-option -t ${shellQuote(firstWindow.id)} automatic-rename off`);

  // Store cwd as env var on the window
  await tmux.setWindowEnv(`${sessionName}:${windowName}`, 'GENIE_CWD', workspaceDir);

  const target = `${sessionName}:${windowName}`;
  const cdCmd = `cd ${shellQuote(workspaceDir)}`;
  await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);

  const agentName = basename(workspaceDir);
  const cmd = buildClaudeCommand(windowName, systemPromptFile || undefined, leaderName, sessionId, shouldResume);
  await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cmd)} Enter`);
  console.log(`Started Claude Code as ${agentName} in ${workspaceDir}`);

  // Guard: terminate old executor before spawning new one (prevents duplicates)
  try {
    const sanitized = sanitizeTeamName(windowName);
    const leaderName = await resolveSessionLeaderName(windowName);
    const agentIdentity = await registry.findOrCreateAgent(leaderName, sanitized, leaderName);
    await executorRegistry.terminateActiveExecutor(agentIdentity.id);
  } catch {
    // Best-effort — don't block session creation if guard fails
  }

  // Register interactive session so spawned agents can find the team-lead
  await registerSessionInRegistry(sessionName, windowName, workspaceDir);
}

/**
 * Launch Claude Code in a tmux pane.
 *
 * When `shouldResume` is true, launches with `--resume <sessionId>` and
 * verifies CC actually started (resume may silently fail if CC rejects the
 * UUID). On silent failure, mints a fresh UUID, upserts the team config,
 * and re-launches with `--session-id <newId>`.
 */
async function launchWithContinueFallback(
  target: string,
  windowName: string,
  workspaceDir: string,
  systemPromptFile: string | null,
  leaderName: string | undefined,
  sessionId: string,
  shouldResume: boolean,
): Promise<void> {
  const cmd = buildClaudeCommand(windowName, systemPromptFile || undefined, leaderName, sessionId, shouldResume);

  await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cmd)} Enter`);

  // Safety net: if --resume was attempted, verify CC actually started.
  if (shouldResume) {
    await new Promise((r) => setTimeout(r, 3000));
    const afterCmd = (await tmux.executeTmux(`display -t ${shellQuote(target)} -p '#{pane_current_command}'`)).trim();

    if (['bash', 'zsh', 'sh', 'fish'].includes(afterCmd)) {
      console.log('Resume failed unexpectedly, starting fresh session...');
      const freshId = randomUUID();
      await ensureNativeTeamForLeader(windowName, workspaceDir, freshId);
      const freshCmd = buildClaudeCommand(windowName, systemPromptFile || undefined, leaderName, freshId, false);
      await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(freshCmd)} Enter`);
    }
  }
}

/** Focus (or create) a team window within an existing session. */
async function focusTeamWindow(
  sessionName: string,
  windowName: string,
  workingDir: string,
  systemPromptFile: string | null,
  leaderName?: string,
): Promise<void> {
  const teamWindow = await tmux.ensureTeamWindow(sessionName, windowName, workingDir);
  if (teamWindow.created) {
    console.log(`Created team window "${windowName}"`);

    // Store cwd as env var on the window
    await tmux.setWindowEnv(`${sessionName}:${windowName}`, 'GENIE_CWD', workingDir);

    // Mint a fresh UUID (Group 5 will add executor-based resume).
    const sessionId = randomUUID();
    const shouldResume = false;
    await ensureNativeTeamForLeader(windowName, workingDir, sessionId);
    const target = `${sessionName}:${windowName}`;
    const cdCmd = `cd ${shellQuote(workingDir)}`;
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);

    await launchWithContinueFallback(
      target,
      windowName,
      workingDir,
      systemPromptFile,
      leaderName,
      sessionId,
      shouldResume,
    );
    console.log(`Started Claude Code as ${basename(workingDir)}@${sanitizeTeamName(windowName)} in ${workingDir}`);

    // Guard: terminate old executor before registering new one
    try {
      const sanitized = sanitizeTeamName(windowName);
      const leaderName = await resolveSessionLeaderName(windowName);
      const agentIdentity = await registry.findOrCreateAgent(leaderName, sanitized, leaderName);
      await executorRegistry.terminateActiveExecutor(agentIdentity.id);
    } catch {
      // Best-effort guard
    }

    // Register interactive session so spawned agents can find the team-lead
    await registerSessionInRegistry(sessionName, windowName, workingDir);
  } else {
    // Window exists — check if Claude Code is still running
    const target = `${sessionName}:${windowName}`;
    const currentCmd = (await tmux.executeTmux(`display -t ${shellQuote(target)} -p '#{pane_current_command}'`)).trim();

    const isShell = ['bash', 'zsh', 'sh', 'fish'].includes(currentCmd);
    if (isShell) {
      // Claude Code has exited — relaunch
      console.log(`Claude Code not running in "${windowName}", relaunching...`);
      const sessionId = randomUUID();
      const shouldResume = false;
      await ensureNativeTeamForLeader(windowName, workingDir, sessionId);

      const cdCmd = `cd ${shellQuote(workingDir)}`;
      await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);

      await launchWithContinueFallback(
        target,
        windowName,
        workingDir,
        systemPromptFile,
        leaderName,
        sessionId,
        shouldResume,
      );

      // Guard: terminate old executor before registering new one
      try {
        const sanitized = sanitizeTeamName(windowName);
        const leaderName = await resolveSessionLeaderName(windowName);
        const agentIdentity = await registry.findOrCreateAgent(leaderName, sanitized, leaderName);
        await executorRegistry.terminateActiveExecutor(agentIdentity.id);
      } catch {
        // Best-effort guard
      }

      await registerSessionInRegistry(sessionName, windowName, workingDir);
    }
    // else: Claude Code is still running — just select the window below
  }
  await tmux.executeTmux(`select-window -t ${shellQuote(`${sessionName}:${windowName}`)}`);
  console.log(`Focused team window "${windowName}"`);
}

/**
 * Sanitize a window name for tmux targeting.
 * tmux uses '.' as a pane separator in targets (session:window.pane),
 * so dots in window names cause "can't find pane" errors.
 */
export function sanitizeWindowName(name: string): string {
  return name.replace(/\./g, '-');
}

async function deriveWindowName(sessionName: string, workspaceDir: string, team?: string): Promise<string> {
  if (team) return sanitizeWindowName(team);
  const existingSession = await tmux.findSessionByName(sessionName);
  if (existingSession) return sanitizeWindowName(await resolveWindowName(sessionName, workspaceDir));
  return sanitizeWindowName(basename(workspaceDir));
}

async function handleReset(sessionName: string, windowName: string): Promise<void> {
  const existing = await tmux.findSessionByName(sessionName);
  if (existing) {
    // Collect all window names BEFORE killing the session
    const windows = await tmux.listWindows(existing.id);
    console.log(`Resetting session "${sessionName}"...`);
    await tmux.killSession(existing.id);
    // Delete native team dirs for ALL windows in the session
    await Promise.all(windows.map((w) => deleteNativeTeam(w.name)));
  } else {
    // Session not running — still clean up the current window's team dir
    await deleteNativeTeam(windowName);
  }
}

function attachToWindow(sessionName: string, windowName: string): void {
  console.log('Attaching...');
  const target = `${sessionName}:${windowName}`;
  const cmd = process.env.TMUX ? 'switch-client' : 'attach';
  const { genieTmuxPrefix } = require('../lib/tmux-wrapper.js');
  const { tmuxBin } = require('../lib/ensure-tmux.js');
  spawnSync(tmuxBin(), [...genieTmuxPrefix(), cmd, '-t', target], { stdio: 'inherit' });
}

/** Reconcile stale leadAgentId entries in native team configs. */
async function reconcileLeaderConfigs(): Promise<void> {
  try {
    const { readdirSync, readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { resolveLeaderName } = await import('../lib/team-manager.js');
    const teamsDir = join(process.env.HOME ?? '/root', '.claude', 'teams');
    const teams = readdirSync(teamsDir);
    for (const team of teams) {
      try {
        const configPath = join(teamsDir, team, 'config.json');
        const raw = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        if (config.leadAgentId?.startsWith('team-lead@')) {
          const actualLeader = await resolveLeaderName(team);
          const sanitized = sanitizeTeamName(team);
          config.leadAgentId = `${sanitizeTeamName(actualLeader)}@${sanitized}`;
          writeFileSync(configPath, JSON.stringify(config, null, 2));
          console.log(`[reconcile] Updated leadAgentId for team "${team}": ${config.leadAgentId}`);
        }
      } catch {
        /* skip individual team errors */
      }
    }
  } catch {
    /* teams dir doesn't exist yet or DB unavailable — best-effort */
  }
}

/**
 * Launch Claude Code inside an existing tmux pane (the "inside-tmux" path).
 *
 * Mints a fresh session UUID and launches with `--session-id` in a suffixed
 * window. Executor-based resume is wired up in Group 5 of the
 * claude-resume-by-session-id wish.
 */
async function launchInsideTmux(
  windowName: string,
  workspaceDir: string,
  systemPromptFile: string | null,
  leaderName?: string,
): Promise<void> {
  const sessionId = randomUUID();
  const suffix = Date.now().toString(36).slice(-4);
  const currentWindowName = `${windowName}-${suffix}`;
  await tmux.executeTmux(`rename-window ${shellQuote(currentWindowName)}`);
  await ensureNativeTeamForLeader(currentWindowName, workspaceDir, sessionId);
  const cmd = buildClaudeCommand(currentWindowName, systemPromptFile || undefined, leaderName, sessionId, false);
  const { execSync: execSyncCmd } = require('node:child_process');
  execSyncCmd(cmd, { stdio: 'inherit', cwd: workspaceDir });
}

export async function sessionCommand(options: SessionOptions = {}): Promise<void> {
  // One-shot startup reconciliation: reset agents stuck in 'spawning' with no pane for >60s
  await reconcileStaleSpawns();

  // Reconcile stale 'team-lead@' leadAgentId entries in native team configs
  await reconcileLeaderConfigs();

  const workspaceDir = options.dir ?? process.cwd();
  const sessionName = options.name ?? sanitizeWindowName(basename(workspaceDir));

  try {
    const windowName = await deriveWindowName(sessionName, workspaceDir, options.team);
    const leaderName = await resolveSessionLeaderName(windowName);

    if (options.reset) await handleReset(sessionName, windowName);

    const session = await tmux.findSessionByName(sessionName);
    let systemPromptFile = getAgentsFilePath();
    if (!systemPromptFile) {
      const shouldScaffold = await confirm({
        message: 'No agent found in this directory. Scaffold one?',
        default: true,
      });

      if (shouldScaffold) {
        scaffoldAgentFiles(workspaceDir);
        systemPromptFile = join(workspaceDir, 'AGENTS.md');
        console.log('Created SOUL.md, HEARTBEAT.md, and AGENTS.md');
      } else {
        console.error('AGENTS.md required. Run `genie` again to scaffold.');
        process.exit(1);
      }
    }

    if (!session) {
      await createSession(sessionName, windowName, workspaceDir, systemPromptFile, leaderName);
      attachToWindow(sessionName, windowName);
    } else if (process.env.TMUX) {
      // Already inside tmux — launch Claude Code in the CURRENT pane
      await launchInsideTmux(windowName, workspaceDir, systemPromptFile, leaderName);
    } else {
      // Outside tmux — attach to existing session
      console.log(`Session "${sessionName}" already exists`);
      await focusTeamWindow(sessionName, windowName, workspaceDir, systemPromptFile, leaderName);
      attachToWindow(sessionName, windowName);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
