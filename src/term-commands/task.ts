/**
 * Task commands — CLI interface for task lifecycle management.
 *
 * Commands:
 *   genie task create <title> [options]     — Create a new task
 *   genie task list [options]               — List tasks with filters
 *   genie task show <id|#seq>               — Show task detail
 *   genie task move <id|#seq> --to <stage>  — Move task to stage
 *   genie task assign <id|#seq> --to <name> — Assign actor to task
 *   genie task tag <id|#seq> <tags...>      — Add tags to task
 *   genie task comment <id|#seq> <message>  — Comment on task
 *   genie task block <id|#seq> --reason     — Block task
 *   genie task unblock <id|#seq>            — Unblock task
 *   genie task done <id|#seq>               — Mark task done
 *   genie task checkout <id|#seq>           — Claim task for execution
 *   genie task release <id|#seq>            — Release task claim
 *   genie task unlock <id|#seq>             — Force-release stale checkout
 *   genie task dep <id|#seq> [options]      — Manage dependencies
 */

import type { Command } from 'commander';
import type * as taskServiceTypes from '../lib/task-service.js';

// ============================================================================
// Lazy Loaders
// ============================================================================

let _taskService: typeof taskServiceTypes | undefined;
async function getTaskService(): Promise<typeof taskServiceTypes> {
  if (!_taskService) _taskService = await import('../lib/task-service.js');
  return _taskService;
}

// ============================================================================
// Helpers
// ============================================================================

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function truncate(str: string, len: number): string {
  return str.length <= len ? str : `${str.slice(0, len - 1)}…`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Build an Actor from a local name string. */
function localActor(name: string): taskServiceTypes.Actor {
  return { actorType: 'local', actorId: name };
}

/** Detect current actor identity. */
function currentActor(): taskServiceTypes.Actor {
  const name = process.env.GENIE_AGENT_NAME ?? 'cli';
  return localActor(name);
}

/** Generate a run ID for checkout operations. */
function getRunId(): string {
  return process.env.GENIE_RUN_ID ?? `run-${Date.now()}`;
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: '\x1b[31m',
  high: '\x1b[33m',
  normal: '\x1b[0m',
  low: '\x1b[90m',
};
const RESET = '\x1b[0m';

// ============================================================================
// Display Helpers
// ============================================================================

function printTaskList(tasks: taskServiceTypes.TaskRow[]): void {
  if (tasks.length === 0) {
    console.log('No tasks found.');
    return;
  }

  const header = `  ${padRight('#', 6)} ${padRight('TITLE', 40)} ${padRight('STAGE', 12)} ${padRight('STATUS', 12)} ${padRight('PRIORITY', 10)} ${padRight('DUE', 12)}`;
  console.log(header);
  console.log(`  ${'─'.repeat(92)}`);

  for (const t of tasks) {
    const seq = `#${t.seq}`;
    const title = truncate(t.title, 38);
    const color = PRIORITY_COLORS[t.priority] ?? '';
    const due = formatDate(t.dueDate);
    console.log(
      `  ${padRight(seq, 6)} ${padRight(title, 40)} ${padRight(t.stage, 12)} ${padRight(t.status, 12)} ${color}${padRight(t.priority, 10)}${RESET} ${padRight(due, 12)}`,
    );
  }

  console.log(`\n  ${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
}

function printTaskFields(task: taskServiceTypes.TaskRow): void {
  console.log('');
  console.log(`Task #${task.seq}: ${task.title}`);
  console.log('─'.repeat(60));
  console.log(`  ID:         ${task.id}`);
  console.log(`  Type:       ${task.typeId}`);
  console.log(`  Stage:      ${task.stage}`);
  console.log(`  Status:     ${task.status}`);
  console.log(`  Priority:   ${task.priority}`);

  const optionalFields: [string, string | null][] = [
    ['Description', task.description],
    ['Criteria', task.acceptanceCriteria],
    ['Effort', task.estimatedEffort],
    ['Start', task.startDate ? formatDate(task.startDate) : null],
    ['Due', task.dueDate ? formatDate(task.dueDate) : null],
    ['Blocked', task.blockedReason],
    ['Parent', task.parentId],
    ['Release', task.releaseId],
    ['Wish', task.wishFile],
  ];
  for (const [label, value] of optionalFields) {
    if (value) console.log(`  ${padRight(`${label}:`, 12)} ${value}`);
  }

  if (task.checkoutRunId) {
    console.log(`  Checkout:   ${task.checkoutRunId} (since ${formatTimestamp(task.executionLockedAt)})`);
  }
  console.log(`  Created:    ${formatTimestamp(task.createdAt)}`);
  if (task.startedAt) console.log(`  Started:    ${formatTimestamp(task.startedAt)}`);
  if (task.endedAt) console.log(`  Ended:      ${formatTimestamp(task.endedAt)}`);
}

async function printTaskRelations(task: taskServiceTypes.TaskRow): Promise<void> {
  const ts = await getTaskService();

  const actors = await ts.getTaskActors(task.id, task.repoPath);
  if (actors.length > 0) {
    console.log('\n  Actors:');
    for (const a of actors) {
      console.log(`    ${a.role}: ${a.actorId} (${a.actorType})`);
    }
  }

  const tags = await ts.getTaskTags(task.id, task.repoPath);
  if (tags.length > 0) {
    console.log(`\n  Tags: ${tags.map((t) => t.name).join(', ')}`);
  }

  const blockers = await ts.getBlockers(task.id, task.repoPath);
  if (blockers.length > 0) {
    console.log('\n  Dependencies:');
    for (const dep of blockers) {
      const depTask = await ts.getTask(dep.dependsOnId, task.repoPath);
      const label = depTask ? `#${depTask.seq} ${depTask.title}` : dep.dependsOnId;
      console.log(`    ${dep.depType}: ${label}`);
    }
  }

  const stageLog = await ts.getStageLog(task.id, task.repoPath);
  if (stageLog.length > 0) {
    console.log('\n  Stage History:');
    for (const entry of stageLog.slice(0, 10)) {
      const who = entry.actorId ?? 'system';
      console.log(
        `    ${formatTimestamp(entry.createdAt)}: ${entry.fromStage ?? '(new)'} → ${entry.toStage} by ${who}`,
      );
    }
  }
}

async function printTaskMessages(task: taskServiceTypes.TaskRow): Promise<void> {
  const ts = await getTaskService();

  const conv = await ts.findOrCreateConversation({
    linkedEntity: 'task',
    linkedEntityId: task.id,
    name: `Task #${task.seq}`,
  });
  const messages = await ts.getMessages(conv.id, { limit: 20 });
  if (messages.length > 0) {
    console.log('\n  Messages:');
    for (const msg of messages) {
      const time = formatTimestamp(msg.createdAt);
      const reply = msg.replyToId ? ` (reply to #${msg.replyToId})` : '';
      console.log(`    [${time}] ${msg.senderId}: ${msg.body}${reply}`);
    }
  }
}

async function printTaskDetail(task: taskServiceTypes.TaskRow): Promise<void> {
  printTaskFields(task);
  await printTaskRelations(task);
  await printTaskMessages(task);
  console.log('');
}

// ============================================================================
// Command Handlers
// ============================================================================

interface CreateOptions {
  type?: string;
  priority?: string;
  due?: string;
  start?: string;
  tags?: string;
  parent?: string;
  assign?: string;
  description?: string;
  effort?: string;
  comment?: string;
}

async function handleTaskCreate(title: string, options: CreateOptions): Promise<void> {
  const ts = await getTaskService();
  const actor = currentActor();

  // Resolve parent
  let parentId: string | undefined;
  if (options.parent) {
    parentId = (await ts.resolveTaskId(options.parent)) ?? undefined;
    if (!parentId) {
      console.error(`Error: Parent task not found: ${options.parent}`);
      process.exit(1);
    }
  }

  const task = await ts.createTask({
    title,
    typeId: options.type,
    priority: options.priority as 'urgent' | 'high' | 'normal' | 'low',
    dueDate: options.due,
    startDate: options.start,
    parentId,
    description: options.description,
    estimatedEffort: options.effort,
  });

  // Assign creator
  await ts.assignTask(task.id, actor, 'creator', {}, task.repoPath);

  // Assign specified actor
  if (options.assign) {
    await ts.assignTask(task.id, localActor(options.assign), 'assignee', {}, task.repoPath);
  }

  // Tags
  if (options.tags) {
    const tagIds = options.tags.split(',').map((t) => t.trim());
    await ts.tagTask(task.id, tagIds, actor, task.repoPath);
  }

  // Inline comment
  if (options.comment) {
    await ts.commentOnTask(task.id, actor, options.comment, task.repoPath);
  }

  console.log(`Created task #${task.seq}: ${task.title}`);
  console.log(`  ID: ${task.id}`);
  console.log(`  Stage: ${task.stage} | Priority: ${task.priority}`);
  if (options.due) console.log(`  Due: ${options.due}`);
}

// ============================================================================
// Registration
// ============================================================================

export function registerTaskCommands(program: Command): void {
  const task = program.command('task').description('Task lifecycle management');

  // ── task create ──
  task
    .command('create <title>')
    .description('Create a new task')
    .option('--type <type>', 'Task type', 'software')
    .option('--priority <priority>', 'Priority: urgent, high, normal, low', 'normal')
    .option('--due <date>', 'Due date (YYYY-MM-DD)')
    .option('--start <date>', 'Start date (YYYY-MM-DD)')
    .option('--tags <tags>', 'Comma-separated tag IDs')
    .option('--parent <id>', 'Parent task ID or #seq')
    .option('--assign <name>', 'Assign to local actor')
    .option('--description <text>', 'Task description')
    .option('--effort <effort>', 'Estimated effort (e.g., "2h", "3 points")')
    .option('--comment <msg>', 'Initial comment on the task')
    .action(async (title: string, options: CreateOptions) => {
      try {
        await handleTaskCreate(title, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task list ──
  task
    .command('list')
    .description('List tasks with filters')
    .option('--stage <stage>', 'Filter by stage')
    .option('--type <type>', 'Filter by type')
    .option('--status <status>', 'Filter by status')
    .option('--priority <priority>', 'Filter by priority')
    .option('--release <release>', 'Filter by release')
    .option('--due-before <date>', 'Filter by due date')
    .option('--mine', 'Show only tasks assigned to me')
    .option('--json', 'Output as JSON')
    .action(
      async (options: {
        stage?: string;
        type?: string;
        status?: string;
        priority?: string;
        release?: string;
        dueBefore?: string;
        mine?: boolean;
        json?: boolean;
      }) => {
        try {
          const ts = await getTaskService();
          const filters: taskServiceTypes.TaskFilters = {
            stage: options.stage,
            typeId: options.type,
            status: options.status,
            priority: options.priority,
            releaseId: options.release,
            dueBefore: options.dueBefore,
          };

          let tasks: taskServiceTypes.TaskRow[];
          if (options.mine) {
            tasks = await ts.listTasksForActor(currentActor(), filters);
          } else {
            tasks = await ts.listTasks(filters);
          }

          if (options.json) {
            console.log(JSON.stringify(tasks, null, 2));
            return;
          }

          printTaskList(tasks);
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }
      },
    );

  // ── task show ──
  task
    .command('show <id>')
    .description('Show task detail (accepts task-id or #seq)')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        const ts = await getTaskService();
        const t = await ts.getTask(id);
        if (!t) {
          console.error(`Error: Task not found: ${id}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(t, null, 2));
          return;
        }

        await printTaskDetail(t);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task move ──
  task
    .command('move <id>')
    .description('Move task to a new stage')
    .requiredOption('--to <stage>', 'Target stage')
    .option('--comment <msg>', 'Comment on the move')
    .action(async (id: string, options: { to: string; comment?: string }) => {
      try {
        const ts = await getTaskService();
        const actor = currentActor();
        const t = await ts.moveTask(id, options.to, actor, options.comment);
        console.log(`Moved task #${t.seq} to stage "${t.stage}".`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task assign ──
  task
    .command('assign <id>')
    .description('Assign an actor to a task')
    .requiredOption('--to <name>', 'Actor name')
    .option('--role <role>', 'Actor role', 'assignee')
    .option('--comment <msg>', 'Comment on the assignment')
    .action(async (id: string, options: { to: string; role?: string; comment?: string }) => {
      try {
        const ts = await getTaskService();
        const actor = currentActor();
        await ts.assignTask(id, localActor(options.to), options.role, {});
        if (options.comment) {
          await ts.commentOnTask(id, actor, options.comment);
        }
        console.log(`Assigned "${options.to}" as ${options.role ?? 'assignee'} on task ${id}.`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task tag ──
  task
    .command('tag <id> <tags...>')
    .description('Add tags to a task')
    .action(async (id: string, tags: string[]) => {
      try {
        const ts = await getTaskService();
        await ts.tagTask(id, tags, currentActor());
        console.log(`Tagged task ${id} with: ${tags.join(', ')}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task comment ──
  task
    .command('comment <id> <message>')
    .description('Add a comment to a task')
    .option('--reply-to <msgId>', 'Reply to a specific message ID')
    .action(async (id: string, message: string, options: { replyTo?: string }) => {
      try {
        const ts = await getTaskService();
        const replyTo = options.replyTo ? Number(options.replyTo) : undefined;
        const msg = await ts.commentOnTask(id, currentActor(), message, undefined, replyTo);
        console.log(`Comment #${msg.id} added to task ${id}.`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task block ──
  task
    .command('block <id>')
    .description('Mark task as blocked')
    .requiredOption('--reason <reason>', 'Reason for blocking')
    .option('--comment <msg>', 'Additional comment')
    .action(async (id: string, options: { reason: string; comment?: string }) => {
      try {
        const ts = await getTaskService();
        const actor = currentActor();
        const t = await ts.blockTask(id, options.reason, actor, options.comment);
        console.log(`Task #${t.seq} blocked: ${options.reason}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task unblock ──
  task
    .command('unblock <id>')
    .description('Unblock a task')
    .option('--comment <msg>', 'Comment on unblock')
    .action(async (id: string, options: { comment?: string }) => {
      try {
        const ts = await getTaskService();
        const actor = currentActor();
        const t = await ts.unblockTask(id, actor, options.comment);
        console.log(`Task #${t.seq} unblocked.`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task done ──
  task
    .command('done <id>')
    .description('Mark task as done')
    .option('--comment <msg>', 'Comment on completion')
    .action(async (id: string, options: { comment?: string }) => {
      try {
        const ts = await getTaskService();
        const actor = currentActor();
        const t = await ts.markDone(id, actor, options.comment);
        console.log(`Task #${t.seq} marked as done.`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task checkout ──
  task
    .command('checkout <id>')
    .description('Atomically claim a task for execution')
    .action(async (id: string) => {
      try {
        const ts = await getTaskService();
        const runId = getRunId();
        const t = await ts.checkoutTask(id, runId);
        console.log(`Checked out task #${t.seq} for run: ${runId}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task release ──
  task
    .command('release <id>')
    .description('Release task checkout claim')
    .action(async (id: string) => {
      try {
        const ts = await getTaskService();
        const runId = getRunId();
        const t = await ts.releaseTask(id, runId);
        console.log(`Released task #${t.seq} from run: ${runId}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task unlock ──
  task
    .command('unlock <id>')
    .description('Force-release a stale checkout (admin override)')
    .action(async (id: string) => {
      try {
        const ts = await getTaskService();
        const t = await ts.forceUnlockTask(id);
        console.log(`Force-unlocked task #${t.seq}.`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── task dep ──
  task
    .command('dep <id>')
    .description('Manage task dependencies')
    .option('--depends-on <id2>', 'This task depends on id2')
    .option('--blocks <id2>', 'This task blocks id2')
    .option('--relates-to <id2>', 'This task relates to id2')
    .option('--remove <id2>', 'Remove dependency on id2')
    .action(
      async (
        id: string,
        options: {
          dependsOn?: string;
          blocks?: string;
          relatesTo?: string;
          remove?: string;
        },
      ) => {
        try {
          const ts = await getTaskService();

          if (options.remove) {
            const removed = await ts.removeDependency(id, options.remove);
            if (removed) {
              console.log(`Removed dependency between ${id} and ${options.remove}.`);
            } else {
              console.log('No dependency found to remove.');
            }
            return;
          }

          if (options.dependsOn) {
            await ts.addDependency(id, options.dependsOn, 'depends_on');
            console.log(`${id} now depends on ${options.dependsOn}.`);
          }
          if (options.blocks) {
            await ts.addDependency(id, options.blocks, 'blocks');
            console.log(`${id} now blocks ${options.blocks}.`);
          }
          if (options.relatesTo) {
            await ts.addDependency(id, options.relatesTo, 'relates_to');
            console.log(`${id} now relates to ${options.relatesTo}.`);
          }

          if (!options.dependsOn && !options.blocks && !options.relatesTo) {
            console.error('Error: Specify --depends-on, --blocks, --relates-to, or --remove.');
            process.exit(1);
          }
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }
      },
    );
}
