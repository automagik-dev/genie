/**
 * Tests for board-service.ts — Board CRUD, column management, export/import.
 *
 * Requires pgserve to be running (auto-started via getConnection).
 * Uses isolated test schema via setupTestDatabase().
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  addColumn,
  createBoard,
  deleteBoard,
  exportBoard,
  getBoard,
  getColumns,
  importBoard,
  listBoards,
  removeColumn,
  reorderColumns,
  updateBoard,
  updateColumn,
} from './board-service.js';
import { getConnection } from './db.js';
import { createTemplate } from './template-service.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanupSchema: () => Promise<void>;

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  // ============================================================================
  // Board CRUD
  // ============================================================================

  describe('Board CRUD', () => {
    it('should create a board with columns', async () => {
      const board = await createBoard({
        name: 'test-board',
        description: 'A test board',
        columns: [
          { name: 'todo', label: 'To Do', gate: 'human' },
          { name: 'doing', label: 'Doing', gate: 'agent', action: '/work' },
          { name: 'done', label: 'Done', gate: 'human' },
        ],
      });

      expect(board.id).toMatch(/^board-/);
      expect(board.name).toBe('test-board');
      expect(board.description).toBe('A test board');
      expect(board.columns).toHaveLength(3);
      expect(board.columns[0].name).toBe('todo');
      expect(board.columns[0].position).toBe(0);
      expect(board.columns[1].gate).toBe('agent');
      expect(board.columns[2].position).toBe(2);
      // Each column should have a UUID id
      for (const col of board.columns) {
        expect(col.id).toBeTruthy();
      }
    });

    it('should create a board from template', async () => {
      // Create a template first
      const tmpl = await createTemplate({
        name: 'test-tmpl-for-board',
        columns: [
          {
            id: 'col-1',
            name: 'start',
            label: 'Start',
            gate: 'human',
            action: null,
            auto_advance: false,
            transitions: [],
            roles: ['*'],
            color: '#aaa',
            parallel: false,
            on_fail: null,
            position: 0,
          },
          {
            id: 'col-2',
            name: 'end',
            label: 'End',
            gate: 'human',
            action: null,
            auto_advance: false,
            transitions: [],
            roles: ['*'],
            color: '#bbb',
            parallel: false,
            on_fail: null,
            position: 1,
          },
        ],
      });

      const board = await createBoard({
        name: 'from-template',
        fromTemplate: tmpl.name,
      });

      expect(board.columns).toHaveLength(2);
      expect(board.columns[0].name).toBe('start');
      expect(board.columns[1].name).toBe('end');
      // IDs should be fresh (not from template)
      expect(board.columns[0].id).not.toBe('col-1');
      expect(board.columns[1].id).not.toBe('col-2');
    });

    it('should get a board by ID', async () => {
      const created = await createBoard({ name: 'get-by-id' });
      const found = await getBoard(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe('get-by-id');
    });

    it('should get a board by name', async () => {
      await createBoard({ name: 'get-by-name' });
      const found = await getBoard('get-by-name');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('get-by-name');
    });

    it('should list all boards', async () => {
      const boards = await listBoards();
      expect(boards.length).toBeGreaterThan(0);
    });

    it('should update board metadata', async () => {
      const board = await createBoard({ name: 'to-update' });
      const updated = await updateBoard(board.id, {
        description: 'Updated description',
        config: { key: 'value' },
      });
      expect(updated).not.toBeNull();
      expect(updated!.description).toBe('Updated description');
      expect(updated!.config).toEqual({ key: 'value' });
    });

    it('should delete a board with no active tasks', async () => {
      const board = await createBoard({ name: 'to-delete' });
      const deleted = await deleteBoard(board.id);
      expect(deleted).toBe(true);

      const found = await getBoard(board.id);
      expect(found).toBeNull();
    });

    it('should reject deletion of board with active tasks', async () => {
      const sql = await getConnection();
      const board = await createBoard({
        name: 'board-with-tasks',
        columns: [{ name: 'draft', label: 'Draft', gate: 'human' }],
      });

      // Manually insert a task linked to this board (bypassing task service to avoid type_id FK)
      await sql`
        INSERT INTO tasks (repo_path, title, type_id, stage, board_id, column_id)
        VALUES ('/tmp/test-repo', 'Linked task', 'software', 'draft', ${board.id}, ${board.columns[0].id})
      `;

      await expect(deleteBoard(board.id)).rejects.toThrow(/active task/);
    });
  });

  // ============================================================================
  // Column Management
  // ============================================================================

  describe('Column Management', () => {
    it('should add a column', async () => {
      const board = await createBoard({
        name: 'col-add',
        columns: [{ name: 'start', label: 'Start' }],
      });

      const newCol = await addColumn(board.id, { name: 'middle', label: 'Middle' }, 1);
      expect(newCol.name).toBe('middle');
      expect(newCol.position).toBe(1);

      const cols = await getColumns(board.id);
      expect(cols).toHaveLength(2);
      expect(cols[0].name).toBe('start');
      expect(cols[0].position).toBe(0);
      expect(cols[1].name).toBe('middle');
      expect(cols[1].position).toBe(1);
    });

    it('should remove a column', async () => {
      const board = await createBoard({
        name: 'col-remove',
        columns: [
          { name: 'a', label: 'A' },
          { name: 'b', label: 'B' },
          { name: 'c', label: 'C' },
        ],
      });

      const removed = await removeColumn(board.id, board.columns[1].id);
      expect(removed).toBe(true);

      const cols = await getColumns(board.id);
      expect(cols).toHaveLength(2);
      expect(cols[0].name).toBe('a');
      expect(cols[0].position).toBe(0);
      expect(cols[1].name).toBe('c');
      expect(cols[1].position).toBe(1);
    });

    it('should update a column', async () => {
      const board = await createBoard({
        name: 'col-update',
        columns: [{ name: 'old', label: 'Old', gate: 'human' }],
      });

      const updated = await updateColumn(board.id, board.columns[0].id, {
        label: 'New Label',
        gate: 'agent',
      });
      expect(updated).not.toBeNull();
      expect(updated!.label).toBe('New Label');
      expect(updated!.gate).toBe('agent');
      // ID should be preserved
      expect(updated!.id).toBe(board.columns[0].id);
    });

    it('should reorder columns', async () => {
      const board = await createBoard({
        name: 'col-reorder',
        columns: [
          { name: 'a', label: 'A' },
          { name: 'b', label: 'B' },
          { name: 'c', label: 'C' },
        ],
      });

      const ids = board.columns.map((c) => c.id);
      const reordered = await reorderColumns(board.id, [ids[2], ids[0], ids[1]]);

      expect(reordered[0].name).toBe('c');
      expect(reordered[0].position).toBe(0);
      expect(reordered[1].name).toBe('a');
      expect(reordered[1].position).toBe(1);
      expect(reordered[2].name).toBe('b');
      expect(reordered[2].position).toBe(2);
    });

    it('should get columns sorted by position', async () => {
      const board = await createBoard({
        name: 'col-sorted',
        columns: [
          { name: 'z', label: 'Z' },
          { name: 'a', label: 'A' },
        ],
      });

      const cols = await getColumns(board.id);
      expect(cols[0].name).toBe('z');
      expect(cols[0].position).toBe(0);
      expect(cols[1].name).toBe('a');
      expect(cols[1].position).toBe(1);
    });
  });

  // ============================================================================
  // Export / Import
  // ============================================================================

  describe('Export / Import', () => {
    it('should export and import a board round-trip', async () => {
      const sql = await getConnection();
      // Create a project for the import
      const projRows = await sql`
        INSERT INTO projects (name, repo_path) VALUES ('export-test-proj', '/tmp/export-test')
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `;
      const projectId = projRows[0].id as string;

      const original = await createBoard({
        name: 'export-test',
        description: 'For export testing',
        columns: [
          { name: 'todo', label: 'Todo', gate: 'human', color: '#ff0000' },
          { name: 'done', label: 'Done', gate: 'agent', action: '/work' },
        ],
      });

      const exported = await exportBoard(original.id);
      expect(exported.name).toBe('export-test');
      expect(exported.columns).toHaveLength(2);

      // Import into a different project scope
      const imported = await importBoard({ ...exported, name: 'imported-board' }, projectId);

      expect(imported.name).toBe('imported-board');
      expect(imported.projectId).toBe(projectId);
      expect(imported.columns).toHaveLength(2);
      expect(imported.columns[0].name).toBe('todo');
      expect(imported.columns[0].color).toBe('#ff0000');
    });
  });

  // ============================================================================
  // Audit Events
  // ============================================================================

  describe('Audit Events', () => {
    it('should record audit events for board operations', async () => {
      const sql = await getConnection();

      const board = await createBoard({ name: 'audit-test-board' });

      // Give audit event time to be recorded (fire-and-forget)
      await new Promise((resolve) => setTimeout(resolve, 100));

      const events = await sql`
        SELECT * FROM audit_events
        WHERE entity_type = 'board' AND entity_id = ${board.id}
        ORDER BY created_at DESC
      `;

      expect(events.length).toBeGreaterThan(0);
      const createEvent = events.find((e: Record<string, unknown>) => e.event_type === 'board_created');
      expect(createEvent).toBeTruthy();
    });
  });
});
