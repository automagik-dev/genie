/**
 * Genie TUI Command
 *
 * Persistent "master genie" session that:
 * - Always lives in ~/workspace
 * - Uses fixed session name "genie"
 * - Persists until manually reset via --reset flag
 * - Starts Claude Code on first creation
 */

import { spawnSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import * as tmux from '../lib/tmux.js';

const SESSION_NAME = 'genie';
const WORKSPACE_DIR = join(homedir(), 'workspace');

export interface TuiOptions {
  reset?: boolean;
}

export async function tuiCommand(options: TuiOptions = {}): Promise<void> {
  try {
    // Handle reset flag - kill existing session
    if (options.reset) {
      const existing = await tmux.findSessionByName(SESSION_NAME);
      if (existing) {
        console.log(`🗑️  Resetting session "${SESSION_NAME}"...`);
        await tmux.killSession(SESSION_NAME);
      }
    }

    // Check if session exists
    let session = await tmux.findSessionByName(SESSION_NAME);

    if (!session) {
      // Create session
      console.log(`✨ Creating session "${SESSION_NAME}"...`);
      session = await tmux.createSession(SESSION_NAME);
      if (!session) {
        console.error(`❌ Failed to create session "${SESSION_NAME}"`);
        process.exit(1);
      }

      // Change to workspace directory
      await tmux.executeTmux(`send-keys -t '${SESSION_NAME}' 'cd ${WORKSPACE_DIR}' Enter`);

      // Start Claude Code
      await tmux.executeTmux(`send-keys -t '${SESSION_NAME}' 'claude' Enter`);
      console.log(`✅ Started Claude Code in ${WORKSPACE_DIR}`);
    } else {
      console.log(`📎 Session "${SESSION_NAME}" already exists`);
    }

    // Attach to session (replaces current process)
    console.log(`📎 Attaching...`);
    spawnSync('tmux', ['attach', '-t', SESSION_NAME], { stdio: 'inherit' });
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}
