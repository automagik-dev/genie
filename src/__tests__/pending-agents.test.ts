import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredAgent } from '../lib/discovery.js';
import {
  clearPending,
  dismissPending,
  listAllPending,
  listPending,
  loadPending,
  refreshPending,
  removePending,
  savePending,
} from '../lib/pending-agents.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `genie-pending-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, '.genie'), { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeDiscovered(name: string, relPath: string): DiscoveredAgent {
  return {
    name,
    path: join(testDir, relPath),
    relativePath: relPath,
    isSubAgent: false,
  };
}

// ─── loadPending / savePending ──────────────────────────────────────────────

describe('loadPending()', () => {
  test('returns empty store when file does not exist', () => {
    const store = loadPending(testDir);
    expect(store.agents).toEqual([]);
  });

  test('returns empty store when file is corrupted', () => {
    writeFileSync(join(testDir, '.genie', 'pending-agents.json'), 'not json');
    const store = loadPending(testDir);
    expect(store.agents).toEqual([]);
  });

  test('reads persisted agents', () => {
    const data = {
      agents: [
        {
          name: 'auth',
          path: '/tmp/auth',
          relativePath: 'services/auth',
          isSubAgent: false,
          discoveredAt: '2026-01-01T00:00:00.000Z',
          dismissed: false,
        },
      ],
    };
    writeFileSync(join(testDir, '.genie', 'pending-agents.json'), JSON.stringify(data));

    const store = loadPending(testDir);
    expect(store.agents.length).toBe(1);
    expect(store.agents[0].name).toBe('auth');
  });
});

describe('savePending()', () => {
  test('creates file and parent directories', () => {
    const newDir = join(testDir, 'nested', 'workspace');
    savePending(newDir, { agents: [] });

    expect(existsSync(join(newDir, '.genie', 'pending-agents.json'))).toBe(true);
  });

  test('persists agents to disk', () => {
    savePending(testDir, {
      agents: [
        {
          name: 'bot',
          path: '/tmp/bot',
          relativePath: 'tools/bot',
          isSubAgent: false,
          discoveredAt: '2026-01-01T00:00:00.000Z',
          dismissed: false,
        },
      ],
    });

    const raw = readFileSync(join(testDir, '.genie', 'pending-agents.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.agents.length).toBe(1);
    expect(parsed.agents[0].name).toBe('bot');
  });
});

// ─── refreshPending ────────────────────────────────────────────────────────

describe('refreshPending()', () => {
  test('adds new discovered agents to pending', () => {
    const discovered = [makeDiscovered('auth', 'services/auth')];
    const store = refreshPending(testDir, discovered);

    expect(store.agents.length).toBe(1);
    expect(store.agents[0].name).toBe('auth');
    expect(store.agents[0].dismissed).toBe(false);
    expect(store.agents[0].discoveredAt).toBeTruthy();
  });

  test('preserves dismissed state across refreshes', () => {
    const discovered = [makeDiscovered('auth', 'services/auth')];
    refreshPending(testDir, discovered);
    dismissPending(testDir, join(testDir, 'services/auth'));
    const store = refreshPending(testDir, discovered);

    expect(store.agents.length).toBe(1);
    expect(store.agents[0].dismissed).toBe(true);
  });

  test('removes agents no longer discovered', () => {
    refreshPending(testDir, [makeDiscovered('auth', 'services/auth'), makeDiscovered('billing', 'services/billing')]);
    const store = refreshPending(testDir, [makeDiscovered('auth', 'services/auth')]);

    expect(store.agents.length).toBe(1);
    expect(store.agents[0].name).toBe('auth');
  });

  test('preserves original discoveredAt timestamp', () => {
    const discovered = [makeDiscovered('auth', 'services/auth')];
    const first = refreshPending(testDir, discovered);
    const originalTimestamp = first.agents[0].discoveredAt;

    const second = refreshPending(testDir, discovered);
    expect(second.agents[0].discoveredAt).toBe(originalTimestamp);
  });
});

// ─── listPending ────────────────────────────────────────────────────────────

describe('listPending()', () => {
  test('returns only non-dismissed agents', () => {
    refreshPending(testDir, [makeDiscovered('auth', 'services/auth'), makeDiscovered('billing', 'services/billing')]);
    dismissPending(testDir, join(testDir, 'services/auth'));

    const pending = listPending(testDir);
    expect(pending.length).toBe(1);
    expect(pending[0].name).toBe('billing');
  });

  test('listAllPending returns all including dismissed', () => {
    refreshPending(testDir, [makeDiscovered('auth', 'services/auth'), makeDiscovered('billing', 'services/billing')]);
    dismissPending(testDir, join(testDir, 'services/auth'));

    const all = listAllPending(testDir);
    expect(all.length).toBe(2);
  });
});

// ─── dismissPending / removePending ─────────────────────────────────────────

describe('dismissPending()', () => {
  test('marks agent as dismissed', () => {
    refreshPending(testDir, [makeDiscovered('auth', 'services/auth')]);

    const result = dismissPending(testDir, join(testDir, 'services/auth'));
    expect(result).toBe(true);

    const pending = listPending(testDir);
    expect(pending.length).toBe(0);
  });

  test('returns false for unknown path', () => {
    const result = dismissPending(testDir, '/nonexistent');
    expect(result).toBe(false);
  });
});

describe('removePending()', () => {
  test('removes agent from queue entirely', () => {
    refreshPending(testDir, [makeDiscovered('auth', 'services/auth')]);

    const result = removePending(testDir, join(testDir, 'services/auth'));
    expect(result).toBe(true);

    const all = listAllPending(testDir);
    expect(all.length).toBe(0);
  });

  test('returns false for unknown path', () => {
    const result = removePending(testDir, '/nonexistent');
    expect(result).toBe(false);
  });
});

// ─── clearPending ───────────────────────────────────────────────────────────

describe('clearPending()', () => {
  test('removes all pending agents', () => {
    refreshPending(testDir, [makeDiscovered('auth', 'services/auth'), makeDiscovered('billing', 'services/billing')]);

    clearPending(testDir);

    const all = listAllPending(testDir);
    expect(all.length).toBe(0);
  });
});
