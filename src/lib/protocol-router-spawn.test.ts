/**
 * Protocol Router Spawn — Unit Tests
 *
 * Tests error surfacing in inbox writes and resume context injection.
 * Uses _deps injection (NO mock.module) to avoid bun shared-module-cache leaking.
 *
 * Run with: bun test src/lib/protocol-router-spawn.test.ts
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Tests — _deps injection (no mock.module, no leaking)
// ============================================================================

describe('protocol-router-spawn error surfacing', () => {
  let tempDir: string;
  let warnSpy: ReturnType<typeof spyOn>;
  const warnCalls: string[] = [];

  // Save original _deps for restoration
  let origDeps: typeof import('./protocol-router-spawn.js')._deps;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spawn-test-'));
    warnCalls.length = 0;
    warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnCalls.push(args.map(String).join(' '));
    });

    // Save originals
    const mod = await import('./protocol-router-spawn.js');
    origDeps = { ...mod._deps };
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    // Restore _deps to defaults
    const mod = await import('./protocol-router-spawn.js');
    Object.assign(mod._deps, origDeps);
    await rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Deliverable 2: Resume context injection error surfacing
  // -------------------------------------------------------------------------

  describe('injectResumeContext', () => {
    test('logs warning when resume context injection fails', async () => {
      const mod = await import('./protocol-router-spawn.js');

      // Override _deps: findAnyGroupByAssignee returns a match, mailboxSend throws
      mod._deps.findAnyGroupByAssignee = async () => ({
        slug: 'test-wish',
        groupName: '1',
        group: { status: 'in_progress', startedAt: '2026-03-31T00:00:00Z' } as any,
      });
      mod._deps.mailboxSend = async () => {
        throw new Error('PG connection refused');
      };

      // Should NOT throw — resume context is best-effort
      await mod.injectResumeContext(tempDir, 'worker-1', 'engineer', 'test-team');

      const resumeWarn = warnCalls.find((c) => c.includes('Resume context injection failed'));
      expect(resumeWarn).toBeTruthy();
      expect(resumeWarn).toContain('PG connection refused');
    });

    test('no warning on successful resume context injection', async () => {
      const mod = await import('./protocol-router-spawn.js');

      mod._deps.findAnyGroupByAssignee = async () => ({
        slug: 'test-wish',
        groupName: '1',
        group: { status: 'in_progress', startedAt: '2026-03-31T00:00:00Z' } as any,
      });
      mod._deps.mailboxSend = async () => ({ id: 'msg-1' }) as any;

      await mod.injectResumeContext(tempDir, 'worker-1', 'engineer', 'test-team');

      const resumeWarn = warnCalls.find((c) => c.includes('Resume context injection failed'));
      expect(resumeWarn).toBeUndefined();
    });

    test('no-op when no matching group exists', async () => {
      const mod = await import('./protocol-router-spawn.js');

      mod._deps.findAnyGroupByAssignee = async () => null;

      await mod.injectResumeContext(tempDir, 'nonexistent', 'engineer', 'test-team');

      const anyWarn = warnCalls.find((c) => c.includes('[protocol-router]'));
      expect(anyWarn).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Deliverable 1: Native inbox write error handling
  // -------------------------------------------------------------------------

  describe('writeNativeInbox error handling', () => {
    test('_deps.writeNativeInbox is overridable for error injection', async () => {
      const mod = await import('./protocol-router-spawn.js');

      let callArgs: { team: string; target: string } | null = null;
      mod._deps.writeNativeInbox = async (team: string, target: string) => {
        callArgs = { team, target };
      };

      await mod._deps.writeNativeInbox('test-team', 'test-lead', {} as any);
      expect(callArgs).not.toBeNull();
      expect(callArgs!.team).toBe('test-team');
      expect(callArgs!.target).toBe('test-lead');
    });
  });
});
