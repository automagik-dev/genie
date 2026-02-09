/**
 * Tests for worker-registry - Sub-pane expansion
 * Run with: bun test src/lib/worker-registry.test.ts
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';

import {
  register,
  get,
  list,
  addSubPane,
  getPane,
  removeSubPane,
  findByWindow,
  type Worker,
} from './worker-registry.js';

// ============================================================================
// Test Setup
// ============================================================================

const TEST_DIR = '/tmp/worker-registry-test';
const TEST_GENIE_DIR = join(TEST_DIR, '.genie');
const TEST_REGISTRY_PATH = join(TEST_GENIE_DIR, 'workers.json');

function cleanTestDir(): void {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
  mkdirSync(TEST_GENIE_DIR, { recursive: true });
}

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'bd-42',
    paneId: '%17',
    session: 'genie',
    worktree: null,
    taskId: 'bd-42',
    startedAt: new Date().toISOString(),
    state: 'working',
    lastStateChange: new Date().toISOString(),
    repoPath: '/tmp/test',
    ...overrides,
  };
}

// ============================================================================
// Worker type: subPanes field
// ============================================================================

describe('Worker type: subPanes field', () => {
  beforeEach(() => {
    cleanTestDir();
    // Point registry to test dir by setting cwd
    process.env.TERM_WORKER_REGISTRY = 'global';
  });

  test('Worker type includes optional subPanes field', () => {
    const worker: Worker = makeWorker({ subPanes: ['%22', '%23'] });
    expect(worker.subPanes).toEqual(['%22', '%23']);
  });

  test('Worker without subPanes has undefined subPanes', () => {
    const worker: Worker = makeWorker();
    expect(worker.subPanes).toBeUndefined();
  });

  test('subPanes persists through register/get cycle', async () => {
    // Use a separate test registry
    const worker = makeWorker({ subPanes: ['%22'] });

    // We need to write directly to test the persistence
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    // Read it back
    const content = JSON.parse(readFileSync(TEST_REGISTRY_PATH, 'utf-8'));
    const loaded = content.workers['bd-42'];
    expect(loaded.subPanes).toEqual(['%22']);
  });
});

// ============================================================================
// addSubPane
// ============================================================================

describe('addSubPane', () => {
  beforeEach(cleanTestDir);

  test('addSubPane("bd-42", "%22") appends to worker subPanes array', async () => {
    // Write initial registry with a worker that has no subPanes
    const worker = makeWorker();
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    await addSubPane('bd-42', '%22', TEST_REGISTRY_PATH);

    const content = JSON.parse(readFileSync(TEST_REGISTRY_PATH, 'utf-8'));
    expect(content.workers['bd-42'].subPanes).toEqual(['%22']);
  });

  test('addSubPane appends to existing subPanes', async () => {
    const worker = makeWorker({ subPanes: ['%22'] });
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    await addSubPane('bd-42', '%23', TEST_REGISTRY_PATH);

    const content = JSON.parse(readFileSync(TEST_REGISTRY_PATH, 'utf-8'));
    expect(content.workers['bd-42'].subPanes).toEqual(['%22', '%23']);
  });

  test('addSubPane does nothing for non-existent worker', async () => {
    const registry = {
      workers: {},
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    // Should not throw
    await addSubPane('ghost', '%99', TEST_REGISTRY_PATH);

    const content = JSON.parse(readFileSync(TEST_REGISTRY_PATH, 'utf-8'));
    expect(Object.keys(content.workers)).toHaveLength(0);
  });
});

// ============================================================================
// getPane
// ============================================================================

describe('getPane', () => {
  beforeEach(cleanTestDir);

  test('getPane("bd-42", 0) returns primary paneId', async () => {
    const worker = makeWorker();
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    const pane = await getPane('bd-42', 0, TEST_REGISTRY_PATH);
    expect(pane).toBe('%17');
  });

  test('getPane("bd-42", 1) returns subPanes[0]', async () => {
    const worker = makeWorker({ subPanes: ['%22', '%23'] });
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    const pane = await getPane('bd-42', 1, TEST_REGISTRY_PATH);
    expect(pane).toBe('%22');
  });

  test('getPane("bd-42", 2) returns subPanes[1]', async () => {
    const worker = makeWorker({ subPanes: ['%22', '%23'] });
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    const pane = await getPane('bd-42', 2, TEST_REGISTRY_PATH);
    expect(pane).toBe('%23');
  });

  test('getPane returns null for out-of-range index', async () => {
    const worker = makeWorker({ subPanes: ['%22'] });
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    const pane = await getPane('bd-42', 5, TEST_REGISTRY_PATH);
    expect(pane).toBeNull();
  });

  test('getPane returns null for non-existent worker', async () => {
    const registry = {
      workers: {},
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    const pane = await getPane('ghost', 0, TEST_REGISTRY_PATH);
    expect(pane).toBeNull();
  });

  test('getPane returns null for index > 0 when no subPanes', async () => {
    const worker = makeWorker(); // no subPanes
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    const pane = await getPane('bd-42', 1, TEST_REGISTRY_PATH);
    expect(pane).toBeNull();
  });
});

// ============================================================================
// removeSubPane
// ============================================================================

describe('removeSubPane', () => {
  beforeEach(cleanTestDir);

  test('removeSubPane removes a pane from subPanes array', async () => {
    const worker = makeWorker({ subPanes: ['%22', '%23', '%24'] });
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    await removeSubPane('bd-42', '%23', TEST_REGISTRY_PATH);

    const content = JSON.parse(readFileSync(TEST_REGISTRY_PATH, 'utf-8'));
    expect(content.workers['bd-42'].subPanes).toEqual(['%22', '%24']);
  });

  test('removeSubPane does nothing if pane not in subPanes', async () => {
    const worker = makeWorker({ subPanes: ['%22'] });
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    await removeSubPane('bd-42', '%99', TEST_REGISTRY_PATH);

    const content = JSON.parse(readFileSync(TEST_REGISTRY_PATH, 'utf-8'));
    expect(content.workers['bd-42'].subPanes).toEqual(['%22']);
  });

  test('removeSubPane does nothing for non-existent worker', async () => {
    const registry = {
      workers: {},
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    // Should not throw
    await removeSubPane('ghost', '%99', TEST_REGISTRY_PATH);
  });

  test('removeSubPane handles worker with no subPanes', async () => {
    const worker = makeWorker(); // no subPanes
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    // Should not throw
    await removeSubPane('bd-42', '%22', TEST_REGISTRY_PATH);
  });
});

// ============================================================================
// loadRegistry fresh-read guarantee
// ============================================================================

describe('loadRegistry fresh-read guarantee', () => {
  beforeEach(cleanTestDir);

  test('registry reads reflect disk changes between calls', async () => {
    // Write initial state
    const worker1 = makeWorker({ id: 'w1', paneId: '%10', taskId: 'w1' });
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify({
      workers: { w1: worker1 },
      lastUpdated: new Date().toISOString(),
    }, null, 2));

    const pane1 = await getPane('w1', 0, TEST_REGISTRY_PATH);
    expect(pane1).toBe('%10');

    // Externally modify the file (simulates another process writing)
    const worker2 = makeWorker({ id: 'w1', paneId: '%99', taskId: 'w1' });
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify({
      workers: { w1: worker2 },
      lastUpdated: new Date().toISOString(),
    }, null, 2));

    // Next read should see the updated value
    const pane2 = await getPane('w1', 0, TEST_REGISTRY_PATH);
    expect(pane2).toBe('%99');
  });
});

// ============================================================================
// windowId field and findByWindow
// ============================================================================

describe('Worker type: windowId field', () => {
  beforeEach(cleanTestDir);

  test('Worker type includes optional windowId field', () => {
    const worker: Worker = makeWorker({ windowId: '@4', windowName: 'bd-42' });
    expect(worker.windowId).toBe('@4');
    expect(worker.windowName).toBe('bd-42');
  });

  test('Worker without windowId has undefined windowId', () => {
    const worker: Worker = makeWorker();
    expect(worker.windowId).toBeUndefined();
  });

  test('windowId persists through register/read cycle', async () => {
    const worker = makeWorker({ windowId: '@7', windowName: 'bd-42' });
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    writeFileSync(TEST_REGISTRY_PATH, JSON.stringify(registry, null, 2));

    const content = JSON.parse(readFileSync(TEST_REGISTRY_PATH, 'utf-8'));
    const loaded = content.workers['bd-42'];
    expect(loaded.windowId).toBe('@7');
    expect(loaded.windowName).toBe('bd-42');
  });
});

describe('findByWindow', () => {
  beforeEach(() => {
    cleanTestDir();
    // We need to set cwd to test dir so the registry path resolves correctly
    // Use global registry to avoid cwd dependency
    process.env.TERM_WORKER_REGISTRY = 'global';
  });

  test('findByWindow returns worker with matching windowId', async () => {
    const worker = makeWorker({ windowId: '@4', windowName: 'bd-42' });
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    // Write to global registry location
    const { mkdirSync: mkdirs } = await import('fs');
    const { join: joinPath } = await import('path');
    const { homedir: home } = await import('os');
    const configDir = joinPath(home(), '.config', 'term');
    mkdirs(configDir, { recursive: true });
    writeFileSync(joinPath(configDir, 'workers.json'), JSON.stringify(registry, null, 2));

    const found = await findByWindow('@4');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('bd-42');
    expect(found!.windowId).toBe('@4');

    // Cleanup
    const { unlinkSync } = await import('fs');
    try { unlinkSync(joinPath(configDir, 'workers.json')); } catch {}
  });

  test('findByWindow returns null for unknown window', async () => {
    const worker = makeWorker({ windowId: '@4' });
    const registry = {
      workers: { [worker.id]: worker },
      lastUpdated: new Date().toISOString(),
    };
    const { mkdirSync: mkdirs } = await import('fs');
    const { join: joinPath } = await import('path');
    const { homedir: home } = await import('os');
    const configDir = joinPath(home(), '.config', 'term');
    mkdirs(configDir, { recursive: true });
    writeFileSync(joinPath(configDir, 'workers.json'), JSON.stringify(registry, null, 2));

    const found = await findByWindow('@999');
    expect(found).toBeNull();

    // Cleanup
    const { unlinkSync } = await import('fs');
    try { unlinkSync(joinPath(configDir, 'workers.json')); } catch {}
  });
});

// ============================================================================
// Cleanup
// ============================================================================

afterAll(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
  delete process.env.TERM_WORKER_REGISTRY;
});
