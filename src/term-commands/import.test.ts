/**
 * Tests for import command — table name validation against schema whitelist.
 *
 * Verifies that SQL injection via malicious table names in export JSON is blocked.
 */

import { describe, expect, test } from 'bun:test';
import { GROUP_TABLES } from '../lib/export-format.js';
import { assertValidTable } from './import.js';

describe('assertValidTable', () => {
  test('accepts all tables from GROUP_TABLES', () => {
    const allTables = Object.values(GROUP_TABLES).flat();
    for (const table of allTables) {
      expect(() => assertValidTable(table)).not.toThrow();
    }
  });

  test('rejects SQL injection attempt with DROP TABLE', () => {
    expect(() => assertValidTable('users; DROP TABLE users --')).toThrow('not in the schema whitelist');
  });

  test('rejects SQL injection attempt with UNION SELECT', () => {
    expect(() => assertValidTable("' UNION SELECT * FROM pg_shadow --")).toThrow('not in the schema whitelist');
  });

  test('rejects unknown table name', () => {
    expect(() => assertValidTable('nonexistent_table')).toThrow('not in the schema whitelist');
  });

  test('rejects empty string', () => {
    expect(() => assertValidTable('')).toThrow('not in the schema whitelist');
  });

  test('rejects table name with semicolon', () => {
    expect(() => assertValidTable('tasks; DELETE FROM tasks')).toThrow('not in the schema whitelist');
  });

  test('error message includes the invalid table name', () => {
    expect(() => assertValidTable('evil_table')).toThrow('Invalid table name: "evil_table"');
  });
});
