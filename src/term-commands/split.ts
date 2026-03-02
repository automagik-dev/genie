import { join } from 'path';
import * as tmux from '../lib/tmux.js';
import { createWorktreeManager } from '../lib/worktree.js';
import { resolveTarget } from '../lib/target-resolver.js';
import { addSubPane } from '../lib/worker-registry.js';

export interface SplitOptions {
  workspace?: string;
  worktree?: string;
}

export async function splitSessionPane(
  target: string,
  direction?: string,
  options: SplitOptions = {}
): Promise<void> {
  try {
    // Use target resolver (DEC-1 from wish-26)
    const resolved = await resolveTarget(target);
    const paneId = resolved.paneId;
    const resolvedWorkerId = resolved.workerId;
    const resolvedSession = resolved.session;

    // Determine direction
    const splitDirection = direction === 'h' ? 'horizontal' : 'vertical';

    // Get source pane's current working directory
    const sourcePath = await tmux.executeTmux(`display-message -p -t '${paneId}' '#{pane_current_path}'`);

    // Handle workspace and worktree options
    let workingDir: string | undefined;

    if (options.worktree) {
      if (!options.workspace) {
        console.error('--worktree requires --workspace');
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
        console.log(`Worktree created at ${wt.path}`);
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
      console.error('Failed to split pane');
      process.exit(1);
    }

    // Send cd command to new pane to ensure correct working directory
    // (works around shell rc files that override the starting directory)
    if (workingDir) {
      await tmux.executeTmux(`send-keys -t '${newPane.id}' 'cd ${workingDir.replace(/'/g, "'\\''")} && clear' Enter`);
    }

    // If the target resolved as a worker, auto-register the new pane (DEC-4)
    if (resolvedWorkerId) {
      await addSubPane(resolvedWorkerId, newPane.id);

      // Get the new sub-pane index: count of subPanes after adding
      // We need to look up the worker again to determine the index
      const registry = await import('../lib/worker-registry.js');
      const worker = await registry.get(resolvedWorkerId);
      const subPaneIndex = worker?.subPanes ? worker.subPanes.length : 1;

      console.log(`Pane split ${splitDirection}ly. Address: ${resolvedWorkerId}:${subPaneIndex}`);
    } else {
      const label = resolvedSession || target;
      console.log(`Pane split ${splitDirection}ly in "${label}"`);
    }

    if (workingDir) {
      console.log(`   Working directory: ${workingDir}`);
    }
  } catch (error: any) {
    console.error(`Error splitting pane: ${error.message}`);
    process.exit(1);
  }
}
