/**
 * Tests for template-service.ts — Template CRUD, snapshots from boards.
 *
 * Requires pgserve to be running (auto-started via getConnection).
 * Uses isolated test schema via setupTestDatabase().
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { BoardColumn } from './board-service.js';
import { createBoard } from './board-service.js';
import { getConnection } from './db.js';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  renameTemplate,
  snapshotFromBoard,
  updateTemplate,
  updateTemplateColumn,
} from './template-service.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanupSchema: () => Promise<void>;

  const makeColumn = (name: string, position: number): BoardColumn => ({
    id: crypto.randomUUID(),
    name,
    label: name.charAt(0).toUpperCase() + name.slice(1),
    gate: 'human',
    action: null,
    auto_advance: false,
    transitions: [],
    roles: ['*'],
    color: '#94a3b8',
    parallel: false,
    on_fail: null,
    position,
  });

  beforeAll(async () => {
    cleanupSchema = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanupSchema();
  });

  // ============================================================================
  // Template CRUD
  // ============================================================================

  describe('Template CRUD', () => {
    it('should create a template', async () => {
      const tmpl = await createTemplate({
        name: 'custom-pipeline',
        description: 'A custom pipeline',
        icon: 'rocket',
        columns: [makeColumn('start', 0), makeColumn('end', 1)],
      });

      expect(tmpl.id).toMatch(/^tmpl-/);
      expect(tmpl.name).toBe('custom-pipeline');
      expect(tmpl.description).toBe('A custom pipeline');
      expect(tmpl.icon).toBe('rocket');
      expect(tmpl.columns).toHaveLength(2);
      expect(tmpl.isBuiltin).toBe(false);
    });

    it('should get template by ID', async () => {
      const created = await createTemplate({
        name: 'get-by-id-tmpl',
        columns: [makeColumn('col1', 0)],
      });

      const found = await getTemplate(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('should get template by name', async () => {
      await createTemplate({
        name: 'get-by-name-tmpl',
        columns: [makeColumn('col1', 0)],
      });

      const found = await getTemplate('get-by-name-tmpl');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('get-by-name-tmpl');
    });

    it('should list all templates including builtins', async () => {
      const templates = await listTemplates();
      // Should have builtins from migration + any custom ones
      expect(templates.length).toBeGreaterThan(0);
      // Builtins should come first (sorted by is_builtin DESC)
      const builtins = templates.filter((t) => t.isBuiltin);
      expect(builtins.length).toBeGreaterThan(0);
    });

    it('should update a template', async () => {
      const tmpl = await createTemplate({
        name: 'to-update-tmpl',
        columns: [makeColumn('col1', 0)],
      });

      const updated = await updateTemplate(tmpl.id, {
        description: 'Updated desc',
        icon: 'star',
      });

      expect(updated).not.toBeNull();
      expect(updated!.description).toBe('Updated desc');
      expect(updated!.icon).toBe('star');
    });

    it('should delete a template (even builtins)', async () => {
      // Create a template and delete it
      const tmpl = await createTemplate({
        name: 'to-delete-tmpl',
        columns: [],
      });

      const deleted = await deleteTemplate(tmpl.id);
      expect(deleted).toBe(true);

      const found = await getTemplate(tmpl.id);
      expect(found).toBeNull();
    });

    it('should delete builtin templates', async () => {
      // Get one of the builtin templates
      const builtins = (await listTemplates()).filter((t) => t.isBuiltin);
      if (builtins.length === 0) return; // No builtins in test schema — skip

      const target = builtins[builtins.length - 1]; // Take the last one to avoid affecting other tests
      const deleted = await deleteTemplate(target.id);
      expect(deleted).toBe(true);
    });

    it('should rename a template', async () => {
      const tmpl = await createTemplate({
        name: 'rename-me-tmpl',
        columns: [],
      });

      const renamed = await renameTemplate(tmpl.id, 'renamed-tmpl');
      expect(renamed).not.toBeNull();
      expect(renamed!.name).toBe('renamed-tmpl');
    });
  });

  // ============================================================================
  // Template Column Updates
  // ============================================================================

  describe('Template Column Updates', () => {
    it('should update a specific column within a template', async () => {
      const tmpl = await createTemplate({
        name: 'col-update-tmpl',
        columns: [makeColumn('todo', 0), makeColumn('done', 1)],
      });

      const updated = await updateTemplateColumn(tmpl.id, 'todo', {
        gate: 'agent',
        action: '/work',
        color: '#ff0000',
      });

      expect(updated).not.toBeNull();
      const todoCol = updated!.columns.find((c) => c.name === 'todo');
      expect(todoCol).toBeTruthy();
      expect(todoCol!.gate).toBe('agent');
      expect(todoCol!.action).toBe('/work');
      expect(todoCol!.color).toBe('#ff0000');
    });

    it('should throw for non-existent column name', async () => {
      const tmpl = await createTemplate({
        name: 'col-missing-tmpl',
        columns: [makeColumn('todo', 0)],
      });

      await expect(updateTemplateColumn(tmpl.id, 'nonexistent', { gate: 'agent' })).rejects.toThrow(/not found/);
    });
  });

  // ============================================================================
  // Snapshot from Board
  // ============================================================================

  describe('Snapshot from Board', () => {
    it('should create a template from an existing board', async () => {
      const board = await createBoard({
        name: 'snapshot-source',
        description: 'Source board',
        columns: [
          { name: 'backlog', label: 'Backlog', gate: 'human', color: '#aaa' },
          { name: 'active', label: 'Active', gate: 'agent', action: '/work', auto_advance: true },
          { name: 'complete', label: 'Complete', gate: 'human' },
        ],
      });

      const tmpl = await snapshotFromBoard(board.id, 'snapshot-template');

      expect(tmpl.name).toBe('snapshot-template');
      expect(tmpl.columns).toHaveLength(3);
      expect(tmpl.columns[0].name).toBe('backlog');
      expect(tmpl.columns[1].name).toBe('active');
      expect(tmpl.columns[1].gate).toBe('agent');
      expect(tmpl.columns[1].action).toBe('/work');
      expect(tmpl.columns[2].name).toBe('complete');
      expect(tmpl.isBuiltin).toBe(false);
    });
  });

  // ============================================================================
  // Audit Events
  // ============================================================================

  describe('Template Audit Events', () => {
    it('should record audit events for template operations', async () => {
      const sql = await getConnection();

      const tmpl = await createTemplate({
        name: 'audit-test-tmpl',
        columns: [],
      });

      // Give audit event time to be recorded
      await new Promise((resolve) => setTimeout(resolve, 100));

      const events = await sql`
        SELECT * FROM audit_events
        WHERE entity_type = 'template' AND entity_id = ${tmpl.id}
        ORDER BY created_at DESC
      `;

      expect(events.length).toBeGreaterThan(0);
      const createEvent = events.find((e: Record<string, unknown>) => e.event_type === 'template_created');
      expect(createEvent).toBeTruthy();
    });
  });
});
