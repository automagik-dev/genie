import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import * as tmux from '../lib/tmux.js';

const exec = promisify(execCallback);

export async function attachToSession(name: string): Promise<void> {
  try {
    // Check if session exists
    const session = await tmux.findSessionByName(name);
    if (!session) {
      console.error(`❌ Session "${name}" not found`);
      process.exit(1);
    }

    // Attach to session
    console.log(`📎 Attaching to session "${name}"...`);
    await exec(`tmux attach -t "${name}"`);
  } catch (error: any) {
    console.error(`❌ Error attaching to session: ${error.message}`);
    process.exit(1);
  }
}
