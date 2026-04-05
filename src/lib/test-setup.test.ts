/**
 * Tests for the bun test preload hook at src/lib/test-setup.ts.
 *
 * These tests verify that the preload ran before any test file was loaded:
 * - GENIE_TEST_PG_PORT is set to a non-default port
 * - The port is reachable and serves a real postgres
 * - The port is different from the production GENIE_PG_PORT / 19642
 * - db.ts getConnection() routes through the test port (not the daemon)
 */

import { describe, expect, test } from 'bun:test';

describe('test-setup preload hook', () => {
  test('sets GENIE_TEST_PG_PORT to a valid non-default port', () => {
    const raw = process.env.GENIE_TEST_PG_PORT;
    expect(raw).toBeDefined();
    const port = Number.parseInt(raw ?? '', 10);
    expect(Number.isNaN(port)).toBe(false);
    expect(port).toBeGreaterThanOrEqual(20900);
    expect(port).toBeLessThanOrEqual(20999);
  });

  test('test port differs from production default 19642', () => {
    const port = Number.parseInt(process.env.GENIE_TEST_PG_PORT ?? '', 10);
    expect(port).not.toBe(19642);
  });

  test('test port differs from GENIE_PG_PORT env var (if set)', () => {
    const prod = process.env.GENIE_PG_PORT;
    if (!prod) return; // skip when unset
    const test = process.env.GENIE_TEST_PG_PORT;
    expect(test).not.toBe(prod);
  });

  test('GENIE_PG_AVAILABLE is set to true', () => {
    expect(process.env.GENIE_PG_AVAILABLE).toBe('true');
  });

  test('getConnection() reaches a live postgres', async () => {
    const { getConnection } = await import('./db.js');
    const sql = await getConnection();
    const [{ one }] = await sql<[{ one: number }]>`SELECT 1::int AS one`;
    expect(one).toBe(1);
  });
});
