/**
 * Tests for import command — table name validation against schema whitelist.
 *
 * Verifies that SQL injection via malicious table names in export JSON is blocked.
 */

import { describe, expect, test } from 'bun:test';
import { GROUP_TABLES } from '../lib/export-format.js';
import { assertValidColumnName, assertValidTable } from './import.js';

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

describe('assertValidColumnName', () => {
  test('accepts normal column names', () => {
    for (const name of ['id', 'name', 'created_at', 'parent_id', '_private', 'Col123']) {
      expect(() => assertValidColumnName(name)).not.toThrow();
    }
  });

  test('rejects column name with embedded double quote (SQL injection)', () => {
    expect(() => assertValidColumnName('foo"; DROP TABLE x; --')).toThrow('disallowed characters');
  });

  test('rejects column name with spaces', () => {
    expect(() => assertValidColumnName('column name')).toThrow('disallowed characters');
  });

  test('rejects column name with semicolon', () => {
    expect(() => assertValidColumnName('col;DELETE')).toThrow('disallowed characters');
  });

  test('rejects column name starting with a digit', () => {
    expect(() => assertValidColumnName('1column')).toThrow('disallowed characters');
  });

  test('rejects empty string', () => {
    expect(() => assertValidColumnName('')).toThrow('disallowed characters');
  });

  test('rejects column with parentheses', () => {
    expect(() => assertValidColumnName('col()')).toThrow('disallowed characters');
  });

  test('rejects column with single quotes', () => {
    expect(() => assertValidColumnName("col'val")).toThrow('disallowed characters');
  });

  test('truncates long malicious names in error message', () => {
    const longName = `${'a'.repeat(100)}"injection`;
    try {
      assertValidColumnName(longName);
      throw new Error('Expected to throw');
    } catch (e) {
      const msg = (e as Error).message;
      // Should be truncated to 60 chars in the error message
      expect(msg.length).toBeLessThan(200);
      expect(msg).toContain('disallowed characters');
    }
  });
});
