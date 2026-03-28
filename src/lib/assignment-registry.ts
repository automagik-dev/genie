/**
 * Assignment Registry — CRUD for executor-task work history.
 *
 * Assignments record which executor worked which task, with timestamps
 * and outcomes. Many-to-many: one executor can work multiple tasks
 * sequentially; one task can be worked by multiple executors (reassignment).
 */

import { randomUUID } from 'node:crypto';
import { getConnection } from './db.js';
import { type Assignment, type AssignmentOutcome, type AssignmentRow, rowToAssignment } from './executor-types.js';

// ============================================================================
// CRUD
// ============================================================================

/** Create an assignment linking an executor to a task. */
export async function createAssignment(
  executorId: string,
  taskId: string | null,
  wishSlug?: string | null,
  groupNumber?: number | null,
): Promise<Assignment> {
  const sql = await getConnection();
  const id = randomUUID();
  const now = new Date().toISOString();

  const rows = await sql<AssignmentRow[]>`
    INSERT INTO assignments (id, executor_id, task_id, wish_slug, group_number, started_at)
    VALUES (${id}, ${executorId}, ${taskId}, ${wishSlug ?? null}, ${groupNumber ?? null}, ${now})
    RETURNING *
  `;

  return rowToAssignment(rows[0]);
}

/** Complete an assignment with an outcome. */
export async function completeAssignment(id: string, outcome: AssignmentOutcome): Promise<void> {
  const sql = await getConnection();
  const now = new Date().toISOString();
  await sql`
    UPDATE assignments
    SET ended_at = ${now}, outcome = ${outcome}
    WHERE id = ${id}
  `;
}

/** Get the active (not ended) assignment for an executor. */
export async function getActiveAssignment(executorId: string): Promise<Assignment | null> {
  const sql = await getConnection();
  const rows = await sql<AssignmentRow[]>`
    SELECT * FROM assignments
    WHERE executor_id = ${executorId} AND ended_at IS NULL
    ORDER BY started_at DESC LIMIT 1
  `;
  return rows.length > 0 ? rowToAssignment(rows[0]) : null;
}

/** Get all assignments for a task (work history showing every executor that touched it). */
export async function getTaskHistory(taskId: string): Promise<Assignment[]> {
  const sql = await getConnection();
  const rows = await sql<AssignmentRow[]>`
    SELECT * FROM assignments
    WHERE task_id = ${taskId}
    ORDER BY started_at ASC
  `;
  return rows.map(rowToAssignment);
}

/** Get all assignments for an executor. */
export async function getExecutorAssignments(executorId: string): Promise<Assignment[]> {
  const sql = await getConnection();
  const rows = await sql<AssignmentRow[]>`
    SELECT * FROM assignments
    WHERE executor_id = ${executorId}
    ORDER BY started_at ASC
  `;
  return rows.map(rowToAssignment);
}

/** Get a single assignment by ID. */
export async function getAssignment(id: string): Promise<Assignment | null> {
  const sql = await getConnection();
  const rows = await sql<AssignmentRow[]>`SELECT * FROM assignments WHERE id = ${id}`;
  return rows.length > 0 ? rowToAssignment(rows[0]) : null;
}
