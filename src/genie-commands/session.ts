/**
 * Genie Session Command
 *
 * Per-project sessions: running `genie` from any folder creates/attaches
 * a tmux session named after that project directory.
 *
 * Architecture:
 *   tmux session: "myapp"              <- genie run from ~/projects/myapp
 *     |-- Window 0: "myapp"            <- team-lead window
 *     +-- Window 1: "feat/auth"        <- team window
 *
 *   tmux session: "api-server"         <- genie run from ~/projects/api-server
 *     |-- Window 0: "api-server"       <- team-lead window
 *     +-- Window 1: "fix/bug"          <- team window
 *
 * Session name = sanitized basename(cwd) with hash disambiguation.
 * Two projects with same basename in different dirs get unique names:
 *   /home/user/project-a  -> session "project-a"
 *   /tmp/project-a        -> session "project-a-c7b1"
 *
 * GENIE_SESSION env var is set on every window so spawned agents
 * know which session they belong to.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as registry from '../lib/agent-registry.js';
import {
  deleteNativeTeam,
  ensureNativeTeam,
  registerNativeMember,
  sanitizeTeamName,
} from '../lib/claude-native-teams.js';
import { buildTeamLeadCommand, shellQuote } from '../lib/team-lead-command.js';
import * as tmux from '../lib/tmux.js';

/**
 * Generate a short 4-char hash of a path for disambiguation.
 */
function shortPathHash(p: string): string {
  return createHash('md5').update(p).digest('hex').slice(0, 4);
}

/**
 * Resolve the tmux session name for the given working directory.
 *
 * Logic:
 * 1. Session name starts as sanitizeWindowName(basename(cwd))
 * 2. Check if a session with that name already exists
 * 3. If it exists, read GENIE_CWD env var from the session
 * 4. If GENIE_CWD matches current cwd -> reuse that session
 * 5. If GENIE_CWD differs (collision) -> append 4-char hash to disambiguate
 * 6. If no session exists -> use the base name
 */
export async function resolveSessionName(cwd: string): Promise<string> {
  const baseName = sanitizeWindowName(basename(cwd));
  const existing = await tmux.findSessionByName(baseName);

  if (!existing) {
    return baseName;
  }

  // Session exists — check if it's for the same cwd
  const storedCwd = await tmux.getWindowEnv(baseName, 'GENIE_CWD');
  if (storedCwd === cwd) {
    return baseName;
  }

  // Different folder with same basename — disambiguate with hash
  return `${baseName}-${shortPathHash(cwd)}`;
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

export interface SessionOptions {
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
 * The leadSessionId is a placeholder -- CC updates it internally once started.
 * CC recognizes itself as leader because --team-name is passed without --agent-id.
 */
async function ensureNativeTeamForLeader(teamName: string, cwd: string): Promise<void> {
  await ensureNativeTeam(teamName, `Genie team: ${teamName}`, 'pending');

  await registerNativeMember(teamName, {
    agentName: basename(cwd),
    agentType: 'team-lead',
    color: 'blue',
    cwd,
  });
}

/**
 * Build the claude launch command with native team flags.
 * Delegates to the shared buildTeamLeadCommand (single source of truth).
 */
export function buildClaudeCommand(teamName: string, systemPromptFile?: string, continueName?: string): string {
  return buildTeamLeadCommand(teamName, { systemPromptFile, continueName });
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
    await registry.register({
      id: `${sanitized}-team-lead`,
      paneId,
      session: sessionName,
      team: windowName,
      role: 'team-lead',
      worktree: null,
      startedAt: now,
      state: 'working',
      lastStateChange: now,
      repoPath: workspaceDir,
      provider: 'claude',
      transport: 'tmux',
      nativeTeamEnabled: true,
      nativeAgentId: `team-lead@${sanitized}`,
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
): Promise<void> {
  await ensureNativeTeamForLeader(windowName, workspaceDir);
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

  // Store cwd and session name as env vars on the window
  await tmux.setWindowEnv(`${sessionName}:${windowName}`, 'GENIE_CWD', workspaceDir);
  await tmux.setWindowEnv(`${sessionName}:${windowName}`, 'GENIE_SESSION', sessionName);

  const target = `${sessionName}:${windowName}`;
  const cdCmd = `cd ${shellQuote(workspaceDir)}`;
  await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);

  const agentName = basename(workspaceDir);
  const continueName = sanitizeTeamName(windowName);
  console.log(`Continuing session by name: ${continueName}`);
  const cmd = buildClaudeCommand(windowName, systemPromptFile || undefined, continueName);
  await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cmd)} Enter`);
  console.log(`Started Claude Code as ${agentName}@${continueName} in ${workspaceDir}`);

  // Register interactive session so spawned agents can find the team-lead
  await registerSessionInRegistry(sessionName, windowName, workspaceDir);
}

/** Focus (or create) a team window within an existing session. */
async function focusTeamWindow(
  sessionName: string,
  windowName: string,
  workingDir: string,
  systemPromptFile: string | null,
): Promise<void> {
  const teamWindow = await tmux.ensureTeamWindow(sessionName, windowName, workingDir);
  if (teamWindow.created) {
    console.log(`Created team window "${windowName}"`);

    // Store cwd and session name as env vars on the window
    await tmux.setWindowEnv(`${sessionName}:${windowName}`, 'GENIE_CWD', workingDir);
    await tmux.setWindowEnv(`${sessionName}:${windowName}`, 'GENIE_SESSION', sessionName);

    // Bootstrap native team and launch Claude Code in the new window
    await ensureNativeTeamForLeader(windowName, workingDir);
    const target = `${sessionName}:${windowName}`;
    const cdCmd = `cd ${shellQuote(workingDir)}`;
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);
    const agentName = basename(workingDir);
    const continueName = sanitizeTeamName(windowName);
    console.log(`Continuing session by name: ${continueName}`);
    const cmd = buildClaudeCommand(windowName, systemPromptFile || undefined, continueName);
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cmd)} Enter`);
    console.log(`Started Claude Code as ${agentName}@${continueName} in ${workingDir}`);

    // Register interactive session so spawned agents can find the team-lead
    await registerSessionInRegistry(sessionName, windowName, workingDir);
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
  const target = `${sessionName}:${windowName}`;
  if (process.env.TMUX) {
    // Already inside tmux — use switch-client for cross-project session switching
    console.log(`Switching to session "${sessionName}"...`);
    spawnSync('tmux', ['switch-client', '-t', target], { stdio: 'inherit' });
  } else {
    console.log('Attaching...');
    spawnSync('tmux', ['attach', '-t', target], { stdio: 'inherit' });
  }
}

export async function sessionCommand(options: SessionOptions = {}): Promise<void> {
  const workspaceDir = options.dir ?? process.cwd();
  const sessionName = options.name ?? (await resolveSessionName(workspaceDir));

  try {
    const windowName = await deriveWindowName(sessionName, workspaceDir, options.team);

    if (options.reset) await handleReset(sessionName, windowName);

    const session = await tmux.findSessionByName(sessionName);
    const systemPromptFile = getAgentsFilePath();
    if (!systemPromptFile) {
      console.warn('Info: No AGENTS.md found in current directory. Team-lead will use orchestration rules only.');
    }

    if (!session) {
      await createSession(sessionName, windowName, workspaceDir, systemPromptFile);
      attachToWindow(sessionName, windowName);
    } else if (process.env.TMUX) {
      // Already inside tmux — launch Claude Code in the CURRENT pane
      const suffix = Date.now().toString(36).slice(-4);
      const currentWindowName = `${windowName}-${suffix}`;
      await tmux.executeTmux(`rename-window ${shellQuote(currentWindowName)}`);
      await ensureNativeTeamForLeader(currentWindowName, workspaceDir);
      const continueName = sanitizeTeamName(currentWindowName);
      const cmd = buildClaudeCommand(currentWindowName, systemPromptFile || undefined, continueName);
      const { execSync: execSyncCmd } = require('node:child_process');
      execSyncCmd(cmd, { stdio: 'inherit', cwd: workspaceDir });
    } else {
      // Outside tmux — attach to existing session
      console.log(`Session "${sessionName}" already exists`);
      await focusTeamWindow(sessionName, windowName, workspaceDir, systemPromptFile);
      attachToWindow(sessionName, windowName);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
