/**
 * Task Namespace — Beads issue management + dependency-aware task management.
 *
 * Groups all task/issue management commands under `term task` / `genie task`.
 *
 * Commands (beads integration - main):
 *   task create <title>   - Create new beads issue
 *   task update <id>      - Update task properties
 *   task ship <id>        - Mark done + merge + cleanup
 *   task close <id>       - Close + cleanup
 *   task ls               - List ready tasks (= bd ready)
 *   task link             - Link task to wish
 *   task unlink           - Unlink task from wish
 *
 * Commands (dependency-aware - teams):
 *   task create-local <title>  - Create a local dependency-tracked task
 *   task list-local            - List local tasks with ready/blocked
 *   task update-local <id>     - Update local task properties
 *
 * Group F: Tasks differentiate "ready" vs "blocked" based on
 * dependency resolution.
 */

import { Command } from 'commander';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import * as createCmd from '../create.js';
import * as updateCmd from '../update.js';
import * as shipCmd from '../ship.js';
import * as closeCmd from '../close.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getBackend } from '../../lib/task-backend.js';
import { listTasks, computePriorityScore, type LocalTask } from '../../lib/local-tasks.js';

const execAsync = promisify(exec);

// ============================================================================
// Types (dependency-aware tasks from genie-cli-teams)
// ============================================================================

export type TaskStatus = 'ready' | 'in_progress' | 'done' | 'blocked';

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  blockedBy: string[];
  createdAt: string;
  updatedAt: string;
}

interface TasksFile {
  tasks: Record<string, Task>;
  order: string[];
  nextId: number;
  lastUpdated: string;
}

// ============================================================================
// Persistence (dependency-aware tasks)
// ============================================================================

function tasksFilePath(repoPath: string): string {
  return join(repoPath, '.genie', 'tasks.json');
}

async function loadTasks(repoPath: string): Promise<TasksFile> {
  try {
    const content = await readFile(tasksFilePath(repoPath), 'utf-8');
    return JSON.parse(content);
  } catch {
    return { tasks: {}, order: [], nextId: 1, lastUpdated: new Date().toISOString() };
  }
}

async function saveTasks(repoPath: string, data: TasksFile): Promise<void> {
  await mkdir(join(repoPath, '.genie'), { recursive: true });
  data.lastUpdated = new Date().toISOString();
  await writeFile(tasksFilePath(repoPath), JSON.stringify(data, null, 2));
}

// ============================================================================
// Task Logic (dependency resolution)
// ============================================================================

function resolveStatus(task: Task, allTasks: Record<string, Task>): TaskStatus {
  if (task.status === 'done' || task.status === 'in_progress') return task.status;
  if (task.blockedBy.length === 0) return 'ready';
  const allDone = task.blockedBy.every(id => allTasks[id]?.status === 'done');
  return allDone ? 'ready' : 'blocked';
}

// ============================================================================
// Register namespace
// ============================================================================

/**
 * Register the `task` namespace with all subcommands
 */
export function registerTaskNamespace(program: Command): void {
  const taskProgram = program
    .command('task')
    .description('Task/issue management (beads + dependency-aware)');

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

  // ========================================================================
  // Dependency-aware local task commands (genie-cli-teams)
  // ========================================================================

  // task create-local
  taskProgram
    .command('create-local <title>')
    .description('Create a new local dependency-tracked task')
    .option('-d, --description <text>', 'Task description')
    .option('--blocked-by <ids>', 'Comma-separated task IDs this depends on')
    .action(async (title: string, options: { description?: string; blockedBy?: string }) => {
      try {
        const repoPath = process.cwd();
        const data = await loadTasks(repoPath);
        const id = `task-${data.nextId}`;
        data.nextId += 1;

        const blockedBy = options.blockedBy
          ? options.blockedBy.split(',').map(s => s.trim())
          : [];

        const now = new Date().toISOString();
        const newTask: Task = {
          id,
          title,
          description: options.description,
          status: blockedBy.length > 0 ? 'blocked' : 'ready',
          blockedBy,
          createdAt: now,
          updatedAt: now,
        };

        data.tasks[id] = newTask;
        data.order.push(id);
        await saveTasks(repoPath, data);

        console.log(`Task created: ${id}`);
        console.log(`  Title: ${title}`);
        console.log(`  Status: ${newTask.status}`);
        if (blockedBy.length > 0) {
          console.log(`  Blocked by: ${blockedBy.join(', ')}`);
        }
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });

  // task list-local
  taskProgram
    .command('list-local')
    .description('List local tasks with ready/blocked differentiation')
    .option('--json', 'Output as JSON')
    .option('--all', 'Include done tasks')
    .action(async (options: { json?: boolean; all?: boolean }) => {
      try {
        const repoPath = process.cwd();
        const data = await loadTasks(repoPath);
        const allTasks = data.tasks;

        const tasks = data.order
          .map(id => allTasks[id])
          .filter(Boolean)
          .filter(t => options.all || t.status !== 'done')
          .map(t => ({
            ...t,
            effectiveStatus: resolveStatus(t, allTasks),
          }));

        if (options.json) {
          console.log(JSON.stringify(tasks, null, 2));
          return;
        }

        if (tasks.length === 0) {
          console.log('No tasks found. Create one: genie task create-local "My task"');
          return;
        }

        const ready = tasks.filter(t => t.effectiveStatus === 'ready');
        const blocked = tasks.filter(t => t.effectiveStatus === 'blocked');
        const inProgress = tasks.filter(t => t.effectiveStatus === 'in_progress');
        const done = tasks.filter(t => t.effectiveStatus === 'done');

        console.log('');
        console.log('TASKS');
        console.log('='.repeat(60));

        if (inProgress.length > 0) {
          console.log('\nIn Progress:');
          for (const t of inProgress) {
            console.log(`  ${t.id}: ${t.title}`);
          }
        }

        if (ready.length > 0) {
          console.log('\nReady:');
          for (const t of ready) {
            console.log(`  ${t.id}: ${t.title}`);
          }
        }

        if (blocked.length > 0) {
          console.log('\nBlocked:');
          for (const t of blocked) {
            console.log(`  ${t.id}: ${t.title} (blocked by: ${t.blockedBy.join(', ')})`);
          }
        }

        if (options.all && done.length > 0) {
          console.log('\nDone:');
          for (const t of done) {
            console.log(`  ${t.id}: ${t.title}`);
          }
        }

        console.log('');
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });

  // task update-local
  taskProgram
    .command('update-local <id>')
    .description('Update local task properties')
    .option('--status <status>', 'New status: ready, in_progress, done, blocked')
    .option('--title <title>', 'New title')
    .option('--blocked-by <ids>', 'Set blocked-by list (comma-separated)')
    .action(async (id: string, options: { status?: string; title?: string; blockedBy?: string }) => {
      try {
        const repoPath = process.cwd();
        const data = await loadTasks(repoPath);
        const task = data.tasks[id];

        if (!task) {
          console.error(`Task "${id}" not found.`);
          process.exit(1);
        }

        if (options.status) {
          task.status = options.status as TaskStatus;
        }
        if (options.title) {
          task.title = options.title;
        }
        if (options.blockedBy !== undefined) {
          task.blockedBy = options.blockedBy
            ? options.blockedBy.split(',').map(s => s.trim())
            : [];
        }

        task.updatedAt = new Date().toISOString();
        await saveTasks(repoPath, data);

        console.log(`Task "${id}" updated.`);
        console.log(`  Status: ${task.status}`);
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });
}
