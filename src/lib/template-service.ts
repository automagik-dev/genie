/**
 * Template Service — PG CRUD for board templates.
 *
 * Board templates are reusable blueprints for creating boards.
 * Includes 5 built-in templates (software, sales, hiring, ops, bug)
 * and supports custom templates created from existing boards.
 *
 * Follows the same patterns as task-service.ts:
 * - getConnection() for DB access
 * - recordAuditEvent() fire-and-forget for audit trail
 * - snake_case DB rows mapped to camelCase TypeScript interfaces
 */

import { getActor, recordAuditEvent } from './audit.js';
import type { BoardColumn, BoardTemplateRow } from './board-service.js';
import { getBoard } from './board-service.js';
import { getConnection } from './db.js';

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

/** Map snake_case DB row to camelCase BoardTemplateRow. */
function mapTemplate(row: Record<string, unknown>): BoardTemplateRow {
  return {
    id: row.id as string,
    name: row.name as string,
    description: str(row.description),
    icon: str(row.icon),
    columns: parseJsonb<BoardColumn[]>(row.columns, []),
    isBuiltin: row.is_builtin as boolean,
    createdAt: strOrDefault(row.created_at, ''),
    updatedAt: strOrDefault(row.updated_at, ''),
  };
}

// ============================================================================
// Template CRUD
// ============================================================================

export async function createTemplate(input: {
  name: string;
  description?: string;
  icon?: string;
  columns?: BoardColumn[];
  fromBoardId?: string;
}): Promise<BoardTemplateRow> {
  const sql = await getConnection();

  let columns = input.columns ?? [];

  if (input.fromBoardId) {
    const board = await getBoard(input.fromBoardId);
    if (!board) throw new Error(`Board not found: ${input.fromBoardId}`);
    columns = board.columns;
  }

  const rows = await sql`
    INSERT INTO board_templates (name, description, icon, columns, is_builtin)
    VALUES (
      ${input.name},
      ${input.description ?? null},
      ${input.icon ?? null},
      ${sql.json(columns)},
      false
    )
    RETURNING *
  `;

  const template = mapTemplate(rows[0]);

  recordAuditEvent('template', template.id, 'template_created', getActor(), {
    name: template.name,
    fromBoardId: input.fromBoardId ?? null,
    columnCount: columns.length,
  }).catch(() => {});

  return template;
}

export async function getTemplate(nameOrId: string): Promise<BoardTemplateRow | null> {
  const sql = await getConnection();

  // Try by ID first
  const byId = await sql`SELECT * FROM board_templates WHERE id = ${nameOrId} LIMIT 1`;
  if (byId.length > 0) return mapTemplate(byId[0]);

  // Try by name
  const byName = await sql`SELECT * FROM board_templates WHERE name = ${nameOrId} LIMIT 1`;
  if (byName.length > 0) return mapTemplate(byName[0]);

  return null;
}

export async function listTemplates(): Promise<BoardTemplateRow[]> {
  const sql = await getConnection();
  const rows = await sql`SELECT * FROM board_templates ORDER BY is_builtin DESC, name`;
  return rows.map(mapTemplate);
}

export async function updateTemplate(
  id: string,
  updates: { name?: string; description?: string; icon?: string; columns?: BoardColumn[] },
): Promise<BoardTemplateRow | null> {
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
  if (updates.icon !== undefined) {
    sets.push(`icon = $${paramIdx++}`);
    values.push(updates.icon);
  }
  if (updates.columns !== undefined) {
    sets.push(`columns = $${paramIdx++}::jsonb`);
    values.push(JSON.stringify(updates.columns));
  }

  values.push(id);
  const query = `UPDATE board_templates SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`;
  const rows = await sql.unsafe(query, values);

  if (rows.length === 0) return null;

  recordAuditEvent('template', id, 'template_updated', getActor(), {
    updates: Object.keys(updates),
  }).catch(() => {});

  return mapTemplate(rows[0]);
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const sql = await getConnection();
  const result = await sql`DELETE FROM board_templates WHERE id = ${id}`;

  if (result.count > 0) {
    recordAuditEvent('template', id, 'template_deleted', getActor()).catch(() => {});
    return true;
  }
  return false;
}

export async function renameTemplate(id: string, newName: string): Promise<BoardTemplateRow | null> {
  const sql = await getConnection();
  const rows = await sql`
    UPDATE board_templates SET name = ${newName}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;

  if (rows.length === 0) return null;

  recordAuditEvent('template', id, 'template_renamed', getActor(), {
    newName,
  }).catch(() => {});

  return mapTemplate(rows[0]);
}

export async function updateTemplateColumn(
  templateId: string,
  columnName: string,
  updates: Partial<BoardColumn>,
): Promise<BoardTemplateRow | null> {
  const sql = await getConnection();

  const template = await getTemplate(templateId);
  if (!template) return null;

  const idx = template.columns.findIndex((c) => c.name === columnName);
  if (idx === -1) throw new Error(`Column "${columnName}" not found in template "${template.name}"`);

  const columns = [...template.columns];
  columns[idx] = { ...columns[idx], ...updates };

  const rows = await sql`
    UPDATE board_templates SET columns = ${sql.json(columns)}, updated_at = now()
    WHERE id = ${templateId}
    RETURNING *
  `;

  if (rows.length === 0) return null;

  recordAuditEvent('template', templateId, 'template_column_updated', getActor(), {
    columnName,
    updates: Object.keys(updates),
  }).catch(() => {});

  return mapTemplate(rows[0]);
}

export async function snapshotFromBoard(boardId: string, templateName: string): Promise<BoardTemplateRow> {
  return createTemplate({
    name: templateName,
    fromBoardId: boardId,
  });
}
