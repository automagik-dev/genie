/**
 * Tests for the approve CLI command module
 *
 * Tests:
 * - getStatusEntries: reads pending queue (audit log entries now come from PG)
 * - manualApprove: approves a pending request by ID
 * - manualDeny: denies a pending request by ID
 * - startEngine / stopEngine: controls the auto-approve engine lifecycle
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Module under test
import { getStatusEntries, isEngineRunning, manualApprove, manualDeny, startEngine, stopEngine } from './approve.js';

// Sibling types for queue manipulation
import { type PermissionRequest, createPermissionRequestQueue } from '../lib/event-listener.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTmpDir(): string {
  const dir = join(tmpdir(), `approve-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '.genie'), { recursive: true });
  return dir;
}

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: overrides.id ?? 'req-test-0001',
    toolName: overrides.toolName ?? 'Bash',
    toolInput: overrides.toolInput ?? { command: 'bun test' },
    paneId: overrides.paneId ?? '%42',
    wishId: overrides.wishId,
    sessionId: overrides.sessionId ?? 'sess-1',
    cwd: overrides.cwd ?? '/tmp',
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
}

// ============================================================================
// Tests: getStatusEntries
// ============================================================================

describe('getStatusEntries', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns pending requests from the queue', async () => {
    const queue = createPermissionRequestQueue();
    const req = makeRequest({ id: 'req-abc' });
    queue.add(req);

    const entries = await getStatusEntries({ queue });
    // Pending entry should be included (PG audit entries may also be present)
    const pending = entries.filter((e) => e.status === 'pending');
    expect(pending.length).toBe(1);
    expect(pending[0].requestId).toBe('req-abc');
    expect(pending[0].toolName).toBe('Bash');
  });
});

// ============================================================================
// Tests: manualApprove / manualDeny
// ============================================================================

describe('manualApprove', () => {
  it('removes request from queue and returns true when found', () => {
    const queue = createPermissionRequestQueue();
    const req = makeRequest({ id: 'req-to-approve' });
    queue.add(req);

    const result = manualApprove('req-to-approve', { queue });
    expect(result).toBe(true);
    expect(queue.size()).toBe(0);
  });

  it('returns false when request not found', () => {
    const queue = createPermissionRequestQueue();
    const result = manualApprove('nonexistent', { queue });
    expect(result).toBe(false);
  });
});

describe('manualDeny', () => {
  it('removes request from queue and returns true when found', () => {
    const queue = createPermissionRequestQueue();
    const req = makeRequest({ id: 'req-to-deny' });
    queue.add(req);

    const result = manualDeny('req-to-deny', { queue });
    expect(result).toBe(true);
    expect(queue.size()).toBe(0);
  });

  it('returns false when request not found', () => {
    const queue = createPermissionRequestQueue();
    const result = manualDeny('nonexistent', { queue });
    expect(result).toBe(false);
  });
});

// ============================================================================
// Tests: startEngine / stopEngine
// ============================================================================

describe('engine lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    if (isEngineRunning()) {
      stopEngine();
    }
  });

  afterEach(() => {
    if (isEngineRunning()) {
      stopEngine();
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isEngineRunning returns false initially', () => {
    expect(isEngineRunning()).toBe(false);
  });

  it('startEngine sets running state to true', async () => {
    await startEngine({ repoPath: tmpDir });
    expect(isEngineRunning()).toBe(true);
  });

  it('stopEngine sets running state to false', async () => {
    await startEngine({ repoPath: tmpDir });
    stopEngine();
    expect(isEngineRunning()).toBe(false);
  });

  it('calling startEngine twice does not throw', async () => {
    await startEngine({ repoPath: tmpDir });
    await startEngine({ repoPath: tmpDir });
    expect(isEngineRunning()).toBe(true);
  });

  it('calling stopEngine when not running does not throw', () => {
    expect(() => stopEngine()).not.toThrow();
  });
});
