/**
 * Genie Session Command
 *
 * Session-per-folder: running `genie` from any folder creates/attaches
 * a tmux window named after that folder inside a single "genie" session.
 *
 * Architecture:
 *   tmux session: "genie"              <- single persistent session
 *     |-- Window 0: "myapp"            <- genie run from ~/projects/myapp
 *     |-- Window 1: "api-server-c7b1"  <- disambiguated (same basename, different path)
 *     +-- Window 2: "myapp2"           <- genie run from ~/projects/myapp2
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { clearAll as clearWorkerRegistry } from '../lib/agent-registry.js';
import {
  deleteAllNativeTeams,
  ensureNativeTeam,
  registerNativeMember,
  sanitizeTeamName,
} from '../lib/claude-native-teams.js';
import { buildTeamLeadCommand, shellQuote } from '../lib/team-lead-command.js';
import * as tmux from '../lib/tmux.js';

const DEFAULT_SESSION_NAME = 'genie';

/**
 * Generate a short 4-char hash of a path for disambiguation.
 */
function shortPathHash(p: string): string {
  return createHash('md5').update(p).digest('hex').slice(0, 4);
}

/**
 * Get the AGENTS.md system prompt if it exists in the current directory.
 * Returns the file contents as a string, or null if not found.
 */
export function getAgentsSystemPrompt(): string | null {
  const agentsPath = join(process.cwd(), 'AGENTS.md');
  if (existsSync(agentsPath)) {
    return readFileSync(agentsPath, 'utf-8');
  }
  return null;
}

/**
 * Convert a workspace directory path to a Claude project directory name.
 * Claude encodes paths by replacing '/' with '-', so /home/genie/workspace -> -home-genie-workspace.
 */
function workspaceDirToProjectDir(workspaceDir: string): string {
  return workspaceDir.replace(/\//g, '-');
}

/**
 * Find the most recent session ID for a given teamName + agentName from Claude's JSONL logs.
 * Returns null if no matching session is found.
 */
function findLastSessionId(teamName: string, agentName: string, workspaceDir: string): string | null {
  const projectDirName = workspaceDirToProjectDir(workspaceDir);
  const projectDir = join(homedir(), '.claude', 'projects', projectDirName);

  if (!existsSync(projectDir)) return null;

  let files: { path: string; mtime: number }[];
  try {
    files = readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = join(projectDir, f);
        return { path: p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }

  for (const { path } of files) {
    try {
      const firstLine = readFileSync(path, 'utf-8').split('\n')[0];
      if (!firstLine) continue;
      const data = JSON.parse(firstLine);
      if (data.teamName === teamName && data.agentName === agentName && data.sessionId) {
        return data.sessionId as string;
      }
    } catch {
      // Skip malformed files
    }
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
    agentName: 'team-lead',
    agentType: 'general-purpose',
    color: 'blue',
    cwd,
  });
}

/**
 * Build the claude launch command with native team flags.
 * Delegates to the shared buildTeamLeadCommand (single source of truth).
 */
export function buildClaudeCommand(teamName: string, systemPrompt?: string, resumeSessionId?: string): string {
  return buildTeamLeadCommand(teamName, { systemPrompt, resumeSessionId });
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
  systemPrompt: string | null,
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

  // Store cwd as env var on the window
  await tmux.setWindowEnv(`${sessionName}:${windowName}`, 'GENIE_CWD', workspaceDir);

  const target = `${sessionName}:${windowName}`;
  const cdCmd = `cd ${shellQuote(workspaceDir)}`;
  await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);

  const resumeSessionId = findLastSessionId(sanitizeTeamName(windowName), 'team-lead', workspaceDir);
  if (resumeSessionId) {
    console.log(`Resuming previous session: ${resumeSessionId}`);
  }
  const cmd = buildClaudeCommand(windowName, systemPrompt || undefined, resumeSessionId || undefined);
  await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cmd)} Enter`);
  console.log(`Started Claude Code as team-lead@${sanitizeTeamName(windowName)} in ${workspaceDir}`);
}

/** Focus (or create) a team window within an existing session. */
async function focusTeamWindow(
  sessionName: string,
  windowName: string,
  workingDir: string,
  systemPrompt: string | null,
): Promise<void> {
  const teamWindow = await tmux.ensureTeamWindow(sessionName, windowName, workingDir);
  if (teamWindow.created) {
    console.log(`Created team window "${windowName}"`);

    // Store cwd as env var on the window
    await tmux.setWindowEnv(`${sessionName}:${windowName}`, 'GENIE_CWD', workingDir);

    // Bootstrap native team and launch Claude Code in the new window
    await ensureNativeTeamForLeader(windowName, workingDir);
    const target = `${sessionName}:${windowName}`;
    const cdCmd = `cd ${shellQuote(workingDir)}`;
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);
    const resumeSessionId = findLastSessionId(sanitizeTeamName(windowName), 'team-lead', workingDir);
    if (resumeSessionId) {
      console.log(`Resuming previous session: ${resumeSessionId}`);
    }
    const cmd = buildClaudeCommand(windowName, systemPrompt || undefined, resumeSessionId || undefined);
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cmd)} Enter`);
    console.log(`Started Claude Code as team-lead@${sanitizeTeamName(windowName)} in ${workingDir}`);
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

async function handleReset(sessionName: string, _windowName: string): Promise<void> {
  const existing = await tmux.findSessionByName(sessionName);
  if (existing) {
    console.log(`Resetting session "${sessionName}"...`);
    await tmux.killSession(sessionName);
  }
  // Delete ALL native team directories — not just the current window's team.
  // After killing the tmux session, all workers are dead, so all team state is stale.
  const deleted = await deleteAllNativeTeams();
  if (deleted > 0) {
    console.log(`Cleaned up ${deleted} native team director${deleted === 1 ? 'y' : 'ies'}`);
  }
  // Clear worker registry since all workers are dead after session kill
  await clearWorkerRegistry();
}

function attachToWindow(sessionName: string, windowName: string): void {
  console.log('Attaching...');
  const target = `${sessionName}:${windowName}`;
  const cmd = process.env.TMUX ? 'switch-client' : 'attach';
  spawnSync('tmux', [cmd, '-t', target], { stdio: 'inherit' });
}

export async function sessionCommand(options: SessionOptions = {}): Promise<void> {
  const sessionName = options.name ?? DEFAULT_SESSION_NAME;
  const workspaceDir = options.dir ?? process.cwd();

  try {
    const windowName = await deriveWindowName(sessionName, workspaceDir, options.team);

    if (options.reset) await handleReset(sessionName, windowName);

    const session = await tmux.findSessionByName(sessionName);
    const systemPrompt = getAgentsSystemPrompt();
    if (!systemPrompt) {
      console.warn('Info: No AGENTS.md found in current directory. Team-lead will use orchestration rules only.');
    }

    if (!session) {
      await createSession(sessionName, windowName, workspaceDir, systemPrompt);
    } else {
      console.log(`Session "${sessionName}" already exists`);
      await focusTeamWindow(sessionName, windowName, workspaceDir, systemPrompt);
    }

    attachToWindow(sessionName, windowName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
