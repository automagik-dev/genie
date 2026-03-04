/**
 * Genie TUI Command
 *
 * Persistent "master genie" session that:
 * - Always lives in ~/workspace (or custom dir)
 * - Uses configurable session/team name (default: "genie")
 * - Persists until manually reset via --reset flag
 * - Starts Claude Code as native team-lead on first creation
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  deleteNativeTeam,
  ensureNativeTeam,
  registerNativeMember,
  sanitizeTeamName,
} from '../lib/claude-native-teams.js';
import * as tmux from '../lib/tmux.js';

const DEFAULT_NAME = 'genie';
const DEFAULT_WORKSPACE = join(homedir(), 'workspace');

/** Shell-quote a string for safe embedding in shell commands. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
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

export interface TuiOptions {
  reset?: boolean;
  name?: string;
  dir?: string;
  /** Team name — when set, focus (or create) a dedicated window for this team. */
  team?: string;
}

/**
 * Pre-create the native team directory so CC starts as team-lead.
 *
 * Creates ~/.claude/teams/<name>/ with config.json + inboxes/team-lead.json.
 * The leadSessionId is a placeholder — CC updates it internally once started.
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
 *
 * CC requires --agent-id, --agent-name, and --team-name together.
 * The team lead uses agent-id "team-lead@<team>" by convention.
 * When systemPrompt is provided, --system-prompt is injected into the command.
 */
export function buildClaudeCommand(teamName: string, systemPrompt?: string): string {
  const sanitized = sanitizeTeamName(teamName);
  const qTeam = shellQuote(sanitized);
  const parts = [
    'CLAUDECODE=1',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
    `GENIE_TEAM=${qTeam}`,
    'claude',
    `--agent-id ${shellQuote(`team-lead@${sanitized}`)}`,
    `--agent-name ${shellQuote('team-lead')}`,
    `--team-name ${qTeam}`,
    '--dangerously-skip-permissions',
  ];

  if (systemPrompt) {
    const sanitized = systemPrompt.replace(/\n/g, ' ');
    parts.push(`--system-prompt ${shellQuote(sanitized)}`);
  }

  return parts.join(' ');
}

async function createTuiSession(name: string, workspaceDir: string, systemPrompt: string | null): Promise<void> {
  await ensureNativeTeamForLeader(name, workspaceDir);
  console.log(`Native team "${name}" ready at ~/.claude/teams/${sanitizeTeamName(name)}/`);

  console.log(`Creating session "${name}"...`);
  const session = await tmux.createSession(name);
  if (!session) {
    console.error(`Failed to create session "${name}"`);
    process.exit(1);
  }

  // Name the main window and lock the name
  await tmux.executeTmux(`rename-window -t ${shellQuote(`${name}:0`)} ${shellQuote(name)}`);
  await tmux.executeTmux(`set-window-option -t ${shellQuote(`${name}:0`)} automatic-rename off`);

  const cdCmd = `cd ${shellQuote(workspaceDir)}`;
  await tmux.executeTmux(`send-keys -t ${shellQuote(name)} ${shellQuote(cdCmd)} Enter`);

  const cmd = buildClaudeCommand(name, systemPrompt || undefined);
  await tmux.executeTmux(`send-keys -t ${shellQuote(name)} ${shellQuote(cmd)} Enter`);
  console.log(`Started Claude Code as team-lead@${sanitizeTeamName(name)} in ${workspaceDir}`);
}

/** Focus (or create) a team window within an existing session. */
async function focusTeamWindow(
  sessionName: string,
  team: string,
  workingDir: string,
  systemPrompt: string | null,
): Promise<void> {
  const teamWindow = await tmux.ensureTeamWindow(sessionName, team, workingDir);
  if (teamWindow.created) {
    console.log(`Created team window "${team}"`);

    // Bootstrap native team and launch Claude Code in the new window
    await ensureNativeTeamForLeader(team, workingDir);
    const target = `${sessionName}:${team}`;
    const cdCmd = `cd ${shellQuote(workingDir)}`;
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cdCmd)} Enter`);
    const cmd = buildClaudeCommand(team, systemPrompt || undefined);
    await tmux.executeTmux(`send-keys -t ${shellQuote(target)} ${shellQuote(cmd)} Enter`);
    console.log(`Started Claude Code as team-lead@${sanitizeTeamName(team)} in ${workingDir}`);
  }
  await tmux.executeTmux(`select-window -t ${shellQuote(`${sessionName}:${team}`)}`);
  console.log(`Focused team window "${team}"`);
}

export async function tuiCommand(options: TuiOptions = {}): Promise<void> {
  const name = options.name ?? DEFAULT_NAME;
  const workspaceDir = options.dir ?? DEFAULT_WORKSPACE;

  try {
    if (options.reset) {
      const existing = await tmux.findSessionByName(name);
      if (existing) {
        console.log(`Resetting session "${name}"...`);
        await tmux.killSession(name);
      }
      await deleteNativeTeam(name);
    }

    let session = await tmux.findSessionByName(name);
    const systemPrompt = getAgentsSystemPrompt();
    if (!systemPrompt) {
      console.warn('Warning: No AGENTS.md found in current directory. Launching without --system-prompt.');
    }

    if (!session) {
      await createTuiSession(name, workspaceDir, systemPrompt);
      session = await tmux.findSessionByName(name);
    } else {
      console.log(`Session "${name}" already exists`);
    }

    if (options.team && session) {
      await focusTeamWindow(name, options.team, workspaceDir, systemPrompt);
    }

    console.log('Attaching...');
    if (process.env.TMUX) {
      spawnSync('tmux', ['switch-client', '-t', name], { stdio: 'inherit' });
    } else {
      spawnSync('tmux', ['attach', '-t', name], { stdio: 'inherit' });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
