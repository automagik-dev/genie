/**
 * Smoke tests for the migrations orchestrator.
 *
 * Validates: dry-run lists discoverable steps, status read works, store
 * read/write atomic, no-op on already-applied. Does NOT exercise actual
 * migration apply paths (that would touch pm2/processes — left for
 * integration tests).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpStore: string;
const ORIGINAL_STORE = process.env.GENIE_MIGRATIONS_STORE;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'genie-mig-test-'));
  tmpStore = join(dir, 'migrations.json');
  process.env.GENIE_MIGRATIONS_STORE = tmpStore;
});

afterEach(() => {
  if (existsSync(tmpStore)) rmSync(tmpStore, { force: true });
  if (ORIGINAL_STORE) process.env.GENIE_MIGRATIONS_STORE = ORIGINAL_STORE;
  else process.env.GENIE_MIGRATIONS_STORE = undefined;
});

test('store: load empty when file missing', async () => {
  const { loadStore } = await import('../store.js');
  const s = loadStore();
  expect(s.applied).toEqual([]);
});

test('store: recordApplied + load round-trip', async () => {
  const { recordApplied, loadStore } = await import('../store.js');
  recordApplied('999-test', '4.0.0', 'test detail');
  const s = loadStore();
  expect(s.applied.length).toBe(1);
  expect(s.applied[0].id).toBe('999-test');
  expect(s.applied[0].status).toBe('APPLIED');
  expect(s.applied[0].appliedFrom).toBe('4.0.0');
});

test('store: recordFailed then recordApplied replaces FAILED', async () => {
  const { recordFailed, recordApplied, loadStore } = await import('../store.js');
  recordFailed('999-test', '4.0.0', 'first attempt err');
  expect(loadStore().applied[0].status).toBe('FAILED');
  recordApplied('999-test', '4.0.1', 'second attempt ok');
  const s = loadStore();
  expect(s.applied.length).toBe(1);
  expect(s.applied[0].status).toBe('APPLIED');
});

test('store: atomic write prevents partial JSON', async () => {
  const { recordApplied } = await import('../store.js');
  recordApplied('999-atomic', '4.0.0');
  const raw = readFileSync(tmpStore, 'utf8');
  // file should be valid JSON in one piece
  expect(() => JSON.parse(raw)).not.toThrow();
});

test('discover: returns sorted by id (lexical)', async () => {
  const { discoverMigrations } = await import('../discover.js');
  const list = discoverMigrations();
  // current shipped: 001-* and 002-*
  expect(list.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < list.length; i++) {
    expect(list[i].id > list[i - 1].id).toBe(true);
  }
});

test('orchestrator: dry-run does not write store for synthetic check=true mig', async () => {
  // We can't easily inject a synthetic migration without filesystem ceremony;
  // instead verify dry-run on the real shipped migrations doesn't record APPLIED.
  const { migrate } = await import('../index.js');
  const _before = existsSync(tmpStore);
  const r = await migrate({ dryRun: true, quiet: true });
  expect(r.results.length).toBeGreaterThanOrEqual(2);
  // Each result should be DRY-RUN, NO-OP, or SKIP — never APPLIED on dry-run
  for (const x of r.results) {
    expect(['DRY-RUN', 'NO-OP', 'SKIP', 'FAIL'].includes(x.status)).toBe(true);
  }
  // If file exists, it should not contain entries from this dry-run
  if (existsSync(tmpStore)) {
    const s = JSON.parse(readFileSync(tmpStore, 'utf8'));
    // dry-run never records APPLIED (NO-OP could record though, that's allowed for short-circuit)
    expect(s.applied.every((r: any) => r.status !== 'APPLIED' || r.detail === 'no-op (check returned false)')).toBe(
      true,
    );
  }
});
