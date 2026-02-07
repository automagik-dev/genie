import { join } from 'path';
import * as tmux from '../lib/tmux.js';
import { createWorktreeManager } from '../lib/worktree.js';

export interface SplitOptions {
  workspace?: string;
  worktree?: string;
  pane?: string;
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

    let paneId: string;

    if (options.pane) {
      // Use explicitly specified pane
      paneId = options.pane.startsWith('%') ? options.pane : `%${options.pane}`;
    } else {
      // Get windows and find active one
      const windows = await tmux.listWindows(session.id);
      if (!windows || windows.length === 0) {
        console.error(`❌ No windows found in session "${sessionName}"`);
        process.exit(1);
      }

      // Find active window (default to first if none marked active)
      const activeWindow = windows.find(w => w.active) || windows[0];

      const panes = await tmux.listPanes(activeWindow.id);
      if (!panes || panes.length === 0) {
        console.error(`❌ No panes found in session "${sessionName}"`);
        process.exit(1);
      }

      // Find active pane (default to first if none marked active)
      const activePane = panes.find(p => p.active) || panes[0];
      paneId = activePane.id;
    }

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

    // Send cd command to new pane to ensure correct working directory
    // (works around shell rc files that override the starting directory)
    if (workingDir) {
      await tmux.executeTmux(`send-keys -t '${newPane.id}' 'cd ${workingDir.replace(/'/g, "'\\''")} && clear' Enter`);
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
