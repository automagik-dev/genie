import { join } from 'node:path';
import { deleteSessionMetadata, loadSessionMetadata } from '../lib/session-metadata.js';
import * as tmux from '../lib/tmux.js';
import { createWorktreeManager } from '../lib/worktree.js';

export interface RemoveSessionOptions {
  keepWorktree?: boolean;
}

export async function removeSession(name: string, options: RemoveSessionOptions = {}): Promise<void> {
  try {
    // Check if session exists
    const session = await tmux.findSessionByName(name);
    if (!session) {
      console.error(`❌ Session "${name}" not found`);
      process.exit(1);
    }

    // Check if session has associated worktree
    const metadata = await loadSessionMetadata(name);

    // Kill session
    await tmux.killSession(session.id);

    // Remove worktree unless --keep-worktree
    if (metadata?.worktreePath && metadata?.workspace && !options.keepWorktree) {
      const manager = createWorktreeManager({
        baseDir: join(metadata.workspace, '.worktrees'),
        repoPath: metadata.workspace,
      });
      await manager.removeWorktree(name);
      console.log(`✅ Session "${name}" and worktree removed`);
    } else if (metadata?.worktreePath && options.keepWorktree) {
      console.log(`✅ Session "${name}" removed (worktree kept at ${metadata.worktreePath})`);
    } else {
      console.log(`✅ Session "${name}" removed`);
    }

    // Clean up metadata
    if (metadata) {
      await deleteSessionMetadata(name);
    }
  } catch (error: any) {
    console.error(`❌ Error removing session: ${error.message}`);
    process.exit(1);
  }
}
