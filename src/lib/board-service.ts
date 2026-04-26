/**
 * Board Service — PG CRUD for boards and board columns.
 *
 * Boards are project-scoped pipeline definitions that replace task_types
 * as the primary way to define work stages. Each board has an ordered
 * array of columns with gates, actions, and routing config.
 *
 * Follows the same patterns as task-service.ts:
 * - getConnection() for DB access
 * - recordAuditEvent() fire-and-forget for audit trail
 * - snake_case DB rows mapped to camelCase TypeScript interfaces
 */

import { palette } from '../../packages/genie-tokens';
import { getActor, recordAuditEvent } from './audit.js';
import { getConnection } from './db.js';

// ============================================================================
// Types
// ============================================================================

export interface Transition {
  event: string;
  target: string;
  condition?: string;
  action?: string;
}

export interface BoardColumn {
  id: string;
  name: string;
  label: string;
  gate: 'human' | 'agent' | 'human+agent';
  action: string | null;
  auto_advance: boolean;
  transitions: Transition[];
  roles: string[];
  color: string;
  parallel: boolean;
  on_fail: string | null;
  position: number;
}

export interface BoardRow {
  id: string;
  name: string;
  projectId: string | null;
  description: string | null;
  status: string;
  archivedAt: string | null;
  columns: BoardColumn[];
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BoardTemplateRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  columns: BoardColumn[];
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BoardExport {
  name: string;
  description: string | null;
  columns: BoardColumn[];
  config: Record<string, unknown>;
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

/** Parse a JSONB value that may come back as string from sql.unsafe(). */
function parseJsonb<T>(val: unknown, fallback: T): T {
  if (val == null) return fallback;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

/** Map snake_case DB row to camelCase BoardRow. */
function mapBoard(row: Record<string, unknown>): BoardRow {
  return {
    id: row.id as string,
    name: row.name as string,
    projectId: str(row.project_id),
    description: str(row.description),
    status: strOrDefault(row.status, 'active'),
    archivedAt: str(row.archived_at),
    columns: parseJsonb<BoardColumn[]>(row.columns, []),
    config: parseJsonb<Record<string, unknown>>(row.config, {}),
    createdAt: strOrDefault(row.created_at, ''),
    updatedAt: strOrDefault(row.updated_at, ''),
  };
}

/** Generate a UUID string for column IDs. */
function generateColumnId(): string {
  return crypto.randomUUID();
}

/** Fill in defaults for a partial column definition. */
function fillColumnDefaults(col: Partial<BoardColumn>, position: number): BoardColumn {
  return {
    id: col.id ?? generateColumnId(),
    name: col.name ?? `column-${position}`,
    label: col.label ?? col.name ?? `Column ${position}`,
    gate: col.gate ?? 'human',
    action: col.action ?? null,
    auto_advance: col.auto_advance ?? false,
    transitions: col.transitions ?? [],
    roles: col.roles ?? ['*'],
    color: col.color ?? palette.textDim,
    parallel: col.parallel ?? false,
    on_fail: col.on_fail ?? null,
    position,
  };
}

// ============================================================================
// Board CRUD
// ============================================================================

export async function createBoard(input: {
  name: string;
  projectId?: string;
  description?: string;
  columns?: Partial<BoardColumn>[];
  fromTemplate?: string;
}): Promise<BoardRow> {
  const sql = await getConnection();

  let columns: BoardColumn[] = [];

  if (input.fromTemplate) {
    // Load template columns
    const tmplRows = await sql`
      SELECT columns FROM board_templates WHERE name = ${input.fromTemplate} OR id = ${input.fromTemplate} LIMIT 1
    `;
    if (tmplRows.length === 0) {
      throw new Error(`Template not found: ${input.fromTemplate}`);
    }
    const tmplColumns = tmplRows[0].columns as BoardColumn[];
    // Assign fresh IDs to columns from template
    columns = tmplColumns.map((col, i) => ({
      ...col,
      id: generateColumnId(),
      position: i,
    }));
  } else if (input.columns) {
    columns = input.columns.map((col, i) => fillColumnDefaults(col, i));
  }

  const rows = await sql`
    INSERT INTO boards (name, project_id, description, columns)
    VALUES (
      ${input.name},
      ${input.projectId ?? null},
      ${input.description ?? null},
      ${sql.json(columns)}
    )
    RETURNING *
  `;

  const board = mapBoard(rows[0]);

  recordAuditEvent('board', board.id, 'board_created', getActor(), {
    name: board.name,
    projectId: board.projectId,
    fromTemplate: input.fromTemplate ?? null,
    columnCount: columns.length,
  }).catch(() => {});

  return board;
}

export async function getBoard(nameOrId: string, projectId?: string): Promise<BoardRow | null> {
  const sql = await getConnection();

  // Try by ID first
  const byId = await sql`SELECT * FROM boards WHERE id = ${nameOrId} LIMIT 1`;
  if (byId.length > 0) return mapBoard(byId[0]);

  // Try by name within project scope (ILIKE for case-insensitive match)
  if (projectId) {
    const byName = await sql`
      SELECT * FROM boards WHERE name ILIKE ${nameOrId} AND project_id = ${projectId} LIMIT 1
    `;
    if (byName.length > 0) return mapBoard(byName[0]);
  }

  // Try by name with null project (global boards)
  const byName = await sql`
    SELECT * FROM boards WHERE name ILIKE ${nameOrId} AND project_id IS NULL LIMIT 1
  `;
  if (byName.length > 0) return mapBoard(byName[0]);

  // Try by name across all projects (ILIKE fallback)
  const anyName = await sql`
    SELECT * FROM boards WHERE name ILIKE ${nameOrId} LIMIT 1
  `;
  if (anyName.length > 0) return mapBoard(anyName[0]);

  return null;
}

export async function listBoards(projectId?: string, includeArchived = false): Promise<BoardRow[]> {
  const sql = await getConnection();

  if (projectId) {
    if (includeArchived) {
      const rows = await sql`
        SELECT * FROM boards WHERE project_id = ${projectId} ORDER BY name
      `;
      return rows.map(mapBoard);
    }
    const rows = await sql`
      SELECT * FROM boards WHERE project_id = ${projectId}
        AND (status IS NULL OR status = 'active') ORDER BY name
    `;
    return rows.map(mapBoard);
  }

  if (includeArchived) {
    const rows = await sql`SELECT * FROM boards ORDER BY name`;
    return rows.map(mapBoard);
  }
  const rows = await sql`SELECT * FROM boards WHERE status IS NULL OR status = 'active' ORDER BY name`;
  return rows.map(mapBoard);
}

export async function updateBoard(
  id: string,
  updates: { name?: string; description?: string; config?: Record<string, unknown> },
): Promise<BoardRow | null> {
  const sql = await getConnection();

  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [];
  let paramIdx = 1;

  if (updates.name !== undefined) {
    sets.push(`name = $${paramIdx++}`);
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push(`description = $${paramIdx++}`);
    values.push(updates.description);
  }
  if (updates.config !== undefined) {
    sets.push(`config = $${paramIdx++}::jsonb`);
    values.push(JSON.stringify(updates.config));
  }

  values.push(id);
  const query = `UPDATE boards SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
  const rows = await sql.unsafe(query, values);

  if (rows.length === 0) return null;

  recordAuditEvent('board', id, 'board_updated', getActor(), {
    updates: Object.keys(updates),
  }).catch(() => {});

  return mapBoard(rows[0]);
}

export async function deleteBoard(id: string): Promise<boolean> {
  const sql = await getConnection();

  // Check for active tasks
  const activeTasks = await sql`
    SELECT COUNT(*)::int AS count FROM tasks
    WHERE board_id = ${id} AND status NOT IN ('done', 'cancelled')
  `;
  if (activeTasks[0].count > 0) {
    throw new Error(`Cannot delete board ${id}: ${activeTasks[0].count} active task(s) still reference it`);
  }

  const result = await sql`DELETE FROM boards WHERE id = ${id}`;

  if (result.count > 0) {
    recordAuditEvent('board', id, 'board_deleted', getActor()).catch(() => {});
    return true;
  }
  return false;
}

// ============================================================================
// Column Management
// ============================================================================

export async function addColumn(
  boardId: string,
  column: Partial<BoardColumn>,
  position?: number,
): Promise<BoardColumn> {
  const sql = await getConnection();

  const board = await getBoard(boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);

  const columns = [...board.columns];
  const pos = position ?? columns.length;
  const newCol = fillColumnDefaults(column, pos);

  // Insert at position and re-index
  columns.splice(pos, 0, newCol);
  for (let i = 0; i < columns.length; i++) {
    columns[i] = { ...columns[i], position: i };
  }

  await sql`
    UPDATE boards SET columns = ${sql.json(columns)}, updated_at = now()
    WHERE id = ${boardId}
  `;

  recordAuditEvent('board', boardId, 'column_added', getActor(), {
    columnId: newCol.id,
    columnName: newCol.name,
    position: pos,
  }).catch(() => {});

  return newCol;
}

export async function removeColumn(boardId: string, columnId: string): Promise<boolean> {
  const sql = await getConnection();

  const board = await getBoard(boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);

  const columns = board.columns.filter((c) => c.id !== columnId);
  if (columns.length === board.columns.length) return false;

  // Re-index positions
  for (let i = 0; i < columns.length; i++) {
    columns[i] = { ...columns[i], position: i };
  }

  await sql`
    UPDATE boards SET columns = ${sql.json(columns)}, updated_at = now()
    WHERE id = ${boardId}
  `;

  recordAuditEvent('board', boardId, 'column_removed', getActor(), {
    columnId,
  }).catch(() => {});

  return true;
}

export async function updateColumn(
  boardId: string,
  columnId: string,
  updates: Partial<BoardColumn>,
): Promise<BoardColumn | null> {
  const sql = await getConnection();

  const board = await getBoard(boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);

  const idx = board.columns.findIndex((c) => c.id === columnId);
  if (idx === -1) return null;

  const columns = [...board.columns];
  columns[idx] = { ...columns[idx], ...updates, id: columnId };

  await sql`
    UPDATE boards SET columns = ${sql.json(columns)}, updated_at = now()
    WHERE id = ${boardId}
  `;

  // Determine specific audit event type
  const auditDetails: Record<string, unknown> = { columnId };
  let eventType = 'column_updated';
  if (updates.name !== undefined || updates.label !== undefined) {
    eventType = 'column_renamed';
    auditDetails.newName = updates.name;
    auditDetails.newLabel = updates.label;
  }
  if (updates.gate !== undefined) {
    eventType = 'gate_changed';
    auditDetails.newGate = updates.gate;
  }

  recordAuditEvent('board', boardId, eventType, getActor(), auditDetails).catch(() => {});

  return columns[idx];
}

export async function reorderColumns(boardId: string, columnIds: string[]): Promise<BoardColumn[]> {
  const sql = await getConnection();

  const board = await getBoard(boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);

  // Reorder based on the provided ID order
  const columnMap = new Map(board.columns.map((c) => [c.id, c]));
  const reordered: BoardColumn[] = [];

  for (let i = 0; i < columnIds.length; i++) {
    const col = columnMap.get(columnIds[i]);
    if (!col) throw new Error(`Column not found: ${columnIds[i]}`);
    reordered.push({ ...col, position: i });
  }

  // Append any columns not in the provided list
  for (const col of board.columns) {
    if (!columnIds.includes(col.id)) {
      reordered.push({ ...col, position: reordered.length });
    }
  }

  await sql`
    UPDATE boards SET columns = ${sql.json(reordered)}, updated_at = now()
    WHERE id = ${boardId}
  `;

  recordAuditEvent('board', boardId, 'column_reordered', getActor(), {
    order: columnIds,
  }).catch(() => {});

  return reordered;
}

export async function getColumns(boardId: string): Promise<BoardColumn[]> {
  const board = await getBoard(boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);
  return [...board.columns].sort((a, b) => a.position - b.position);
}

// ============================================================================
// Export / Import
// ============================================================================

export async function exportBoard(boardId: string): Promise<BoardExport> {
  const board = await getBoard(boardId);
  if (!board) throw new Error(`Board not found: ${boardId}`);

  return {
    name: board.name,
    description: board.description,
    columns: board.columns,
    config: board.config,
  };
}

export async function importBoard(json: BoardExport, projectId: string): Promise<BoardRow> {
  return createBoard({
    name: json.name,
    projectId,
    description: json.description ?? undefined,
    columns: json.columns,
  });
}

// ============================================================================
// Reconciliation
// ============================================================================

interface ReconcileResult {
  fixed: number;
  orphaned: number;
  details: { taskId: string; stage: string; oldColumnId: string | null; newColumnId: string | null }[];
}

/**
 * Reconcile orphaned column_ids on a board.
 * For each task whose column_id doesn't match any board column,
 * resolve by matching task.stage → board column name.
 */
export async function reconcileBoard(nameOrId: string): Promise<ReconcileResult> {
  const sql = await getConnection();
  const board = await getBoard(nameOrId);
  if (!board) throw new Error(`Board not found: ${nameOrId}`);

  const columnByName = new Map(board.columns.map((c) => [c.name, c]));
  const columnIds = new Set(board.columns.map((c) => c.id));

  // Find tasks on this board with orphaned or missing column_ids
  const tasks = await sql`
    SELECT id, stage, column_id FROM tasks
    WHERE board_id = ${board.id}
  `;

  const result: ReconcileResult = { fixed: 0, orphaned: 0, details: [] };

  for (const task of tasks) {
    const currentColId = task.column_id as string | null;
    if (currentColId && columnIds.has(currentColId)) continue;

    const matchedCol = columnByName.get(task.stage as string);
    if (matchedCol) {
      await sql`UPDATE tasks SET column_id = ${matchedCol.id} WHERE id = ${task.id}`;
      result.fixed++;
      result.details.push({
        taskId: task.id as string,
        stage: task.stage as string,
        oldColumnId: currentColId,
        newColumnId: matchedCol.id,
      });
    } else {
      result.orphaned++;
      result.details.push({
        taskId: task.id as string,
        stage: task.stage as string,
        oldColumnId: currentColId,
        newColumnId: null,
      });
    }
  }

  if (result.fixed > 0) {
    recordAuditEvent('board', board.id, 'board_reconciled', getActor(), {
      fixed: result.fixed,
      orphaned: result.orphaned,
    }).catch(() => {});
  }

  return result;
}
