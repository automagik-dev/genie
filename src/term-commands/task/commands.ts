/**
 * Task types and helpers — dependency tracking.
 *
 * NOTE: The `genie task` CLI namespace was removed in G7.
 * Task management is now handled via the wish state machine.
 * Internal types and display helpers remain for programmatic use.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computePriorityScore, listTasks } from '../../lib/local-tasks.js';

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
// NOTE: Task namespace removed in G7 — commands no longer registered via CLI.
// Task management is handled via wish state machine (genie state).
// Internal types and helpers above remain available for programmatic use.

// Kept for backwards compatibility — not registered as CLI commands.
