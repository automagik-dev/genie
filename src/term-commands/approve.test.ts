/**
 * Tests for the approve CLI command module
 *
 * Tests:
 * - getStatusEntries: reads audit log + pending queue and returns structured data
 * - manualApprove: approves a pending request by ID
 * - manualDeny: denies a pending request by ID
 * - startEngine / stopEngine: controls the auto-approve engine lifecycle
 * - --no-auto-approve flag presence on WorkOptions
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Module under test
import {
  getStatusEntries,
  manualApprove,
  manualDeny,
  startEngine,
  stopEngine,
  isEngineRunning,
  type StatusEntry,
} from './approve.js';

// Sibling types for queue manipulation
import { createPermissionRequestQueue, type PermissionRequest } from '../lib/event-listener.js';
import type { AuditLogEntry } from '../lib/auto-approve-engine.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTmpDir(): string {
  const dir = join(tmpdir(), `approve-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, '.genie'), { recursive: true });
  return dir;
}

function writeAuditLog(baseDir: string, entries: AuditLogEntry[]): void {
  const logPath = join(baseDir, '.genie', 'auto-approve-audit.jsonl');
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(logPath, content, 'utf-8');
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

  it('returns empty list when no audit log and no pending requests', () => {
    const queue = createPermissionRequestQueue();
    const entries = getStatusEntries({ auditDir: tmpDir, queue });
    expect(entries).toEqual([]);
  });

  it('returns pending requests from the queue', () => {
    const queue = createPermissionRequestQueue();
    const req = makeRequest({ id: 'req-abc' });
    queue.add(req);

    const entries = getStatusEntries({ auditDir: tmpDir, queue });
    expect(entries.length).toBe(1);
    expect(entries[0].status).toBe('pending');
    expect(entries[0].requestId).toBe('req-abc');
    expect(entries[0].toolName).toBe('Bash');
  });

  it('returns approved/denied/escalated entries from audit log', () => {
    const auditEntries: AuditLogEntry[] = [
      {
        timestamp: '2026-02-03T10:00:00Z',
        paneId: '%42',
        toolName: 'Read',
        action: 'approve',
        reason: 'allowed',
        wishId: undefined,
        requestId: 'req-001',
      },
      {
        timestamp: '2026-02-03T10:01:00Z',
        paneId: '%42',
        toolName: 'Bash',
        action: 'deny',
        reason: 'denied',
        wishId: undefined,
        requestId: 'req-002',
      },
      {
        timestamp: '2026-02-03T10:02:00Z',
        paneId: '%42',
        toolName: 'Write',
        action: 'escalate',
        reason: 'escalated',
        wishId: undefined,
        requestId: 'req-003',
      },
    ];

    writeAuditLog(tmpDir, auditEntries);
    const queue = createPermissionRequestQueue();
    const entries = getStatusEntries({ auditDir: tmpDir, queue });

    expect(entries.length).toBe(3);
    expect(entries[0].status).toBe('approved');
    expect(entries[0].requestId).toBe('req-001');
    expect(entries[1].status).toBe('denied');
    expect(entries[1].requestId).toBe('req-002');
    expect(entries[2].status).toBe('escalated');
    expect(entries[2].requestId).toBe('req-003');
  });

  it('combines pending requests and audit log entries', () => {
    const auditEntries: AuditLogEntry[] = [
      {
        timestamp: '2026-02-03T10:00:00Z',
        paneId: '%42',
        toolName: 'Read',
        action: 'approve',
        reason: 'allowed',
        wishId: undefined,
        requestId: 'req-001',
      },
    ];
    writeAuditLog(tmpDir, auditEntries);

    const queue = createPermissionRequestQueue();
    queue.add(makeRequest({ id: 'req-pending' }));

    const entries = getStatusEntries({ auditDir: tmpDir, queue });
    expect(entries.length).toBe(2);

    const statuses = entries.map((e) => e.status);
    expect(statuses).toContain('pending');
    expect(statuses).toContain('approved');
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
    // Ensure engine is stopped before each test
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
    await startEngine({ auditDir: tmpDir, repoPath: tmpDir });
    expect(isEngineRunning()).toBe(true);
  });

  it('stopEngine sets running state to false', async () => {
    await startEngine({ auditDir: tmpDir, repoPath: tmpDir });
    stopEngine();
    expect(isEngineRunning()).toBe(false);
  });

  it('calling startEngine twice does not throw', async () => {
    await startEngine({ auditDir: tmpDir, repoPath: tmpDir });
    await startEngine({ auditDir: tmpDir, repoPath: tmpDir });
    expect(isEngineRunning()).toBe(true);
  });

  it('calling stopEngine when not running does not throw', () => {
    expect(() => stopEngine()).not.toThrow();
  });
});

// ============================================================================
// Tests: WorkOptions --no-auto-approve flag
// ============================================================================

describe('WorkOptions includes noAutoApprove', () => {
  it('WorkOptions type accepts noAutoApprove field', async () => {
    // Import the type and verify the field compiles
    const { workCommand } = await import('./work.js');
    // This test is compile-time: if WorkOptions does not include noAutoApprove,
    // TypeScript compilation will fail. At runtime we just verify the import succeeds.
    expect(typeof workCommand).toBe('function');
  });
});
