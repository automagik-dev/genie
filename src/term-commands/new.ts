import { join } from 'node:path';
import { saveSessionMetadata } from '../lib/session-metadata.js';
import * as tmux from '../lib/tmux.js';
import { createWorktreeManager } from '../lib/worktree.js';

export interface CreateSessionOptions {
  workspace?: string;
  worktree?: boolean;
}

export async function createNewSession(name: string, options: CreateSessionOptions = {}): Promise<void> {
  try {
    // Check if session already exists
    const existing = await tmux.findSessionByName(name);
    if (existing) {
      console.error(`❌ Session "${name}" already exists`);
      process.exit(1);
    }

    let workingDir = options.workspace || process.cwd();
    let worktreePath: string | undefined;

    if (options.worktree) {
      if (!options.workspace) {
        console.error('❌ --worktree requires --workspace');
        process.exit(1);
      }

      const manager = createWorktreeManager({
        baseDir: join(options.workspace, '.worktrees'),
        repoPath: options.workspace,
      });

      // Check if worktree already exists
      const exists = await manager.worktreeExists(name);
      if (exists) {
        console.error(`❌ Worktree for "${name}" already exists`);
        process.exit(1);
      }

      // Create worktree with auto-create branch
      const wt = await manager.createWorktree(name, true);
      worktreePath = wt.path;
      workingDir = wt.path;

      console.log(`✅ Worktree created at ${worktreePath}`);
    }

    // Create session
    const session = await tmux.createSession(name);
    if (!session) {
      console.error(`❌ Failed to create session "${name}"`);
      process.exit(1);
    }

    // Change to working directory
    await tmux.executeTmux(`send-keys -t '${name}' 'cd ${workingDir}' Enter`);

    // Save metadata for cleanup (if worktree was created)
    if (worktreePath) {
      await saveSessionMetadata(name, { worktreePath, workspace: options.workspace });
    }

    console.log(`✅ Session "${name}" created`);
    if (workingDir !== process.cwd()) {
      console.log(`   Working directory: ${workingDir}`);
    }
    console.log(`\nTo attach: term attach ${name}`);
  } catch (error: any) {
    console.error(`❌ Error creating session: ${error.message}`);
    process.exit(1);
  }
}
