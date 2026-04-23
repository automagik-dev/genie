/**
 * Tests for session-filewatch module
 *
 * Focused on the FK-violation circuit breaker: when ingest raises a foreign
 * key constraint error (orphan subagent JSONLs — parent session not in the
 * sessions table), handleFileChange must:
 *   1. Log the error once.
 *   2. Advance the offset cache past the file so subsequent fs.watch events
 *      skip ingest entirely (no retry-forever log spam).
 *
 * Non-FK errors (transient connection resets, deadlocks, etc.) must NOT
 * advance the offset — retry semantics are preserved.
 *
 * Run with: bun test src/lib/session-filewatch.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FilewatchDeps } from './session-filewatch.js';
import { handleFileChange, isForeignKeyViolation, resetUnrecoverableSessions } from './session-filewatch.js';

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Build a fake JSONL path that matches extractSessionInfo's subagent layout:
 *   <tmp>/projects/<hash>/<parent-id>/subagents/<session-id>.jsonl
 *
 * This ensures `handleFileChange` treats the file as a valid session and
 * proceeds to the ingest path (where our mock throws).
 */
function makeSubagentFile(tmpRoot: string, parentId: string, sessionId: string): string {
  const dir = join(tmpRoot, 'projects', 'some-hash', parentId, 'subagents');
  // Touch the file so any real fs.stat downstream wouldn't blow up — though
  // our mocked ingestFileFull never reads it.
  writeFileSync(join(dir, `${sessionId}.jsonl`), '', { flag: 'a' });
  return join(dir, `${sessionId}.jsonl`);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function makeDeps(overrides: Partial<FilewatchDeps> = {}): FilewatchDeps {
  return {
    buildWorkerMap: async () => new Map(),
    ingestFileFull: async () => ({ newOffset: 0, contentRowsInserted: 0, toolEventsInserted: 0 }),
    setLiveWorkPending: () => {},
    logError: () => {},
    ...overrides,
  } as FilewatchDeps;
}

const fakeSql: unknown = {};

// ============================================================================
// isForeignKeyViolation — detection helper
// ============================================================================

describe('isForeignKeyViolation', () => {
  test('detects postgres error code 23503', () => {
    const err = Object.assign(new Error('insert failed'), { code: '23503' });
    expect(isForeignKeyViolation(err)).toBe(true);
  });

  test('detects message containing "foreign key constraint"', () => {
    const err = new Error('insert or update violates foreign key constraint "sessions_parent_fk"');
    expect(isForeignKeyViolation(err)).toBe(true);
  });

  test('rejects unrelated errors', () => {
    expect(isForeignKeyViolation(new Error('ECONNRESET'))).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
    expect(isForeignKeyViolation('string error')).toBe(false);
  });
});

// ============================================================================
// handleFileChange — FK circuit breaker (Bug A regression)
// ============================================================================

describe('handleFileChange — FK violation', () => {
  let tmpRoot: string;

  beforeEach(() => {
    resetUnrecoverableSessions();
    tmpRoot = mkdtempSync(join(tmpdir(), 'filewatch-test-'));
    ensureDir(join(tmpRoot, 'projects', 'some-hash', 'parent-123', 'subagents'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('FK error → session marked unrecoverable, second call skips ingest entirely', async () => {
    const filePath = makeSubagentFile(tmpRoot, 'parent-123', 'orphan-session-a');
    let ingestCallCount = 0;
    const errors: string[] = [];

    const deps = makeDeps({
      ingestFileFull: async () => {
        ingestCallCount++;
        throw Object.assign(new Error('insert violates foreign key constraint'), { code: '23503' });
      },
      logError: (msg) => errors.push(msg),
    });

    // First call — ingest attempted, FK raised, session marked unrecoverable
    await handleFileChange(filePath, fakeSql, deps);
    expect(ingestCallCount).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('FK constraint violation');

    // Second call — MUST skip ingest entirely (no retry spam)
    await handleFileChange(filePath, fakeSql, deps);
    expect(ingestCallCount).toBe(1); // unchanged — no second attempt
    expect(errors.length).toBe(1); // no second log

    // Third call — still silenced
    await handleFileChange(filePath, fakeSql, deps);
    expect(ingestCallCount).toBe(1);
    expect(errors.length).toBe(1);
  });

  test('non-FK transient error → offset NOT advanced, retries preserved', async () => {
    const filePath = makeSubagentFile(tmpRoot, 'parent-123', 'flaky-session-b');
    let ingestCallCount = 0;
    const errors: string[] = [];

    const deps = makeDeps({
      ingestFileFull: async () => {
        ingestCallCount++;
        throw new Error('ECONNRESET: connection reset by peer');
      },
      logError: (msg) => errors.push(msg),
    });

    // First call — transient error logged, session NOT marked unrecoverable
    await handleFileChange(filePath, fakeSql, deps);
    expect(ingestCallCount).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).not.toContain('FK constraint');
    expect(errors[0]).toContain('error ingesting');

    // Second call — MUST retry ingest (transient errors have at-least-once
    // semantics; only FK errors are terminal)
    await handleFileChange(filePath, fakeSql, deps);
    expect(ingestCallCount).toBe(2); // retried
    expect(errors.length).toBe(2);
  });
});
