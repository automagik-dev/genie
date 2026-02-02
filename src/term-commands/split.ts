import { join } from 'path';
import * as tmux from '../lib/tmux.js';
import { createWorktreeManager } from '../lib/worktree.js';

export interface SplitOptions {
  workspace?: string;
  worktree?: string;
}

export async function splitSessionPane(
  sessionName: string,
  direction?: string,
  options: SplitOptions = {}
): Promise<void> {
  try {
    // Find session
    const session = await tmux.findSessionByName(sessionName);
    if (!session) {
      console.error(`❌ Session "${sessionName}" not found`);
      process.exit(1);
    }

    // Get first window and pane
    const windows = await tmux.listWindows(session.id);
    if (!windows || windows.length === 0) {
      console.error(`❌ No windows found in session "${sessionName}"`);
      process.exit(1);
    }

    const panes = await tmux.listPanes(windows[0].id);
    if (!panes || panes.length === 0) {
      console.error(`❌ No panes found in session "${sessionName}"`);
      process.exit(1);
    }

    const paneId = panes[0].id;

    // Determine direction
    const splitDirection = direction === 'h' ? 'horizontal' : 'vertical';

    // Get source pane's current working directory
    const sourcePath = await tmux.executeTmux(`display-message -p -t '${paneId}' '#{pane_current_path}'`);

    // Handle workspace and worktree options
    let workingDir: string | undefined;

    if (options.worktree) {
      if (!options.workspace) {
        console.error('❌ --worktree requires --workspace');
        process.exit(1);
      }

      const manager = createWorktreeManager({
        baseDir: join(options.workspace, '.worktrees'),
        repoPath: options.workspace
      });

      // Check if worktree exists, create if not
      const exists = await manager.worktreeExists(options.worktree);
      if (!exists) {
        const wt = await manager.createWorktree(options.worktree, true);
        console.log(`✅ Worktree created at ${wt.path}`);
      }

      workingDir = manager.getWorktreePath(options.worktree);
    } else if (options.workspace) {
      workingDir = options.workspace;
    } else {
      // Default to source pane's current directory
      workingDir = sourcePath.trim() || undefined;
    }

    // Split pane with working directory (tmux -c flag handles this natively)
    const newPane = await tmux.splitPane(paneId, splitDirection, undefined, workingDir);
    if (!newPane) {
      console.error('❌ Failed to split pane');
      process.exit(1);
    }

    console.log(`✅ Pane split ${splitDirection}ly in session "${sessionName}"`);
    if (workingDir) {
      console.log(`   Working directory: ${workingDir}`);
    }
  } catch (error: any) {
    console.error(`❌ Error splitting pane: ${error.message}`);
    process.exit(1);
  }
}
