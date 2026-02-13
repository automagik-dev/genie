/**
 * Task Namespace - Beads issue management
 *
 * Groups all task/issue management commands under `term task`.
 *
 * Commands:
 *   term task create <title>   - Create new beads issue
 *   term task update <id>      - Update task properties
 *   term task ship <id>        - Mark done + merge + cleanup
 *   term task close <id>       - Close + cleanup
 *   term task ls               - List ready tasks (= bd ready)
 */

import { Command } from 'commander';
import * as createCmd from '../create.js';
import * as updateCmd from '../update.js';
import * as shipCmd from '../ship.js';
import * as closeCmd from '../close.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getBackend } from '../../lib/task-backend.js';
import { listTasks, computePriorityScore, type LocalTask } from '../../lib/local-tasks.js';

const execAsync = promisify(exec);

/**
 * Register the `term task` namespace with all subcommands
 */
export function registerTaskNamespace(program: Command): void {
  const taskProgram = program
    .command('task')
    .description('Task/issue management (beads integration)');

  // task create
  taskProgram
    .command('create <title>')
    .description('Create a new beads issue')
    .option('-d, --description <text>', 'Issue description')
    .option('-p, --parent <id>', 'Parent issue ID (creates dependency)')
    .option('--wish <slug>', 'Link to a wish document')
    .option('--json', 'Output as JSON')
    .action(async (title: string, options: createCmd.CreateOptions & { wish?: string }) => {
      await createCmd.createCommand(title, options);
    });

  // task update
  taskProgram
    .command('update <task-id>')
    .description('Update task properties (status, title, blocked-by)')
    .option('--status <status>', 'New status (ready, in_progress, done, blocked)')
    .option('--title <title>', 'New title')
    .option('--blocked-by <ids>', 'Set blocked-by list (comma-separated task IDs)')
    .option('--add-blocked-by <ids>', 'Add to blocked-by list (comma-separated task IDs)')
    .option('--json', 'Output as JSON')
    .action(async (taskId: string, options: updateCmd.UpdateOptions) => {
      await updateCmd.updateCommand(taskId, options);
    });

  // task ship
  taskProgram
    .command('ship <task-id>')
    .description('Mark task as done and cleanup worker')
    .option('--keep-worktree', "Don't remove the worktree")
    .option('--merge', 'Merge worktree changes to main branch')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (taskId: string, options: shipCmd.ShipOptions) => {
      await shipCmd.shipCommand(taskId, options);
    });

  // task close
  taskProgram
    .command('close <task-id>')
    .description('Close task/issue and cleanup worker')
    .option('--no-sync', 'Skip bd sync (beads only)')
    .option('--keep-worktree', "Don't remove the worktree")
    .option('--merge', 'Merge worktree changes to main branch')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (taskId: string, options: closeCmd.CloseOptions) => {
      await closeCmd.closeCommand(taskId, options);
    });

  // task ls (wrapper for bd ready)
  taskProgram
    .command('ls')
    .alias('ready')
    .description('List ready tasks (wrapper for bd ready)')
    .option('--all', 'Show all tasks, not just ready')
    .option('--json', 'Output as JSON')
    .action(async (options: { all?: boolean; json?: boolean }) => {
      const repoPath = process.cwd();
      const backend = getBackend(repoPath);

      if (backend.kind === 'local') {
        // Local backend: show tasks sorted by priority score
        const tasks = await listTasks(repoPath);
        const filtered = options.all ? tasks : tasks.filter(t => t.status !== 'done');

        if (options.json) {
          console.log(JSON.stringify(filtered, null, 2));
          return;
        }

        if (filtered.length === 0) {
          console.log('No tasks found. Use `term feed "<idea>"` or `term create "<title>"` to add one.');
          return;
        }

        console.log('');
        console.log('┌────────────┬──────┬────────────┬───────┬──────────────────────────────────────────────────┐');
        console.log('│ ID         │ Type │ Status     │ Score │ Title                                            │');
        console.log('├────────────┼──────┼────────────┼───────┼──────────────────────────────────────────────────┤');

        for (const task of filtered) {
          const id = task.id.padEnd(10).substring(0, 10);
          const type = (task.issueType === 'epic' ? 'epic' : 'task').padEnd(4);
          const statusEmoji = task.status === 'done' ? '✅' : task.status === 'in_progress' ? '🔄' : task.status === 'blocked' ? '🔴' : '⚪';
          const status = `${statusEmoji} ${task.status}`.padEnd(10).substring(0, 10);
          const score = task.priorityScores
            ? computePriorityScore(task.priorityScores).toFixed(1).padStart(5)
            : '  —  ';
          const title = task.title.padEnd(48).substring(0, 48);
          console.log(`│ ${id} │ ${type} │ ${status} │ ${score} │ ${title} │`);
        }

        console.log('└────────────┴──────┴────────────┴───────┴──────────────────────────────────────────────────┘');
        console.log('');
      } else {
        // Beads backend: delegate to bd
        try {
          const cmd = options.all ? 'bd show --all' : 'bd ready';
          const { stdout } = await execAsync(cmd);
          console.log(stdout);
        } catch (error) {
          const err = error as { stderr?: string };
          if (err.stderr) {
            console.error(err.stderr);
          } else {
            console.error('Failed to list tasks. Make sure beads (bd) is installed.');
          }
          process.exit(1);
        }
      }
    });

  // task link <wish> <task-id> - Link a task to a wish
  taskProgram
    .command('link <wish-slug> <task-id>')
    .description('Link a beads task to a wish document')
    .action(async (wishSlug: string, taskId: string) => {
      const { linkTask, wishExists } = await import('../../lib/wish-tasks.js');
      const repoPath = process.cwd();

      // Verify wish exists
      if (!await wishExists(repoPath, wishSlug)) {
        console.error(`❌ Wish "${wishSlug}" not found in .genie/wishes/`);
        process.exit(1);
      }

      // Get task title from beads
      let taskTitle = taskId;
      try {
        const { stdout } = await execAsync(`bd show ${taskId} --json 2>/dev/null`);
        const issue = JSON.parse(stdout);
        taskTitle = issue.title || taskId;
      } catch {
        // Use taskId as fallback title
      }

      await linkTask(repoPath, wishSlug, taskId, taskTitle);
      console.log(`✅ Linked ${taskId} → ${wishSlug}`);
    });

  // task unlink <wish> <task-id> - Unlink a task from a wish
  taskProgram
    .command('unlink <wish-slug> <task-id>')
    .description('Unlink a beads task from a wish document')
    .action(async (wishSlug: string, taskId: string) => {
      const { unlinkTask } = await import('../../lib/wish-tasks.js');
      const repoPath = process.cwd();

      const removed = await unlinkTask(repoPath, wishSlug, taskId);
      if (removed) {
        console.log(`✅ Unlinked ${taskId} from ${wishSlug}`);
      } else {
        console.log(`ℹ️  ${taskId} was not linked to ${wishSlug}`);
      }
    });
}
