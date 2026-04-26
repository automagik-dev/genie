/**
 * Task Service — PG CRUD for all 11 task lifecycle tables.
 *
 * Provides functions for tasks, actors, dependencies, conversations,
 * messages, tags, types, releases, notifications, and execution locking.
 *
 * All queries scoped by repo_path. Uses postgres.js tagged templates via getConnection().
 */

import { execSync } from 'node:child_process';
import { palette } from '../../packages/genie-tokens';
import { getActor, recordAuditEvent } from './audit.js';
import { type Sql, getConnection } from './db.js';

// ============================================================================
// Types
// ============================================================================

export interface Actor {
  actorType: 'local' | 'genie_os_user' | 'omni_agent';
  actorId: string;
}

interface TaskInput {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  typeId?: string;
  stage?: string;
  status?: string;
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  parentId?: string;
  wishFile?: string;
  groupName?: string;
  startDate?: string;
  dueDate?: string;
  estimatedEffort?: string;
  blockedReason?: string;
  releaseId?: string;
  boardId?: string;
  columnId?: string;
  externalId?: string;
  externalUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectRow {
  id: string;
  name: string;
  repoPath: string | null;
  description: string | null;
  leaderAgent: string | null;
  tmuxSession: string | null;
  status: string;
  archivedAt: string | null;
  createdAt: string;
}

export interface TaskRow {
  id: string;
  seq: number;
  parentId: string | null;
  repoPath: string;
  projectId: string | null;
  genieOsFolderId: string | null;
  wishFile: string | null;
  groupName: string | null;
  title: string;
  description: string | null;
  acceptanceCriteria: string | null;
  typeId: string;
  stage: string;
  status: string;
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  estimatedEffort: string | null;
  startedAt: string | null;
  endedAt: string | null;
  blockedReason: string | null;
  releaseId: string | null;
  checkoutRunId: string | null;
  executionLockedAt: string | null;
  checkoutTimeoutMs: number;
  sessionId: string | null;
  paneId: string | null;
  traceId: string | null;
  boardId: string | null;
  columnId: string | null;
  externalId: string | null;
  externalUrl: string | null;
  archivedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskFilters {
  repoPath?: string;
  projectName?: string;
  allProjects?: boolean;
  stage?: string;
  status?: string;
  priority?: string;
  typeId?: string;
  parentId?: string | null;
  releaseId?: string;
  boardId?: string;
  boardName?: string;
  dueBefore?: string;
  externalId?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

interface TaskActorRow {
  taskId: string;
  actorType: string;
  actorId: string;
  role: string;
  permissions: Record<string, unknown>;
  createdAt: string;
}

interface DependencyRow {
  taskId: string;
  dependsOnId: string;
  depType: string;
  createdAt: string;
}

export interface ConversationRow {
  id: string;
  parentMessageId: number | null;
  name: string | null;
  type: string;
  linkedEntity: string | null;
  linkedEntityId: string | null;
  createdByType: string | null;
  createdById: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ConversationMemberRow {
  conversationId: string;
  actorType: string;
  actorId: string;
  role: string;
  joinedAt: string;
}

interface MessageRow {
  id: number;
  conversationId: string;
  replyToId: number | null;
  senderType: string;
  senderId: string;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface TagRow {
  id: string;
  name: string;
  color: string;
  typeId: string | null;
  createdAt: string;
}

export interface TaskTypeRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  stages: unknown[];
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationPrefRow {
  actorType: string;
  actorId: string;
  channel: string;
  priorityThreshold: string;
  isDefault: boolean;
  enabled: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface StageLogRow {
  id: number;
  taskId: string;
  fromStage: string | null;
  toStage: string;
  actorType: string | null;
  actorId: string | null;
  runId: string | null;
  gateType: string | null;
  createdAt: string;
}

interface FindOrCreateConversationOpts {
  type?: 'dm' | 'group';
  name?: string;
  linkedEntity?: string;
  linkedEntityId?: string;
  parentMessageId?: number;
  members?: Actor[];
  createdBy?: Actor;
}

interface MessageListOpts {
  limit?: number;
  offset?: number;
  since?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function str(v: unknown): string | null {
  return v != null ? String(v) : null;
}

function strOrDefault(v: unknown, def: string): string {
  return v != null ? String(v) : def;
}

/** Map snake_case DB row to camelCase. */
function mapTask(row: Record<string, unknown>): TaskRow {
  return {
    id: row.id as string,
    seq: row.seq as number,
    parentId: str(row.parent_id),
    repoPath: row.repo_path as string,
    projectId: str(row.project_id),
    genieOsFolderId: str(row.genie_os_folder_id),
    wishFile: str(row.wish_file),
    groupName: str(row.group_name),
    title: row.title as string,
    description: str(row.description),
    acceptanceCriteria: str(row.acceptance_criteria),
    typeId: row.type_id as string,
    stage: row.stage as string,
    status: row.status as string,
    priority: row.priority as string,
    startDate: str(row.start_date),
    dueDate: str(row.due_date),
    estimatedEffort: str(row.estimated_effort),
    startedAt: str(row.started_at),
    endedAt: str(row.ended_at),
    blockedReason: str(row.blocked_reason),
    releaseId: str(row.release_id),
    checkoutRunId: str(row.checkout_run_id),
    executionLockedAt: str(row.execution_locked_at),
    checkoutTimeoutMs: (row.checkout_timeout_ms as number) ?? 600000,
    sessionId: str(row.session_id),
    paneId: str(row.pane_id),
    traceId: str(row.trace_id),
    boardId: str(row.board_id),
    columnId: str(row.column_id),
    externalId: str(row.external_id),
    externalUrl: str(row.external_url),
    archivedAt: str(row.archived_at),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: strOrDefault(row.created_at, ''),
    updatedAt: strOrDefault(row.updated_at, ''),
  };
}

function mapConversation(row: Record<string, unknown>): ConversationRow {
  return {
    id: row.id as string,
    parentMessageId: row.parent_message_id != null ? Number(row.parent_message_id) : null,
    name: (row.name as string) ?? null,
    type: row.type as string,
    linkedEntity: (row.linked_entity as string) ?? null,
    linkedEntityId: (row.linked_entity_id as string) ?? null,
    createdByType: (row.created_by_type as string) ?? null,
    createdById: (row.created_by_id as string) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMessage(row: Record<string, unknown>): MessageRow {
  return {
    id: Number(row.id),
    conversationId: row.conversation_id as string,
    replyToId: row.reply_to_id != null ? Number(row.reply_to_id) : null,
    senderType: row.sender_type as string,
    senderId: row.sender_id as string,
    body: row.body as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapTaskActor(row: Record<string, unknown>): TaskActorRow {
  return {
    taskId: row.task_id as string,
    actorType: row.actor_type as string,
    actorId: row.actor_id as string,
    role: row.role as string,
    permissions: (row.permissions as Record<string, unknown>) ?? {},
    createdAt: String(row.created_at),
  };
}

function mapDependency(row: Record<string, unknown>): DependencyRow {
  return {
    taskId: row.task_id as string,
    dependsOnId: row.depends_on_id as string,
    depType: row.dep_type as string,
    createdAt: String(row.created_at),
  };
}

function mapTag(row: Record<string, unknown>): TagRow {
  return {
    id: row.id as string,
    name: row.name as string,
    color: (row.color as string) ?? palette.textDim,
    typeId: (row.type_id as string) ?? null,
    createdAt: String(row.created_at),
  };
}

function mapTaskType(row: Record<string, unknown>): TaskTypeRow {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? null,
    icon: (row.icon as string) ?? null,
    stages: row.stages as unknown[],
    isBuiltin: row.is_builtin as boolean,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapNotificationPref(row: Record<string, unknown>): NotificationPrefRow {
  return {
    actorType: row.actor_type as string,
    actorId: row.actor_id as string,
    channel: row.channel as string,
    priorityThreshold: row.priority_threshold as string,
    isDefault: row.is_default as boolean,
    enabled: row.enabled as boolean,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapStageLog(row: Record<string, unknown>): StageLogRow {
  return {
    id: Number(row.id),
    taskId: row.task_id as string,
    fromStage: (row.from_stage as string) ?? null,
    toStage: row.to_stage as string,
    actorType: (row.actor_type as string) ?? null,
    actorId: (row.actor_id as string) ?? null,
    runId: (row.run_id as string) ?? null,
    gateType: (row.gate_type as string) ?? null,
    createdAt: String(row.created_at),
  };
}

function mapConversationMember(row: Record<string, unknown>): ConversationMemberRow {
  return {
    conversationId: row.conversation_id as string,
    actorType: row.actor_type as string,
    actorId: row.actor_id as string,
    role: row.role as string,
    joinedAt: String(row.joined_at),
  };
}

function mapProject(row: Record<string, unknown>): ProjectRow {
  return {
    id: row.id as string,
    name: row.name as string,
    repoPath: str(row.repo_path),
    description: str(row.description),
    leaderAgent: str(row.leader_agent),
    tmuxSession: str(row.tmux_session),
    status: strOrDefault(row.status, 'active'),
    archivedAt: str(row.archived_at),
    createdAt: String(row.created_at),
  };
}

// ============================================================================
// Repo Path Resolution
// ============================================================================

/** Resolve repo root via `git rev-parse --show-toplevel`, fallback to cwd. */
function getRepoPath(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

// ============================================================================
// ID Resolution
// ============================================================================

/** Resolve `#47` (seq), `project#seq`, or `task-abc123` (PK) to internal ID. */
export async function resolveTaskId(idOrSeq: string, repoPath?: string): Promise<string | null> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();

  // project#seq format — e.g. "genie#1", "wk-resilience#17"
  const projectSeqMatch = idOrSeq.match(/^([^#]+)#(\d+)$/);
  if (projectSeqMatch && !idOrSeq.startsWith('#')) {
    const [, projectName, seqStr] = projectSeqMatch;
    const seq = Number.parseInt(seqStr, 10);
    if (Number.isNaN(seq)) return null;
    const rows = await sql`
      SELECT t.id FROM tasks t
      JOIN projects p ON t.project_id = p.id
      WHERE p.name = ${projectName} AND t.seq = ${seq}
      LIMIT 1
    `;
    return rows.length > 0 ? (rows[0].id as string) : null;
  }

  if (idOrSeq.startsWith('#')) {
    const seq = Number.parseInt(idOrSeq.slice(1), 10);
    if (Number.isNaN(seq)) return null;
    const rows = await sql`SELECT id FROM tasks WHERE repo_path = ${repo} AND seq = ${seq} LIMIT 1`;
    return rows.length > 0 ? (rows[0].id as string) : null;
  }

  // Try as direct PK
  const rows = await sql`SELECT id FROM tasks WHERE id = ${idOrSeq} LIMIT 1`;
  return rows.length > 0 ? (rows[0].id as string) : null;
}

// ============================================================================
// Projects CRUD
// ============================================================================

/** Create a new project. repoPath=null for virtual projects. */
export async function createProject(input: {
  name: string;
  repoPath?: string | null;
  description?: string | null;
}): Promise<ProjectRow> {
  const sql = await getConnection();
  const rows = await sql`
    INSERT INTO projects (name, repo_path, description)
    VALUES (${input.name}, ${input.repoPath ?? null}, ${input.description ?? null})
    RETURNING *
  `;
  return mapProject(rows[0]);
}

/** List all projects. */
export async function listProjects(): Promise<ProjectRow[]> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM projects ORDER BY name`;
  return rows.map(mapProject);
}

/** Get a project by its unique name/slug. */
export async function getProjectByName(name: string): Promise<ProjectRow | null> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM projects WHERE name = ${name} LIMIT 1`;
  return rows.length > 0 ? mapProject(rows[0]) : null;
}

/** Get a project by its repo_path. */
export async function getProjectByRepoPath(repoPath: string): Promise<ProjectRow | null> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM projects WHERE repo_path = ${repoPath} LIMIT 1`;
  return rows.length > 0 ? mapProject(rows[0]) : null;
}

/**
 * Ensure a project exists for a given repo path. Auto-creates from basename on first use.
 * Returns the project ID.
 */
export async function ensureProject(repoPath: string): Promise<string> {
  const sql = await getConnection();

  // Check if project already exists for this repo_path
  const existing = await sql`SELECT id FROM projects WHERE repo_path = ${repoPath} LIMIT 1`;
  if (existing.length > 0) return existing[0].id as string;

  // Auto-create: name = basename of repo path
  const parts = repoPath.split('/');
  const name = parts[parts.length - 1] || repoPath;

  // Use ON CONFLICT to handle concurrent auto-creation race
  const rows = await sql`
    INSERT INTO projects (name, repo_path)
    VALUES (${name}, ${repoPath})
    ON CONFLICT (name) DO UPDATE SET repo_path = COALESCE(projects.repo_path, EXCLUDED.repo_path)
    RETURNING id
  `;
  return rows[0].id as string;
}

// ============================================================================
// Tasks CRUD
// ============================================================================

function toDateOrNull(v?: string): Date | null {
  return v ? new Date(v) : null;
}

/** Resolve a stage name to a column_id within a board's columns JSONB. */
async function resolveColumnId(sql: Sql, boardId: string, stageName: string): Promise<string | null> {
  const rows = await sql`SELECT columns FROM boards WHERE id = ${boardId} LIMIT 1`;
  if (rows.length === 0) return null;
  const columns = rows[0].columns as { id: string; name: string }[];
  const match = columns.find((c: { name: string }) => c.name === stageName);
  return match?.id ?? null;
}

/** Nullable fields with null default. */
function taskNullables(input: TaskInput) {
  return {
    desc: input.description ?? null,
    ac: input.acceptanceCriteria ?? null,
    parent: input.parentId ?? null,
    wish: input.wishFile ?? null,
    group: input.groupName ?? null,
    effort: input.estimatedEffort ?? null,
    blocked: input.blockedReason ?? null,
    release: input.releaseId ?? null,
    boardId: input.boardId ?? null,
    columnId: (input.columnId as string | null) ?? null,
    externalId: input.externalId ?? null,
    externalUrl: input.externalUrl ?? null,
  };
}

/** Extract and normalize task input fields with defaults. */
function buildTaskVals(input: TaskInput) {
  return {
    ...taskNullables(input),
    type: input.typeId ?? 'software',
    stage: input.stage, // resolved in createTask via type lookup
    status: input.status ?? 'ready',
    priority: input.priority ?? 'normal',
  };
}

export async function createTask(input: TaskInput, repoPath?: string, projectId?: string): Promise<TaskRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();

  // Auto-ensure project for this repo path (or use explicit projectId)
  const projId = projectId ?? (await ensureProject(repo));
  const vals = buildTaskVals(input);

  // Resolve default stage from the task type when not explicitly provided
  if (!vals.stage) {
    const taskType = await getType(vals.type);
    const stages = taskType?.stages as Array<{ name?: string }> | undefined;
    vals.stage = stages?.[0]?.name ?? 'draft';
  }

  // If boardId provided and stage given, resolve stage name -> column_id
  if (vals.boardId && !vals.columnId && vals.stage) {
    vals.columnId = await resolveColumnId(sql, vals.boardId, vals.stage);
  }

  const rows = await sql`
    INSERT INTO tasks (
      repo_path, project_id, title, description, acceptance_criteria,
      type_id, stage, status, priority,
      parent_id, wish_file, group_name,
      start_date, due_date, estimated_effort,
      blocked_reason, release_id, board_id, column_id,
      external_id, external_url, metadata
    ) VALUES (
      ${repo},
      ${projId},
      ${input.title},
      ${vals.desc},
      ${vals.ac},
      ${vals.type},
      ${vals.stage},
      ${vals.status},
      ${vals.priority},
      ${vals.parent},
      ${vals.wish},
      ${vals.group},
      ${toDateOrNull(input.startDate)},
      ${toDateOrNull(input.dueDate)},
      ${vals.effort},
      ${vals.blocked},
      ${vals.release},
      ${vals.boardId},
      ${vals.columnId},
      ${vals.externalId},
      ${vals.externalUrl},
      ${sql.json(input.metadata ?? {})}
    )
    RETURNING *
  `;
  const task = mapTask(rows[0]);

  // Auto-brain: create ephemeral brain when explicitly requested via metadata { brain: true }
  if (input.metadata?.brain) {
    try {
      // @ts-expect-error — brain is enterprise-only, not in genie's deps
      const brain = await import('@khal-os/brain');
      if (brain.taskBrain) {
        await brain.taskBrain({ taskId: String(task.id), workdir: repo });
      }
    } catch {
      /* brain not installed — fine, no behavior change */
    }
  }

  return task;
}

export async function getTask(idOrSeq: string, repoPath?: string): Promise<TaskRow | null> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();

  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) return null;

  const rows = await sql`SELECT * FROM tasks WHERE id = ${id}`;
  return rows.length > 0 ? mapTask(rows[0]) : null;
}

/** Build scope conditions for task listing (project/repo/all). */
function buildScopeConditions(filters: TaskFilters, conditions: string[], values: unknown[], startIdx: number): number {
  let paramIdx = startIdx;
  if (filters.projectName) {
    // Explicit project filter always applies (even with --all)
    conditions.push(`project_id = (SELECT id FROM projects WHERE name = $${paramIdx++})`);
    values.push(filters.projectName);
  } else if (filters.allProjects) {
    // No repo scoping — show all projects
  } else {
    conditions.push(`repo_path = $${paramIdx++}`);
    values.push(filters.repoPath ?? getRepoPath());
  }
  return paramIdx;
}

/** Build field-level filter conditions. */
function buildFieldConditions(
  filters: TaskFilters,
  conditions: string[],
  values: unknown[],
  startIdx: number,
  colPrefix = '',
): number {
  let paramIdx = startIdx;
  const simple: [string, string | undefined][] = [
    ['stage', filters.stage],
    ['status', filters.status],
    ['priority', filters.priority],
    ['type_id', filters.typeId],
    ['release_id', filters.releaseId],
  ];
  for (const [col, val] of simple) {
    if (val) {
      conditions.push(`${colPrefix}${col} = $${paramIdx++}`);
      values.push(val);
    }
  }
  // Exclude archived by default unless explicitly filtered or includeArchived
  if (!filters.status && !filters.includeArchived) {
    conditions.push(`${colPrefix}status != 'archived'`);
  }
  if (filters.parentId !== undefined) {
    if (filters.parentId === null) {
      conditions.push('parent_id IS NULL');
    } else {
      conditions.push(`parent_id = $${paramIdx++}`);
      values.push(filters.parentId);
    }
  }
  if (filters.boardId) {
    conditions.push(`board_id = $${paramIdx++}`);
    values.push(filters.boardId);
  }
  if (filters.boardName) {
    conditions.push(`board_id IN (SELECT id FROM boards WHERE name = $${paramIdx++})`);
    values.push(filters.boardName);
  }
  if (filters.externalId) {
    conditions.push(`external_id = $${paramIdx++}`);
    values.push(filters.externalId);
  }
  if (filters.dueBefore) {
    conditions.push(`due_date <= $${paramIdx++}`);
    values.push(new Date(filters.dueBefore));
  }
  return paramIdx;
}

export async function listTasks(filters: TaskFilters = {}): Promise<TaskRow[]> {
  const sql = await getConnection();
  const conditions: string[] = [];
  const values: unknown[] = [];

  let paramIdx = buildScopeConditions(filters, conditions, values, 1);
  paramIdx = buildFieldConditions(filters, conditions, values, paramIdx);

  const where = conditions.length > 0 ? conditions.join(' AND ') : '1=1';
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const query = `SELECT * FROM tasks WHERE ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  values.push(limit, offset);

  const rows = await sql.unsafe(query, values);
  return rows.map(mapTask);
}

export async function updateTask(
  idOrSeq: string,
  updates: Partial<TaskInput>,
  repoPath?: string,
  comment?: { actor: Actor; body: string },
): Promise<TaskRow | null> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) return null;

  // Build SET clauses dynamically
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  let paramIdx = 1;

  const fieldMap: Record<string, [string, unknown]> = {
    title: ['title', updates.title],
    description: ['description', updates.description],
    acceptanceCriteria: ['acceptance_criteria', updates.acceptanceCriteria],
    stage: ['stage', updates.stage],
    status: ['status', updates.status],
    priority: ['priority', updates.priority],
    parentId: ['parent_id', updates.parentId],
    wishFile: ['wish_file', updates.wishFile],
    groupName: ['group_name', updates.groupName],
    estimatedEffort: ['estimated_effort', updates.estimatedEffort],
    blockedReason: ['blocked_reason', updates.blockedReason],
    releaseId: ['release_id', updates.releaseId],
    externalId: ['external_id', updates.externalId],
    externalUrl: ['external_url', updates.externalUrl],
  };

  for (const [key, [col, val]] of Object.entries(fieldMap)) {
    if (key in updates && val !== undefined) {
      sets.push(`${col} = $${paramIdx++}`);
      values.push(val);
    }
  }

  if (updates.startDate !== undefined) {
    sets.push(`start_date = $${paramIdx++}`);
    values.push(updates.startDate ? new Date(updates.startDate) : null);
  }
  if (updates.dueDate !== undefined) {
    sets.push(`due_date = $${paramIdx++}`);
    values.push(updates.dueDate ? new Date(updates.dueDate) : null);
  }
  if (updates.metadata !== undefined) {
    sets.push(`metadata = $${paramIdx++}`);
    values.push(JSON.stringify(updates.metadata));
  }

  values.push(id);
  const query = `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
  const rows = await sql.unsafe(query, values);

  if (rows.length === 0) return null;

  // Inline comment
  if (comment) {
    await commentOnTask(id, comment.actor, comment.body, repo);
  }

  return mapTask(rows[0]);
}

export async function linkTask(
  idOrSeq: string,
  externalId: string,
  externalUrl: string,
  repoPath?: string,
): Promise<TaskRow | null> {
  return updateTask(idOrSeq, { externalId, externalUrl }, repoPath);
}

export async function moveTask(
  idOrSeq: string,
  toStage: string,
  actor?: Actor,
  comment?: string,
  repoPath?: string,
): Promise<TaskRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) throw new Error(`Task not found: ${idOrSeq}`);

  // Get current stage and board info
  const current = await sql`SELECT id, stage, type_id, board_id FROM tasks WHERE id = ${id}`;
  if (current.length === 0) throw new Error(`Task not found: ${idOrSeq}`);

  const fromStage = current[0].stage as string;
  const boardId = current[0].board_id as string | null;

  // If task has board_id, resolve toStage by column name -> column_id
  const columnId = boardId ? await resolveColumnId(sql, boardId, toStage) : null;

  try {
    // Wrap stage update + log + comment in a transaction to prevent lost writes
    const result = await sql.begin(async (tx: typeof sql) => {
      const rows = boardId
        ? await tx`
            UPDATE tasks SET stage = ${toStage}, column_id = ${columnId}, updated_at = now()
            WHERE id = ${id}
            RETURNING *
          `
        : await tx`
            UPDATE tasks SET stage = ${toStage}, updated_at = now()
            WHERE id = ${id}
            RETURNING *
          `;

      // Log the transition
      await tx`
        INSERT INTO task_stage_log (task_id, from_stage, to_stage, actor_type, actor_id)
        VALUES (${id}, ${fromStage}, ${toStage}, ${actor?.actorType ?? null}, ${actor?.actorId ?? null})
      `;

      // Inline comment
      if (comment && actor) {
        await commentOnTask(id, actor, comment, repo);
      }

      return mapTask(rows[0]);
    });

    // Audit event for stage change (fire-and-forget, outside transaction)
    recordAuditEvent('task', id, 'stage_change', actor?.actorId ?? getActor(), {
      from: fromStage,
      to: toStage,
    }).catch(() => {});

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Invalid stage')) {
      throw new Error(`Invalid stage "${toStage}" for this task type. ${message}`);
    }
    throw err;
  }
}

export async function blockTask(
  idOrSeq: string,
  reason: string,
  actor?: Actor,
  comment?: string,
  repoPath?: string,
): Promise<TaskRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) throw new Error(`Task not found: ${idOrSeq}`);

  const rows = await sql`
    UPDATE tasks SET status = 'blocked', blocked_reason = ${reason}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (rows.length === 0) throw new Error(`Task not found: ${idOrSeq}`);

  if (comment && actor) {
    await commentOnTask(id, actor, comment, repo);
  }

  return mapTask(rows[0]);
}

export async function unblockTask(
  idOrSeq: string,
  actor?: Actor,
  comment?: string,
  repoPath?: string,
): Promise<TaskRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) throw new Error(`Task not found: ${idOrSeq}`);

  const rows = await sql`
    UPDATE tasks SET status = 'ready', blocked_reason = NULL, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (rows.length === 0) throw new Error(`Task not found: ${idOrSeq}`);

  if (comment && actor) {
    await commentOnTask(id, actor, comment, repo);
  }

  return mapTask(rows[0]);
}

// ============================================================================
// Execution Locking (Checkout)
// ============================================================================

/** Information about a dependency that blocks checkout. */
export interface BlockingDep {
  taskId: string;
  seq: number;
  title: string;
  status: string;
}

/** Get unsatisfied dependencies that block a task from being checked out. */
export async function getBlockingDependencies(idOrSeq: string, repoPath?: string): Promise<BlockingDep[]> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) return [];

  const rows = await sql`
    SELECT t.id, t.seq, t.title, t.status
    FROM task_dependencies td
    JOIN tasks t ON td.depends_on_id = t.id
    WHERE td.task_id = ${id}
      AND td.dep_type = 'depends_on'
      AND t.status NOT IN ('done', 'cancelled')
  `;

  return rows.map((r: Record<string, unknown>) => ({
    taskId: r.id as string,
    seq: r.seq as number,
    title: r.title as string,
    status: r.status as string,
  }));
}

/** Atomically claim a task for execution. Fails if already claimed by a different run or if dependencies are unsatisfied. */
export async function checkoutTask(idOrSeq: string, runId: string, repoPath?: string): Promise<TaskRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) throw new Error(`Task not found: ${idOrSeq}`);

  // Wrap dependency check + claim in a transaction to prevent concurrent checkout races
  return sql.begin(async (tx: typeof sql) => {
    // Dependency gate: reject checkout if unsatisfied dependencies exist
    const blockerRows = await tx`
      SELECT t.id, t.seq, t.title, t.status
      FROM task_dependencies td
      JOIN tasks t ON td.depends_on_id = t.id
      WHERE td.task_id = ${id}
        AND td.dep_type = 'depends_on'
        AND t.status NOT IN ('done', 'cancelled')
    `;
    if (blockerRows.length > 0) {
      const details = blockerRows.map((b: Record<string, unknown>) => `#${b.seq} (${b.status}) ${b.title}`).join(', ');
      throw new Error(`Task ${idOrSeq} blocked by: ${details}`);
    }

    const rows = await tx`
      UPDATE tasks
      SET checkout_run_id = ${runId},
          execution_locked_at = now(),
          status = 'in_progress',
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE id = ${id}
        AND (checkout_run_id IS NULL OR checkout_run_id = ${runId})
      RETURNING *
    `;

    if (rows.length === 0) {
      const existing = await tx`SELECT checkout_run_id FROM tasks WHERE id = ${id}`;
      const owner = existing.length > 0 ? (existing[0].checkout_run_id as string) : 'unknown';
      throw new Error(`Task ${idOrSeq} is already checked out by run: ${owner}`);
    }

    return mapTask(rows[0]);
  });
}

/** Release a task checkout. */
export async function releaseTask(idOrSeq: string, runId: string, repoPath?: string): Promise<TaskRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) throw new Error(`Task not found: ${idOrSeq}`);

  const rows = await sql`
    UPDATE tasks
    SET checkout_run_id = NULL,
        execution_locked_at = NULL,
        status = 'ready',
        updated_at = now()
    WHERE id = ${id}
      AND checkout_run_id = ${runId}
    RETURNING *
  `;

  if (rows.length === 0) throw new Error(`Task ${idOrSeq} is not checked out by run: ${runId}`);
  return mapTask(rows[0]);
}

/** Force-release a checkout regardless of owner. */
export async function forceUnlockTask(idOrSeq: string, repoPath?: string): Promise<TaskRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) throw new Error(`Task not found: ${idOrSeq}`);

  const rows = await sql`
    UPDATE tasks
    SET checkout_run_id = NULL,
        execution_locked_at = NULL,
        status = 'ready',
        updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (rows.length === 0) throw new Error(`Task not found: ${idOrSeq}`);
  return mapTask(rows[0]);
}

/** Get the current checkout owner. */
export async function getCheckoutOwner(idOrSeq: string, repoPath?: string): Promise<string | null> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) return null;

  const rows = await sql`SELECT checkout_run_id FROM tasks WHERE id = ${id}`;
  return rows.length > 0 ? ((rows[0].checkout_run_id as string) ?? null) : null;
}

/** Release tasks where execution_locked_at exceeds checkout_timeout_ms. */
export async function expireStaleCheckouts(repoPath?: string): Promise<number> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();

  const result = await sql`
    UPDATE tasks
    SET checkout_run_id = NULL,
        execution_locked_at = NULL,
        status = 'ready',
        updated_at = now()
    WHERE repo_path = ${repo}
      AND checkout_run_id IS NOT NULL
      AND execution_locked_at IS NOT NULL
      AND execution_locked_at < now() - (checkout_timeout_ms || ' milliseconds')::interval
    RETURNING id
  `;
  return result.length;
}

// ============================================================================
// Actors
// ============================================================================

export async function assignTask(
  idOrSeq: string,
  actor: Actor,
  role = 'assignee',
  permissions: Record<string, unknown> = {},
  repoPath?: string,
): Promise<TaskActorRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) throw new Error(`Task not found: ${idOrSeq}`);

  const rows = await sql`
    INSERT INTO task_actors (task_id, actor_type, actor_id, role, permissions)
    VALUES (${id}, ${actor.actorType}, ${actor.actorId}, ${role}, ${sql.json(permissions)})
    ON CONFLICT (task_id, actor_type, actor_id, role) DO UPDATE SET permissions = EXCLUDED.permissions
    RETURNING *
  `;
  return mapTaskActor(rows[0]);
}

export async function getTaskActors(idOrSeq: string, repoPath?: string): Promise<TaskActorRow[]> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) return [];

  const rows = await sql`SELECT * FROM task_actors WHERE task_id = ${id} ORDER BY created_at`;
  return rows.map(mapTaskActor);
}

export async function removeActor(idOrSeq: string, actor: Actor, role: string, repoPath?: string): Promise<boolean> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) return false;

  const result = await sql`
    DELETE FROM task_actors
    WHERE task_id = ${id} AND actor_type = ${actor.actorType} AND actor_id = ${actor.actorId} AND role = ${role}
  `;
  return result.count > 0;
}

// ============================================================================
// Dependencies
// ============================================================================

export async function addDependency(
  taskIdOrSeq: string,
  dependsOnIdOrSeq: string,
  depType: 'depends_on' | 'blocks' | 'relates_to' = 'depends_on',
  repoPath?: string,
): Promise<DependencyRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const taskId = await resolveTaskId(taskIdOrSeq, repo);
  const dependsOnId = await resolveTaskId(dependsOnIdOrSeq, repo);
  if (!taskId) throw new Error(`Task not found: ${taskIdOrSeq}`);
  if (!dependsOnId) throw new Error(`Task not found: ${dependsOnIdOrSeq}`);

  const rows = await sql`
    INSERT INTO task_dependencies (task_id, depends_on_id, dep_type)
    VALUES (${taskId}, ${dependsOnId}, ${depType})
    ON CONFLICT (task_id, depends_on_id) DO UPDATE SET dep_type = EXCLUDED.dep_type
    RETURNING *
  `;
  return mapDependency(rows[0]);
}

export async function removeDependency(
  taskIdOrSeq: string,
  dependsOnIdOrSeq: string,
  repoPath?: string,
): Promise<boolean> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const taskId = await resolveTaskId(taskIdOrSeq, repo);
  const dependsOnId = await resolveTaskId(dependsOnIdOrSeq, repo);
  if (!taskId || !dependsOnId) return false;

  const result = await sql`
    DELETE FROM task_dependencies WHERE task_id = ${taskId} AND depends_on_id = ${dependsOnId}
  `;
  return result.count > 0;
}

export async function getBlockers(idOrSeq: string, repoPath?: string): Promise<DependencyRow[]> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) return [];

  const rows = await sql`
    SELECT * FROM task_dependencies WHERE task_id = ${id} ORDER BY created_at
  `;
  return rows.map(mapDependency);
}

export async function getDependents(idOrSeq: string, repoPath?: string): Promise<DependencyRow[]> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) return [];

  const rows = await sql`
    SELECT * FROM task_dependencies WHERE depends_on_id = ${id} ORDER BY created_at
  `;
  return rows.map(mapDependency);
}

// ============================================================================
// Conversations
// ============================================================================

async function findExistingConversation(opts: FindOrCreateConversationOpts, sql: Sql): Promise<ConversationRow | null> {
  if (opts.linkedEntity && opts.linkedEntityId) {
    const rows = await sql`
      SELECT * FROM conversations
      WHERE linked_entity = ${opts.linkedEntity}
        AND linked_entity_id = ${opts.linkedEntityId}
        AND parent_message_id IS NULL
      LIMIT 1
    `;
    if (rows.length > 0) return mapConversation(rows[0]);
  }

  if (opts.type === 'dm' && opts.members?.length === 2) {
    const [a, b] = opts.members;
    const rows = await sql`
      SELECT c.* FROM conversations c
      WHERE c.type = 'dm' AND c.linked_entity IS NULL AND c.parent_message_id IS NULL
        AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.actor_type = ${a.actorType} AND cm.actor_id = ${a.actorId})
        AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = c.id AND cm.actor_type = ${b.actorType} AND cm.actor_id = ${b.actorId})
      LIMIT 1
    `;
    if (rows.length > 0) return mapConversation(rows[0]);
  }

  if (opts.parentMessageId) {
    const rows = await sql`
      SELECT * FROM conversations WHERE parent_message_id = ${opts.parentMessageId} LIMIT 1
    `;
    if (rows.length > 0) return mapConversation(rows[0]);
  }

  return null;
}

export async function findOrCreateConversation(opts: FindOrCreateConversationOpts): Promise<ConversationRow> {
  const sql = await getConnection();

  const existing = await findExistingConversation(opts, sql);
  if (existing) return existing;

  const rows = await sql`
    INSERT INTO conversations (
      type, name, linked_entity, linked_entity_id,
      parent_message_id, created_by_type, created_by_id
    ) VALUES (
      ${opts.type ?? 'group'},
      ${opts.name ?? null},
      ${opts.linkedEntity ?? null},
      ${opts.linkedEntityId ?? null},
      ${opts.parentMessageId ?? null},
      ${opts.createdBy?.actorType ?? 'system'},
      ${opts.createdBy?.actorId ?? 'system'}
    )
    RETURNING *
  `;
  const conv = mapConversation(rows[0]);

  if (opts.members) {
    for (const member of opts.members) {
      await sql`
        INSERT INTO conversation_members (conversation_id, actor_type, actor_id)
        VALUES (${conv.id}, ${member.actorType}, ${member.actorId})
        ON CONFLICT DO NOTHING
      `;
    }
  }

  return conv;
}

export async function getConversation(id: string): Promise<ConversationRow | null> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM conversations WHERE id = ${id}`;
  return rows.length > 0 ? mapConversation(rows[0]) : null;
}

export async function listConversations(actor: Actor): Promise<ConversationRow[]> {
  const sql = await getConnection();
  const rows = await sql`
    SELECT c.* FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id = c.id
    WHERE cm.actor_type = ${actor.actorType} AND cm.actor_id = ${actor.actorId}
    ORDER BY c.updated_at DESC
  `;
  return rows.map(mapConversation);
}

export async function addMember(
  conversationId: string,
  actor: Actor,
  role: 'member' | 'admin' | 'read_only' = 'member',
): Promise<ConversationMemberRow> {
  const sql = await getConnection();
  const rows = await sql`
    INSERT INTO conversation_members (conversation_id, actor_type, actor_id, role)
    VALUES (${conversationId}, ${actor.actorType}, ${actor.actorId}, ${role})
    ON CONFLICT (conversation_id, actor_type, actor_id) DO UPDATE SET role = EXCLUDED.role
    RETURNING *
  `;
  return mapConversationMember(rows[0]);
}

export async function removeMember(conversationId: string, actor: Actor): Promise<boolean> {
  const sql = await getConnection();
  const result = await sql`
    DELETE FROM conversation_members
    WHERE conversation_id = ${conversationId}
      AND actor_type = ${actor.actorType}
      AND actor_id = ${actor.actorId}
  `;
  return result.count > 0;
}

export async function getMembers(conversationId: string): Promise<ConversationMemberRow[]> {
  const sql = await getConnection();
  const rows = await sql`
    SELECT * FROM conversation_members WHERE conversation_id = ${conversationId} ORDER BY joined_at
  `;
  return rows.map(mapConversationMember);
}

// ============================================================================
// Messages
// ============================================================================

export async function sendMessage(
  conversationId: string,
  sender: Actor,
  body: string,
  replyToId?: number,
): Promise<MessageRow> {
  const sql = await getConnection();
  const rows = await sql`
    INSERT INTO messages (conversation_id, sender_type, sender_id, body, reply_to_id)
    VALUES (${conversationId}, ${sender.actorType}, ${sender.actorId}, ${body}, ${replyToId ?? null})
    RETURNING *
  `;

  // Update conversation updated_at
  await sql`UPDATE conversations SET updated_at = now() WHERE id = ${conversationId}`;

  return mapMessage(rows[0]);
}

export async function getMessages(conversationId: string, opts: MessageListOpts = {}): Promise<MessageRow[]> {
  const sql = await getConnection();

  if (opts.since) {
    const rows = await sql`
      SELECT * FROM messages
      WHERE conversation_id = ${conversationId}
        AND created_at > ${new Date(opts.since)}
      ORDER BY created_at ASC
      LIMIT ${opts.limit ?? 100}
      OFFSET ${opts.offset ?? 0}
    `;
    return rows.map(mapMessage);
  }

  const rows = await sql`
    SELECT * FROM messages
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at ASC
    LIMIT ${opts.limit ?? 100}
    OFFSET ${opts.offset ?? 0}
  `;
  return rows.map(mapMessage);
}

export async function getMessage(id: number): Promise<MessageRow | null> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM messages WHERE id = ${id}`;
  return rows.length > 0 ? mapMessage(rows[0]) : null;
}

export async function updateMessage(id: number, body: string): Promise<MessageRow | null> {
  const sql = await getConnection();
  const rows = await sql`
    UPDATE messages SET body = ${body}, updated_at = now() WHERE id = ${id} RETURNING *
  `;
  return rows.length > 0 ? mapMessage(rows[0]) : null;
}

/**
 * Comment on a task — finds or creates the task's conversation, sends message.
 * This is the main entry point for task comments and inline --comment flags.
 */
export async function commentOnTask(
  taskIdOrSeq: string,
  sender: Actor,
  body: string,
  repoPath?: string,
  replyToId?: number,
): Promise<MessageRow> {
  const repo = repoPath ?? getRepoPath();
  const taskId = await resolveTaskId(taskIdOrSeq, repo);
  if (!taskId) throw new Error(`Task not found: ${taskIdOrSeq}`);

  // Find or create the task's conversation
  const conv = await findOrCreateConversation({
    linkedEntity: 'task',
    linkedEntityId: taskId,
    name: `Task ${taskIdOrSeq}`,
    createdBy: sender,
    members: [sender],
  });

  // Ensure sender is a member
  await addMember(conv.id, sender);

  return sendMessage(conv.id, sender, body, replyToId);
}

// ============================================================================
// Tags
// ============================================================================

export async function tagTask(idOrSeq: string, tagIds: string[], actor?: Actor, repoPath?: string): Promise<void> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) throw new Error(`Task not found: ${idOrSeq}`);

  for (const tagId of tagIds) {
    await sql`
      INSERT INTO task_tags (task_id, tag_id, added_by_type, added_by_id)
      VALUES (${id}, ${tagId}, ${actor?.actorType ?? null}, ${actor?.actorId ?? null})
      ON CONFLICT DO NOTHING
    `;
  }
}

export async function untagTask(idOrSeq: string, tagId: string, repoPath?: string): Promise<boolean> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) return false;

  const result = await sql`DELETE FROM task_tags WHERE task_id = ${id} AND tag_id = ${tagId}`;
  return result.count > 0;
}

export async function listTags(typeId?: string): Promise<TagRow[]> {
  const sql = await getConnection();

  if (typeId) {
    const rows = await sql`
      SELECT * FROM tags WHERE type_id = ${typeId} OR type_id IS NULL ORDER BY name
    `;
    return rows.map(mapTag);
  }

  const rows = await sql`SELECT * FROM tags ORDER BY name`;
  return rows.map(mapTag);
}

export async function createTag(input: { id: string; name: string; color?: string; typeId?: string }): Promise<TagRow> {
  const sql = await getConnection();
  const rows = await sql`
    INSERT INTO tags (id, name, color, type_id)
    VALUES (${input.id}, ${input.name}, ${input.color ?? palette.textDim}, ${input.typeId ?? null})
    RETURNING *
  `;
  return mapTag(rows[0]);
}

export async function getTaskTags(idOrSeq: string, repoPath?: string): Promise<TagRow[]> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) return [];

  const rows = await sql`
    SELECT t.* FROM tags t
    JOIN task_tags tt ON tt.tag_id = t.id
    WHERE tt.task_id = ${id}
    ORDER BY t.name
  `;
  return rows.map(mapTag);
}

// ============================================================================
// Types
// ============================================================================

export async function createType(input: {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  stages: unknown[];
}): Promise<TaskTypeRow> {
  const sql = await getConnection();
  const rows = await sql`
    INSERT INTO task_types (id, name, description, icon, stages, is_builtin)
    VALUES (${input.id}, ${input.name}, ${input.description ?? null}, ${input.icon ?? null}, ${sql.json(input.stages)}, false)
    RETURNING *
  `;
  return mapTaskType(rows[0]);
}

export async function listTypes(): Promise<TaskTypeRow[]> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM task_types ORDER BY name`;
  return rows.map(mapTaskType);
}

export async function getType(id: string): Promise<TaskTypeRow | null> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM task_types WHERE id = ${id}`;
  return rows.length > 0 ? mapTaskType(rows[0]) : null;
}

// ============================================================================
// Releases
// ============================================================================

export async function setRelease(taskIdsOrSeqs: string[], releaseId: string, repoPath?: string): Promise<number> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();

  let updated = 0;
  for (const idOrSeq of taskIdsOrSeqs) {
    const id = await resolveTaskId(idOrSeq, repo);
    if (!id) continue;
    const result = await sql`UPDATE tasks SET release_id = ${releaseId}, updated_at = now() WHERE id = ${id}`;
    updated += result.count;
  }
  return updated;
}

export async function listReleases(repoPath?: string): Promise<{ releaseId: string; count: number }[]> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();

  const rows = await sql`
    SELECT release_id, COUNT(*)::int AS count
    FROM tasks
    WHERE repo_path = ${repo} AND release_id IS NOT NULL
    GROUP BY release_id
    ORDER BY release_id
  `;
  return rows.map((r: Record<string, unknown>) => ({
    releaseId: r.release_id as string,
    count: r.count as number,
  }));
}

// ============================================================================
// Notification Preferences
// ============================================================================

export async function setPreference(
  actor: Actor,
  channel: string,
  config: {
    priorityThreshold?: string;
    isDefault?: boolean;
    enabled?: boolean;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<NotificationPrefRow> {
  const sql = await getConnection();
  const rows = await sql`
    INSERT INTO notification_preferences (actor_type, actor_id, channel, priority_threshold, is_default, enabled, metadata)
    VALUES (
      ${actor.actorType}, ${actor.actorId}, ${channel},
      ${config.priorityThreshold ?? 'normal'},
      ${config.isDefault ?? false},
      ${config.enabled ?? true},
      ${config.metadata ? sql.json(config.metadata) : sql.json({})}
    )
    ON CONFLICT (actor_type, actor_id, channel) DO UPDATE SET
      priority_threshold = EXCLUDED.priority_threshold,
      is_default = EXCLUDED.is_default,
      enabled = EXCLUDED.enabled,
      metadata = EXCLUDED.metadata,
      updated_at = now()
    RETURNING *
  `;
  return mapNotificationPref(rows[0]);
}

export async function getPreferences(actor: Actor): Promise<NotificationPrefRow[]> {
  const sql = await getConnection();
  const rows = await sql`
    SELECT * FROM notification_preferences
    WHERE actor_type = ${actor.actorType} AND actor_id = ${actor.actorId}
    ORDER BY channel
  `;
  return rows.map(mapNotificationPref);
}

/** Returns ordered list of channels that meet the priority threshold. */
export async function resolveChannels(actor: Actor, priority: string): Promise<string[]> {
  const sql = await getConnection();

  // Priority ordering: urgent > high > normal > low
  const priorityOrder: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };
  const level = priorityOrder[priority] ?? 2;

  const rows = await sql`
    SELECT channel, priority_threshold FROM notification_preferences
    WHERE actor_type = ${actor.actorType}
      AND actor_id = ${actor.actorId}
      AND enabled = true
    ORDER BY is_default DESC, channel
  `;

  return rows
    .filter((r: Record<string, unknown>) => {
      const threshold = priorityOrder[r.priority_threshold as string] ?? 2;
      return level >= threshold;
    })
    .map((r: Record<string, unknown>) => r.channel as string);
}

// ============================================================================
// Stage Log
// ============================================================================

export async function getStageLog(idOrSeq: string, repoPath?: string): Promise<StageLogRow[]> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) return [];

  const rows = await sql`
    SELECT * FROM task_stage_log WHERE task_id = ${id} ORDER BY created_at DESC
  `;
  return rows.map(mapStageLog);
}

// ============================================================================
// Mark Done
// ============================================================================

/** Mark a task as done — sets status='done', ended_at=now(), releases checkout. */
export async function markDone(idOrSeq: string, actor?: Actor, comment?: string, repoPath?: string): Promise<TaskRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) throw new Error(`Task not found: ${idOrSeq}`);

  const rows = await sql`
    UPDATE tasks
    SET status = 'done',
        ended_at = COALESCE(ended_at, now()),
        checkout_run_id = NULL,
        execution_locked_at = NULL,
        updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (rows.length === 0) throw new Error(`Task not found: ${idOrSeq}`);

  if (comment && actor) {
    await commentOnTask(id, actor, comment, repo);
  }

  return mapTask(rows[0]);
}

// ============================================================================
// Archive / Unarchive
// ============================================================================

/** Archive a task — sets status='archived', archived_at=now(). */
export async function archiveTask(idOrSeq: string, actor?: Actor, repoPath?: string): Promise<TaskRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) throw new Error(`Task not found: ${idOrSeq}`);

  const rows = await sql`
    UPDATE tasks
    SET status = 'archived', archived_at = now(), updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (rows.length === 0) throw new Error(`Task not found: ${idOrSeq}`);

  recordAuditEvent('task', id, 'archived', actor?.actorId ?? getActor(), {}).catch(() => {});
  return mapTask(rows[0]);
}

/** Unarchive a task — restores previous status from stage_log or defaults to 'ready'. */
export async function unarchiveTask(idOrSeq: string, actor?: Actor, repoPath?: string): Promise<TaskRow> {
  const sql = await getConnection();
  const repo = repoPath ?? getRepoPath();
  const id = await resolveTaskId(idOrSeq, repo);
  if (!id) throw new Error(`Task not found: ${idOrSeq}`);

  // Infer previous status: if ended_at is set it was done, otherwise default to 'ready'.
  // Never restore to 'blocked' — use 'ready' instead.
  const task = await sql`SELECT * FROM tasks WHERE id = ${id} LIMIT 1`;
  if (task.length === 0) throw new Error(`Task not found: ${idOrSeq}`);

  let restoredStatus = 'ready';
  if (task[0].ended_at) {
    restoredStatus = 'done';
  }

  const rows = await sql`
    UPDATE tasks
    SET status = ${restoredStatus}, archived_at = NULL, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (rows.length === 0) throw new Error(`Task not found: ${idOrSeq}`);

  recordAuditEvent('task', id, 'unarchived', actor?.actorId ?? getActor(), { restoredStatus }).catch(() => {});
  return mapTask(rows[0]);
}

/** Archive a project and cascade to its boards and unfinished tasks. */
export async function archiveProject(name: string): Promise<void> {
  const sql = await getConnection();
  const project = await getProjectByName(name);
  if (!project) throw new Error(`Project not found: ${name}`);

  // Archive the project
  await sql`
    UPDATE projects SET status = 'archived', archived_at = now()
    WHERE id = ${project.id}
  `;

  // Cascade: archive boards for this project
  await sql`
    UPDATE boards SET status = 'archived', archived_at = now(), updated_at = now()
    WHERE project_id = ${project.id} AND (status IS NULL OR status = 'active')
  `;

  // Cascade: archive unfinished tasks (not done, cancelled, or already archived)
  await sql`
    UPDATE tasks SET status = 'archived', archived_at = now(), updated_at = now()
    WHERE project_id = ${project.id}
      AND status NOT IN ('done', 'cancelled', 'archived')
  `;

  recordAuditEvent('project', project.id, 'archived', getActor(), { name }).catch(() => {});
}

/** Unarchive a project — restores project and its boards (tasks stay as-is). */
export async function unarchiveProject(name: string): Promise<void> {
  const sql = await getConnection();
  const project = await getProjectByName(name);
  if (!project) throw new Error(`Project not found: ${name}`);

  // Restore the project
  await sql`
    UPDATE projects SET status = 'active', archived_at = NULL
    WHERE id = ${project.id}
  `;

  // Restore boards for this project
  await sql`
    UPDATE boards SET status = 'active', archived_at = NULL, updated_at = now()
    WHERE project_id = ${project.id} AND status = 'archived'
  `;

  recordAuditEvent('project', project.id, 'unarchived', getActor(), { name }).catch(() => {});
}

/** Archive a board and its unfinished tasks. */
export async function archiveBoard(boardId: string): Promise<void> {
  const sql = await getConnection();

  await sql`
    UPDATE boards SET status = 'archived', archived_at = now(), updated_at = now()
    WHERE id = ${boardId}
  `;

  // Cascade: archive unfinished tasks on this board
  await sql`
    UPDATE tasks SET status = 'archived', archived_at = now(), updated_at = now()
    WHERE board_id = ${boardId}
      AND status NOT IN ('done', 'cancelled', 'archived')
  `;

  recordAuditEvent('board', boardId, 'archived', getActor(), {}).catch(() => {});
}

/** List projects, optionally including archived ones. */
export async function listProjectsFiltered(includeArchived = false): Promise<ProjectRow[]> {
  const sql = await getConnection();
  if (includeArchived) {
    const rows = await sql`SELECT * FROM projects ORDER BY name`;
    return rows.map(mapProject);
  }
  const rows = await sql`SELECT * FROM projects WHERE status IS NULL OR status = 'active' ORDER BY name`;
  return rows.map(mapProject);
}

// ============================================================================
// Delete Notification Preference
// ============================================================================

export async function deletePreference(actor: Actor, channel: string): Promise<boolean> {
  const sql = await getConnection();
  const result = await sql`
    DELETE FROM notification_preferences
    WHERE actor_type = ${actor.actorType}
      AND actor_id = ${actor.actorId}
      AND channel = ${channel}
  `;
  return result.count > 0;
}

// ============================================================================
// Task Listing for Actor (--mine filter)
// ============================================================================

/** List tasks assigned to a specific actor. */
export async function listTasksForActor(actor: Actor, filters: TaskFilters = {}): Promise<TaskRow[]> {
  const sql = await getConnection();

  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  // Scope conditions (project/repo/all) — mirrors buildScopeConditions with t. prefix
  if (filters.projectName) {
    // Explicit project filter always applies (even with --all)
    conditions.push(`t.project_id = (SELECT id FROM projects WHERE name = $${paramIdx++})`);
    values.push(filters.projectName);
  } else if (filters.allProjects) {
    // No repo scoping — show all projects
  } else {
    conditions.push(`t.repo_path = $${paramIdx++}`);
    values.push(filters.repoPath ?? getRepoPath());
  }

  conditions.push(`ta.actor_type = $${paramIdx++}`);
  values.push(actor.actorType);
  conditions.push(`ta.actor_id = $${paramIdx++}`);
  values.push(actor.actorId);

  if (filters.stage) {
    conditions.push(`t.stage = $${paramIdx++}`);
    values.push(filters.stage);
  }
  if (filters.status) {
    conditions.push(`t.status = $${paramIdx++}`);
    values.push(filters.status);
  } else if (!filters.includeArchived) {
    conditions.push(`t.status != 'archived'`);
  }
  if (filters.priority) {
    conditions.push(`t.priority = $${paramIdx++}`);
    values.push(filters.priority);
  }

  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;
  values.push(limit, offset);

  const query = `SELECT DISTINCT t.* FROM tasks t JOIN task_actors ta ON ta.task_id = t.id WHERE ${conditions.join(' AND ')} ORDER BY t.created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  const rows = await sql.unsafe(query, values);
  return rows.map(mapTask);
}
