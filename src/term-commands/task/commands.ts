/**
 * Task Namespace — Task management with dependency tracking.
 *
 * Groups all task management commands under `genie task`.
 *
 * Commands:
 *   task create <title>        - Create new task
 *   task update <id>           - Update task properties
 *   task ship <id>             - Mark done + merge + cleanup
 *   task close <id>            - Close + cleanup
 *   task ls                    - List ready tasks
 *   task link                  - Link task to wish
 *   task unlink                - Unlink task from wish
 *   task create-local <title>  - Create a local dependency-tracked task
 *   task list-local            - List local tasks with ready/blocked
 *   task update-local <id>     - Update local task properties
 *
 * Tasks differentiate "ready" vs "blocked" based on dependency resolution.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { computePriorityScore, listTasks } from '../../lib/local-tasks.js';
import { getBackend } from '../../lib/task-backend.js';
import * as closeCmd from '../close.js';
import * as createCmd from '../create.js';
import * as shipCmd from '../ship.js';
import * as updateCmd from '../update.js';

// ============================================================================
// Types (dependency-aware tasks from genie-cli-teams)
// ============================================================================

type TaskStatus = 'ready' | 'in_progress' | 'done' | 'blocked';

interface Task {
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
  const allDone = task.blockedBy.every((id) => allTasks[id]?.status === 'done');
  return allDone ? 'ready' : 'blocked';
}

// ============================================================================
function applyTaskUpdates(task: Task, options: { status?: string; title?: string; blockedBy?: string }): void {
  if (options.status) task.status = options.status as TaskStatus;
  if (options.title) task.title = options.title;
  if (options.blockedBy !== undefined) {
    task.blockedBy = options.blockedBy ? options.blockedBy.split(',').map((s) => s.trim()) : [];
  }
  task.updatedAt = new Date().toISOString();
}

// Local task group display
// ============================================================================

interface TaskWithEffectiveStatus extends Task {
  effectiveStatus: string;
}

function printTaskGroup(
  label: string,
  tasks: TaskWithEffectiveStatus[],
  formatLine?: (t: TaskWithEffectiveStatus) => string,
): void {
  if (tasks.length === 0) return;
  console.log(`\n${label}:`);
  const fmt = formatLine || ((t) => `  ${t.id}: ${t.title}`);
  for (const t of tasks) {
    console.log(fmt(t));
  }
}

function printLocalTaskGroups(tasks: TaskWithEffectiveStatus[], showDone?: boolean): void {
  console.log('');
  console.log('TASKS');
  console.log('='.repeat(60));

  printTaskGroup(
    'In Progress',
    tasks.filter((t) => t.effectiveStatus === 'in_progress'),
  );
  printTaskGroup(
    'Ready',
    tasks.filter((t) => t.effectiveStatus === 'ready'),
  );
  printTaskGroup(
    'Blocked',
    tasks.filter((t) => t.effectiveStatus === 'blocked'),
    (t) => `  ${t.id}: ${t.title} (blocked by: ${t.blockedBy.join(', ')})`,
  );
  if (showDone) {
    printTaskGroup(
      'Done',
      tasks.filter((t) => t.effectiveStatus === 'done'),
    );
  }
  console.log('');
}

// ============================================================================
// Task display helpers
// ============================================================================

const STATUS_EMOJI: Record<string, string> = {
  done: '✅',
  in_progress: '🔄',
  blocked: '🔴',
};

function formatTaskRow(task: ReturnType<typeof listTasks> extends Promise<(infer T)[]> ? T : never): string {
  const id = task.id.padEnd(10).substring(0, 10);
  const type = (task.issueType === 'epic' ? 'epic' : 'task').padEnd(4);
  const emoji = STATUS_EMOJI[task.status] || '⚪';
  const status = `${emoji} ${task.status}`.padEnd(10).substring(0, 10);
  const score = task.priorityScores ? computePriorityScore(task.priorityScores).toFixed(1).padStart(5) : '  —  ';
  const title = task.title.padEnd(48).substring(0, 48);
  return `│ ${id} │ ${type} │ ${status} │ ${score} │ ${title} │`;
}

async function displayLocalTasks(repoPath: string, options: { all?: boolean; json?: boolean }): Promise<void> {
  const tasks = await listTasks(repoPath);
  const filtered = options.all ? tasks : tasks.filter((t) => t.status !== 'done');

  if (options.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log('No tasks found. Use `genie task create "<title>"` to add one.');
    return;
  }

  console.log('');
  console.log('┌────────────┬──────┬────────────┬───────┬──────────────────────────────────────────────────┐');
  console.log('│ ID         │ Type │ Status     │ Score │ Title                                            │');
  console.log('├────────────┼──────┼────────────┼───────┼──────────────────────────────────────────────────┤');
  for (const task of filtered) {
    console.log(formatTaskRow(task));
  }
  console.log('└────────────┴──────┴────────────┴───────┴──────────────────────────────────────────────────┘');
  console.log('');
}

// displayBeadsTasks removed — only local task display remains

// ============================================================================
// Register namespace
// ============================================================================

/**
 * Register the `task` namespace with all subcommands
 */
export function registerTaskNamespace(program: Command): void {
  const taskProgram = program.command('task').description('Task management (dependency-aware)');

  // task create
  taskProgram
    .command('create <title>')
    .description('Create a new task')
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
    .option('--no-sync', 'Skip sync')
    .option('--keep-worktree', "Don't remove the worktree")
    .option('--merge', 'Merge worktree changes to main branch')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (taskId: string, options: closeCmd.CloseOptions) => {
      await closeCmd.closeCommand(taskId, options);
    });

  // task ls
  taskProgram
    .command('ls')
    .alias('ready')
    .description('List ready tasks')
    .option('--all', 'Show all tasks, not just ready')
    .option('--json', 'Output as JSON')
    .action(async (options: { all?: boolean; json?: boolean }) => {
      const repoPath = process.cwd();
      await displayLocalTasks(repoPath, options);
    });

  // task link <wish> <task-id> - Link a task to a wish
  taskProgram
    .command('link <wish-slug> <task-id>')
    .description('Link a task to a wish document')
    .action(async (wishSlug: string, taskId: string) => {
      const { linkTask, wishExists } = await import('../../lib/wish-tasks.js');
      const repoPath = process.cwd();

      if (!(await wishExists(repoPath, wishSlug))) {
        console.error(`❌ Wish "${wishSlug}" not found in .genie/wishes/`);
        process.exit(1);
      }

      // Get task title from local tasks
      let taskTitle = taskId;
      try {
        const taskBackend = getBackend(repoPath);
        const task = await taskBackend.get(taskId);
        if (task) taskTitle = task.title;
      } catch {
        // Use taskId as fallback title
      }

      await linkTask(repoPath, wishSlug, taskId, taskTitle);
      console.log(`✅ Linked ${taskId} → ${wishSlug}`);
    });

  // task unlink <wish> <task-id> - Unlink a task from a wish
  taskProgram
    .command('unlink <wish-slug> <task-id>')
    .description('Unlink a task from a wish document')
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

        const blockedBy = options.blockedBy ? options.blockedBy.split(',').map((s) => s.trim()) : [];

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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
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
          .map((id) => allTasks[id])
          .filter(Boolean)
          .filter((t) => options.all || t.status !== 'done')
          .map((t) => ({
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

        printLocalTaskGroups(tasks, options.all);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
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

        applyTaskUpdates(task, options);
        await saveTasks(repoPath, data);

        console.log(`Task "${id}" updated.`);
        console.log(`  Status: ${task.status}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
