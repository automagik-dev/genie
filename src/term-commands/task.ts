/**
 * Task commands — CLI interface for task lifecycle management.
 *
 * Commands:
 *   genie task create <title> [options]     — Create a new task
 *   genie task close-merged [options]       — Auto-close tasks from merged PRs
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
 *   genie task link <id|#seq> [options]     — Link task to external tracker
 *   genie task dep <id|#seq> [options]      — Manage dependencies
 */

import type { Command } from 'commander';
import type * as taskServiceTypes from '../lib/task-service.js';
import { formatDate, formatTimestamp, padRight, truncate } from '../lib/term-format.js';

// ============================================================================
// Lazy Loaders
// ============================================================================

let _taskService: typeof taskServiceTypes | undefined;
async function getTaskService(): Promise<typeof taskServiceTypes> {
  if (!_taskService) _taskService = await import('../lib/task-service.js');
  return _taskService;
}

let _boardService: typeof import('../lib/board-service.js') | undefined;
async function getBoardService() {
  if (!_boardService) _boardService = await import('../lib/board-service.js');
  return _boardService;
}

let _closeMergedService: typeof import('../lib/task-close-merged.js') | undefined;
async function getCloseMergedService() {
  if (!_closeMergedService) _closeMergedService = await import('../lib/task-close-merged.js');
  return _closeMergedService;
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

async function resolveDefaultBoardId(): Promise<string | null> {
  try {
    const { execSync } = await import('node:child_process');
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    const { join } = await import('node:path');
    const configPath = join(repoRoot, '.genie', 'config.json');
    const { existsSync, readFileSync } = await import('node:fs');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.activeBoard) return config.activeBoard as string;
    }
  } catch {}
  return null;
}

async function handleInvalidStageError(taskId: string, message: string): Promise<void> {
  try {
    const ts = await getTaskService();
    const task = await ts.getTask(taskId);
    if (!task?.boardId) return;
    const bs = await getBoardService();
    const board = await bs.getBoard(task.boardId);
    if (!board) return;
    const validCols = board.columns
      .sort((a, b) => a.position - b.position)
      .map((c) => c.name)
      .join(' → ');
    console.error(`Error: ${message}\nValid columns for board "${board.name}": ${validCols}`);
    process.exit(1);
  } catch {}
}

async function resolveBoardOption(boardName?: string): Promise<string | undefined> {
  if (boardName) {
    const bs = await getBoardService();
    const board = await bs.getBoard(boardName);
    if (!board) {
      console.error(`Error: Board not found: ${boardName}`);
      process.exit(1);
    }
    return board.id;
  }
  const defaultId = await resolveDefaultBoardId();
  return defaultId ?? undefined;
}

// ============================================================================
// Display Helpers
// ============================================================================

function getProjectName(repoPath: string): string {
  const parts = repoPath.split('/');
  return parts[parts.length - 1] || repoPath;
}

function formatTaskRow(t: taskServiceTypes.TaskRow, showProject: boolean, hasExternal: boolean): string {
  const seq = showProject ? `${getProjectName(t.repoPath)}#${t.seq}` : `#${t.seq}`;
  const title = truncate(t.title, 38);
  const color = PRIORITY_COLORS[t.priority] ?? '';
  const due = formatDate(t.dueDate);
  const proj = showProject ? `${padRight(getProjectName(t.repoPath), 16)} ` : '';
  const ext = hasExternal ? `${padRight(truncate(t.externalId ?? '', 25), 27)} ` : '';
  return `  ${padRight(seq, showProject ? 22 : 6)} ${proj}${padRight(title, 40)} ${ext}${padRight(t.stage, 12)} ${padRight(t.status, 12)} ${color}${padRight(t.priority, 10)}${RESET} ${padRight(due, 12)}`;
}

function printTaskList(tasks: taskServiceTypes.TaskRow[], showProject = false): void {
  if (tasks.length === 0) {
    console.log('No tasks found.');
    return;
  }

  const hasExternal = tasks.some((t) => t.externalId);
  const extCol = hasExternal ? `${padRight('EXTERNAL', 27)} ` : '';
  const projCol = showProject ? `${padRight('PROJECT', 16)} ` : '';
  const header = `  ${padRight('#', 6)} ${projCol}${padRight('TITLE', 40)} ${extCol}${padRight('STAGE', 12)} ${padRight('STATUS', 12)} ${padRight('PRIORITY', 10)} ${padRight('DUE', 12)}`;
  const lineLen = (showProject ? 108 : 92) + (hasExternal ? 28 : 0);
  console.log(header);
  console.log(`  ${'─'.repeat(lineLen)}`);

  for (const t of tasks) {
    console.log(formatTaskRow(t, showProject, hasExternal));
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
    ['External', task.externalId],
    ['Ext URL', task.externalUrl],
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

function printColumnTasks(label: string, colTasks: taskServiceTypes.TaskRow[], useColor = true): void {
  console.log(`\n── ${label} (${colTasks.length} task${colTasks.length === 1 ? '' : 's'}) ──`);
  if (colTasks.length === 0) {
    console.log('  (empty)');
    return;
  }
  for (const t of colTasks) {
    const pc = useColor ? (PRIORITY_COLORS[t.priority] ?? '') : '';
    const reset = useColor ? RESET : '';
    console.log(
      `  ${pc}#${t.seq}${reset}  ${padRight(truncate(t.title, 35), 37)}  ${padRight(t.status, 14)}  ${t.priority}`,
    );
  }
}

async function printByColumn(tasks: taskServiceTypes.TaskRow[], boardName: string): Promise<void> {
  const bs = await getBoardService();
  const board = await bs.getBoard(boardName);
  if (!board) {
    console.error(`Error: Board not found: ${boardName}`);
    process.exit(1);
  }

  console.log(`\nBoard: ${board.name} (${board.id})`);
  console.log('═'.repeat(40));

  const columns = [...board.columns].sort((a, b) => a.position - b.position);
  for (const col of columns) {
    printColumnTasks(
      col.label,
      tasks.filter((t) => t.columnId === col.id),
    );
  }

  // Orphaned tasks (column_id doesn't match any column)
  const columnIds = new Set(columns.map((c) => c.id));
  const orphaned = tasks.filter((t) => t.columnId && !columnIds.has(t.columnId));
  if (orphaned.length > 0) {
    printColumnTasks('Orphaned', orphaned, false);
  }

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
  project?: string;
  board?: string;
  gh?: string;
  externalId?: string;
  externalUrl?: string;
}

/** Parse --gh owner/repo#N into { externalId, externalUrl }. */
function parseGhRef(gh: string): { externalId: string; externalUrl: string } {
  const match = gh.match(/^([^#]+)#(\d+)$/);
  if (!match) {
    console.error(`Error: Invalid --gh format. Expected owner/repo#N, got: ${gh}`);
    process.exit(1);
  }
  const [, ownerRepo, num] = match;
  return {
    externalId: `${ownerRepo}#${num}`,
    externalUrl: `https://github.com/${ownerRepo}/issues/${num}`,
  };
}

async function handleTaskCreate(title: string, options: CreateOptions): Promise<void> {
  const ts = await getTaskService();
  const actor = currentActor();

  // Resolve project → repoPath + projectId override
  let repoPath: string | undefined;
  let projectId: string | undefined;
  if (options.project) {
    let project = await ts.getProjectByName(options.project);
    if (!project) {
      // Auto-create virtual project if --project used with unknown name
      project = await ts.createProject({ name: options.project });
    }
    projectId = project.id;
    repoPath = project.repoPath ?? undefined;
  }

  // Resolve parent
  let parentId: string | undefined;
  if (options.parent) {
    parentId = (await ts.resolveTaskId(options.parent, repoPath)) ?? undefined;
    if (!parentId) {
      console.error(`Error: Parent task not found: ${options.parent}`);
      process.exit(1);
    }
  }

  const boardId = await resolveBoardOption(options.board);

  // Resolve external linking: --gh takes priority over --external-id/--external-url
  let externalId: string | undefined = options.externalId;
  let externalUrl: string | undefined = options.externalUrl;
  if (options.gh) {
    const parsed = parseGhRef(options.gh);
    externalId = parsed.externalId;
    externalUrl = parsed.externalUrl;
  }

  const task = await ts.createTask(
    {
      title,
      typeId: options.type,
      priority: options.priority as 'urgent' | 'high' | 'normal' | 'low',
      dueDate: options.due,
      startDate: options.start,
      parentId,
      description: options.description,
      estimatedEffort: options.effort,
      boardId,
      externalId,
      externalUrl,
    },
    repoPath,
    projectId,
  );

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

async function handleCloseMerged(options: { since?: string; dryRun?: boolean; repo?: string }): Promise<void> {
  const svc = await getCloseMergedService();
  const result = await svc.closeMergedTasks({
    since: options.since,
    dryRun: options.dryRun,
    repo: options.repo,
  });

  if (options.dryRun) console.log('[dry-run] Would close:');

  for (const d of result.details) {
    const prefix = options.dryRun ? '  [dry-run]' : '  \u2713';
    console.log(`${prefix} #${d.taskSeq} "${d.taskTitle}" \u2190 PR #${d.prNumber} (${d.slug})`);
  }

  const mode = options.dryRun ? '[dry-run] ' : '';
  console.log(
    `\n${mode}Closed ${result.closed} task${result.closed === 1 ? '' : 's'} from ${result.prsScanned} merged PR${result.prsScanned === 1 ? '' : 's'} (${result.alreadyShipped} already shipped)`,
  );
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
    .option('--project <name>', 'Create task in a specific project (overrides CWD)')
    .option('--board <name>', 'Board name to assign task to')
    .option('--gh <owner/repo#N>', 'Link to GitHub issue (sets external_id + external_url)')
    .option('--external-id <id>', 'External tracker ID (e.g., JIRA-123)')
    .option('--external-url <url>', 'External tracker URL')
    .action(async (title: string, options: CreateOptions) => {
      try {
        await handleTaskCreate(title, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // biome-ignore lint/suspicious/noExplicitAny: options from commander
  async function handleTaskList(options: any): Promise<void> {
    const ts = await getTaskService();
    const filters: taskServiceTypes.TaskFilters = {
      stage: options.stage,
      typeId: options.type,
      status: options.status,
      priority: options.priority,
      releaseId: options.release,
      dueBefore: options.dueBefore,
      projectName: options.project,
      boardName: options.board,
      externalId: options.gh ? parseGhRef(options.gh).externalId : undefined,
      allProjects: options.all,
      limit: Number(options.limit) || 100,
      offset: Number(options.offset) || 0,
      ...(options.all ? { limit: 10000 } : {}),
    };

    let tasks: taskServiceTypes.TaskRow[];
    if (options.mine) {
      tasks = await ts.listTasksForActor(currentActor(), filters);
    } else {
      tasks = await ts.listTasks(filters);
    }

    if (options.byColumn) {
      if (!options.board) {
        console.error('Error: --by-column requires --board');
        process.exit(1);
      }
      if (!options.includeDone) {
        tasks = tasks.filter((t) => t.status !== 'done');
      }
      await printByColumn(tasks, options.board);
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(tasks, null, 2));
      return;
    }

    printTaskList(tasks, options.all);
  }

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
    .option('--project <name>', 'Show tasks for a specific project')
    .option('--board <name>', 'Filter by board name')
    .option('--gh <owner/repo#N>', 'Filter by GitHub issue link')
    .option('--by-column', 'Group tasks by board column (kanban view)')
    .option('--include-done', 'Include done tasks in kanban view (hidden by default)')
    .option('--all', 'Show tasks from ALL projects')
    .option('--limit <n>', 'Max number of tasks to return', '100')
    .option('--offset <n>', 'Skip first N tasks (for pagination)', '0')
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
        project?: string;
        board?: string;
        gh?: string;
        byColumn?: boolean;
        includeDone?: boolean;
        all?: boolean;
        limit?: string;
        offset?: string;
        json?: boolean;
      }) => {
        try {
          await handleTaskList(options);
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

  // ── task link ──
  task
    .command('link <id>')
    .description('Link task to an external tracker (GitHub, Jira, etc.)')
    .option('--gh <owner/repo#N>', 'Link to GitHub issue')
    .option('--external-id <id>', 'External tracker ID')
    .option('--external-url <url>', 'External tracker URL')
    .action(async (id: string, options: { gh?: string; externalId?: string; externalUrl?: string }) => {
      try {
        const ts = await getTaskService();
        let externalId: string;
        let externalUrl: string;

        if (options.gh) {
          const parsed = parseGhRef(options.gh);
          externalId = parsed.externalId;
          externalUrl = parsed.externalUrl;
        } else if (options.externalId && options.externalUrl) {
          externalId = options.externalId;
          externalUrl = options.externalUrl;
        } else {
          console.error('Error: Provide --gh or both --external-id and --external-url.');
          process.exit(1);
        }

        const t = await ts.linkTask(id, externalId, externalUrl);
        if (!t) {
          console.error(`Error: Task not found: ${id}`);
          process.exit(1);
        }
        console.log(`Linked task #${t.seq} to ${externalId}`);
        if (t.externalUrl) console.log(`  URL: ${t.externalUrl}`);
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
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Invalid stage')) {
          await handleInvalidStageError(id, message);
        }
        console.error(`Error: ${message}`);
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

  // ── task close-merged ──
  task
    .command('close-merged')
    .description('Auto-close tasks whose wish slugs match recently merged PRs')
    .option('--since <duration>', 'Time window for merged PRs (e.g., "24h", "7d")', '24h')
    .option('--dry-run', 'Show what would be closed without acting')
    .option('--repo <owner/repo>', 'Override GitHub remote detection')
    .action(async (options: { since?: string; dryRun?: boolean; repo?: string }) => {
      try {
        await handleCloseMerged(options);
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
