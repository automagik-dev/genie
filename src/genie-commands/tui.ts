/**
 * Genie TUI Command
 *
 * Persistent "master genie" session that:
 * - Always lives in ~/workspace (or custom dir)
 * - Uses configurable session/team name (default: "genie")
 * - Persists until manually reset via --reset flag
 * - Starts Claude Code as native team-lead on first creation
 */

import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import * as tmux from '../lib/tmux.js';
import {
  ensureNativeTeam,
  deleteNativeTeam,
  registerNativeMember,
  sanitizeTeamName,
} from '../lib/claude-native-teams.js';

const DEFAULT_NAME = 'genie';
const DEFAULT_WORKSPACE = join(homedir(), 'workspace');

export interface TuiOptions {
  reset?: boolean;
  name?: string;
  dir?: string;
}

/**
 * Pre-create the native team directory so CC starts as team-lead.
 *
 * Creates ~/.claude/teams/<name>/ with config.json + inboxes/team-lead.json.
 * The leadSessionId is a placeholder — CC updates it internally once started.
 * CC recognizes itself as leader because --team-name is passed without --agent-id.
 */
async function ensureNativeTeamForLeader(teamName: string, cwd: string): Promise<void> {
  await ensureNativeTeam(
    teamName,
    `Genie team: ${teamName}`,
    'pending',
  );

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
 */
function buildClaudeCommand(teamName: string): string {
  const sanitized = sanitizeTeamName(teamName);
  const parts = [
    'CLAUDECODE=1',
    'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
    `GENIE_TEAM='${sanitized}'`,
    'claude',
    `--agent-id 'team-lead@${sanitized}'`,
    `--agent-name 'team-lead'`,
    `--team-name '${sanitized}'`,
    '--dangerously-skip-permissions',
    '-c',
  ];

  return parts.join(' ');
}

export async function tuiCommand(options: TuiOptions = {}): Promise<void> {
  const name = options.name ?? DEFAULT_NAME;
  const workspaceDir = options.dir ?? DEFAULT_WORKSPACE;

  try {
    // Handle reset flag - kill existing session + clean up native team
    if (options.reset) {
      const existing = await tmux.findSessionByName(name);
      if (existing) {
        console.log(`Resetting session "${name}"...`);
        await tmux.killSession(name);
      }
      await deleteNativeTeam(name);
    }

    // Check if session exists
    let session = await tmux.findSessionByName(name);

    if (!session) {
      // Pre-create native team directory for CC
      await ensureNativeTeamForLeader(name, workspaceDir);
      console.log(`Native team "${name}" ready at ~/.claude/teams/${sanitizeTeamName(name)}/`);

      // Create tmux session
      console.log(`Creating session "${name}"...`);
      session = await tmux.createSession(name);
      if (!session) {
        console.error(`Failed to create session "${name}"`);
        process.exit(1);
      }

      // Change to workspace directory
      await tmux.executeTmux(`send-keys -t '${name}' 'cd ${workspaceDir}' Enter`);

      // Start Claude Code as native team-lead
      const cmd = buildClaudeCommand(name);
      await tmux.executeTmux(`send-keys -t '${name}' '${cmd}' Enter`);
      console.log(`Started Claude Code as team-lead@${sanitizeTeamName(name)} in ${workspaceDir}`);
    } else {
      console.log(`Session "${name}" already exists`);
    }

    // Attach to session (replaces current process)
    console.log(`Attaching...`);
    spawnSync('tmux', ['attach', '-t', name], { stdio: 'inherit' });
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
