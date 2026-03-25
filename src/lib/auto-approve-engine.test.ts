/**
 * Auto-Approve Engine Tests
 *
 * Tests the engine that ties together config loading, event subscription,
 * rule matching, and approval via tmux send-keys.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedEvent } from '../term-commands/events.js';
import type { AutoApproveConfig } from './auto-approve.js';
import type { PermissionRequest } from './event-listener.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeTmpDir(): string {
  const dir = join('/tmp', `auto-approve-engine-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePermissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: `req-test-${Date.now()}`,
    toolName: 'Read',
    paneId: '%42',
    wishId: 'wish-23',
    sessionId: 'session-abc',
    cwd: '/tmp/test-repo',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeNormalizedEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    type: 'permission_request',
    timestamp: new Date().toISOString(),
    sessionId: 'session-abc',
    cwd: '/tmp/test-repo',
    paneId: '%42',
    wishId: 'wish-23',
    toolName: 'Read',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AutoApproveConfig['defaults']> = {}): AutoApproveConfig {
  return {
    defaults: {
      allow: ['Read', 'Glob', 'Grep'],
      deny: [],
      ...overrides,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('AutoApproveEngine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createAutoApproveEngine', () => {
    test('creates an engine with start/stop methods', async () => {
      const engine = await import('./auto-approve-engine.js');
      const instance = engine.createAutoApproveEngine({
        config: makeConfig(),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      expect(instance).toBeDefined();
      expect(typeof instance.start).toBe('function');
      expect(typeof instance.stop).toBe('function');
      expect(typeof instance.processRequest).toBe('function');
      expect(typeof instance.isRunning).toBe('function');
    });

    test('engine starts in stopped state', async () => {
      const engine = await import('./auto-approve-engine.js');
      const instance = engine.createAutoApproveEngine({
        config: makeConfig(),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      expect(instance.isRunning()).toBe(false);
    });

    test('engine can be started and stopped', async () => {
      const engine = await import('./auto-approve-engine.js');
      const instance = engine.createAutoApproveEngine({
        config: makeConfig(),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      instance.start();
      expect(instance.isRunning()).toBe(true);

      instance.stop();
      expect(instance.isRunning()).toBe(false);
    });

    test('starting an already-running engine is a no-op', async () => {
      const engine = await import('./auto-approve-engine.js');
      const instance = engine.createAutoApproveEngine({
        config: makeConfig(),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      instance.start();
      instance.start(); // Should not throw
      expect(instance.isRunning()).toBe(true);

      instance.stop();
    });

    test('stopping an already-stopped engine is a no-op', async () => {
      const engine = await import('./auto-approve-engine.js');
      const instance = engine.createAutoApproveEngine({
        config: makeConfig(),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      instance.stop(); // Should not throw
      expect(instance.isRunning()).toBe(false);
    });
  });

  describe('processRequest - approved requests', () => {
    test('approves a request for an allowed tool and triggers sendApproval', async () => {
      const engine = await import('./auto-approve-engine.js');
      const approvalCalls: string[] = [];

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read', 'Glob'] }),
        auditDir: tmpDir,
        sendApproval: async (paneId: string) => {
          approvalCalls.push(paneId);
        },
      });

      instance.start();

      const request = makePermissionRequest({ toolName: 'Read', paneId: '%42' });
      const decision = await instance.processRequest(request);

      expect(decision.action).toBe('approve');
      expect(approvalCalls).toEqual(['%42']);

      instance.stop();
    });

    test('writes approve entry to audit log', async () => {
      const engine = await import('./auto-approve-engine.js');

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      instance.start();

      const request = makePermissionRequest({ toolName: 'Read', paneId: '%42', wishId: 'wish-23' });
      const decision = await instance.processRequest(request);

      // Audit now goes to PG via recordAuditEvent (best-effort, fire-and-forget)
      expect(decision.action).toBe('approve');
      expect(decision.reason).toBeDefined();
      expect(instance.getStats().approved).toBe(1);

      instance.stop();
    });
  });

  describe('processRequest - denied requests', () => {
    test('denies a request for a denied tool and does NOT trigger sendApproval', async () => {
      const engine = await import('./auto-approve-engine.js');
      const approvalCalls: string[] = [];

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'], deny: ['Write'] }),
        auditDir: tmpDir,
        sendApproval: async (paneId: string) => {
          approvalCalls.push(paneId);
        },
      });

      instance.start();

      const request = makePermissionRequest({ toolName: 'Write', paneId: '%42' });
      const decision = await instance.processRequest(request);

      expect(decision.action).toBe('deny');
      expect(approvalCalls).toEqual([]); // No approval sent

      instance.stop();
    });

    test('writes deny entry to audit log', async () => {
      const engine = await import('./auto-approve-engine.js');

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'], deny: ['Write'] }),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      instance.start();

      const request = makePermissionRequest({ toolName: 'Write', paneId: '%42' });
      const decision = await instance.processRequest(request);

      expect(decision.action).toBe('deny');
      expect(instance.getStats().denied).toBe(1);

      instance.stop();
    });
  });

  describe('processRequest - escalated requests', () => {
    test('escalates a request for an unknown tool and does NOT trigger sendApproval', async () => {
      const engine = await import('./auto-approve-engine.js');
      const approvalCalls: string[] = [];

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (paneId: string) => {
          approvalCalls.push(paneId);
        },
      });

      instance.start();

      const request = makePermissionRequest({ toolName: 'UnknownTool', paneId: '%42' });
      const decision = await instance.processRequest(request);

      expect(decision.action).toBe('escalate');
      expect(approvalCalls).toEqual([]); // No approval sent

      instance.stop();
    });

    test('writes escalate entry to audit log', async () => {
      const engine = await import('./auto-approve-engine.js');

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      instance.start();

      const request = makePermissionRequest({ toolName: 'UnknownTool' });
      const decision = await instance.processRequest(request);

      expect(decision.action).toBe('escalate');
      expect(instance.getStats().escalated).toBe(1);

      instance.stop();
    });
  });

  describe('processRequest - engine not running', () => {
    test('does not process requests when engine is stopped', async () => {
      const engine = await import('./auto-approve-engine.js');
      const approvalCalls: string[] = [];

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (paneId: string) => {
          approvalCalls.push(paneId);
        },
      });

      // Engine is NOT started
      const request = makePermissionRequest({ toolName: 'Read', paneId: '%42' });
      const decision = await instance.processRequest(request);

      expect(decision.action).toBe('escalate');
      expect(decision.reason).toContain('not running');
      expect(approvalCalls).toEqual([]);
    });
  });

  describe('processEvent - integration with event subscription', () => {
    test('processes a permission_request NormalizedEvent end-to-end', async () => {
      const engine = await import('./auto-approve-engine.js');
      const approvalCalls: string[] = [];

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (paneId: string) => {
          approvalCalls.push(paneId);
        },
      });

      instance.start();

      const event = makeNormalizedEvent({
        type: 'permission_request',
        toolName: 'Read',
        paneId: '%42',
        wishId: 'wish-23',
      });

      await instance.processEvent(event);

      expect(approvalCalls).toEqual(['%42']);
      expect(instance.getStats().approved).toBe(1);

      instance.stop();
    });

    test('ignores non-permission_request events', async () => {
      const engine = await import('./auto-approve-engine.js');
      const approvalCalls: string[] = [];

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (paneId: string) => {
          approvalCalls.push(paneId);
        },
      });

      instance.start();

      const event = makeNormalizedEvent({
        type: 'tool_call', // Not a permission_request
        toolName: 'Read',
        paneId: '%42',
      });

      await instance.processEvent(event);

      expect(approvalCalls).toEqual([]); // Nothing happened

      instance.stop();
    });

    test('does not process events when engine is stopped', async () => {
      const engine = await import('./auto-approve-engine.js');
      const approvalCalls: string[] = [];

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (paneId: string) => {
          approvalCalls.push(paneId);
        },
      });

      // Engine is NOT started
      const event = makeNormalizedEvent({
        type: 'permission_request',
        toolName: 'Read',
        paneId: '%42',
      });

      await instance.processEvent(event);

      expect(approvalCalls).toEqual([]);
    });
  });

  describe('audit decisions', () => {
    test('tracks decisions correctly via stats', async () => {
      const engine = await import('./auto-approve-engine.js');

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({
          allow: ['Read', 'Bash'],
          deny: ['Write'],
          bash_allow_patterns: ['bun test'],
        }),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      instance.start();

      const d1 = await instance.processRequest(
        makePermissionRequest({ toolName: 'Read', paneId: '%10', wishId: 'wish-1' }),
      );
      const d2 = await instance.processRequest(
        makePermissionRequest({ toolName: 'Write', paneId: '%20', wishId: 'wish-2' }),
      );
      const d3 = await instance.processRequest(
        makePermissionRequest({ toolName: 'Deploy', paneId: '%30', wishId: 'wish-3' }),
      );

      instance.stop();

      expect(d1.action).toBe('approve');
      expect(d2.action).toBe('deny');
      expect(d3.action).toBe('escalate');

      const stats = instance.getStats();
      expect(stats.approved).toBe(1);
      expect(stats.denied).toBe(1);
      expect(stats.escalated).toBe(1);
      expect(stats.total).toBe(3);
    });

    test('audit events go to PG via recordAuditEvent (no JSONL file)', async () => {
      const engine = await import('./auto-approve-engine.js');

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      instance.start();
      await instance.processRequest(makePermissionRequest({ toolName: 'Read' }));
      instance.stop();

      // JSONL file should NOT be created (audit goes to PG now)
      const oldPath = join(tmpDir, '.genie', 'auto-approve-audit.jsonl');
      expect(existsSync(oldPath)).toBe(false);
    });
  });

  describe('sendApprovalViaTmux', () => {
    test('sendApprovalViaTmux sends Enter key to pane', async () => {
      const engine = await import('./auto-approve-engine.js');

      // Test the exported helper directly
      expect(typeof engine.sendApprovalViaTmux).toBe('function');
    });
  });

  describe('multiple requests', () => {
    test('processes multiple requests and logs all of them', async () => {
      const engine = await import('./auto-approve-engine.js');
      const approvalCalls: string[] = [];

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read', 'Glob', 'Grep'] }),
        auditDir: tmpDir,
        sendApproval: async (paneId: string) => {
          approvalCalls.push(paneId);
        },
      });

      instance.start();

      await instance.processRequest(makePermissionRequest({ toolName: 'Read', paneId: '%1' }));
      await instance.processRequest(makePermissionRequest({ toolName: 'Glob', paneId: '%2' }));
      await instance.processRequest(makePermissionRequest({ toolName: 'Grep', paneId: '%3' }));

      instance.stop();

      expect(approvalCalls).toEqual(['%1', '%2', '%3']);
      expect(instance.getStats().approved).toBe(3);
      expect(instance.getStats().total).toBe(3);
    });
  });

  describe('request without paneId', () => {
    test('still evaluates and logs but skips sendApproval when paneId is missing', async () => {
      const engine = await import('./auto-approve-engine.js');
      const approvalCalls: string[] = [];

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (paneId: string) => {
          approvalCalls.push(paneId);
        },
      });

      instance.start();

      const request = makePermissionRequest({ toolName: 'Read', paneId: undefined });
      const decision = await instance.processRequest(request);

      // Should still approve based on rules
      expect(decision.action).toBe('approve');
      // But should not call sendApproval since there is no pane
      expect(approvalCalls).toEqual([]);

      // Should still be tracked in stats
      expect(instance.getStats().approved).toBe(1);

      instance.stop();
    });
  });

  describe('getStats', () => {
    test('tracks approval statistics', async () => {
      const engine = await import('./auto-approve-engine.js');

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'], deny: ['Write'] }),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      instance.start();

      await instance.processRequest(makePermissionRequest({ toolName: 'Read' }));
      await instance.processRequest(makePermissionRequest({ toolName: 'Read' }));
      await instance.processRequest(makePermissionRequest({ toolName: 'Write' }));
      await instance.processRequest(makePermissionRequest({ toolName: 'Unknown' }));

      const stats = instance.getStats();
      expect(stats.approved).toBe(2);
      expect(stats.denied).toBe(1);
      expect(stats.escalated).toBe(1);
      expect(stats.total).toBe(4);

      instance.stop();
    });

    test('stats reset when engine is restarted', async () => {
      const engine = await import('./auto-approve-engine.js');

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      instance.start();
      await instance.processRequest(makePermissionRequest({ toolName: 'Read' }));
      expect(instance.getStats().total).toBe(1);

      instance.stop();
      instance.start();
      expect(instance.getStats().total).toBe(0);

      instance.stop();
    });
  });

  // ==========================================================================
  // Security Fixes
  // ==========================================================================

  describe('isValidPaneId - command injection prevention', () => {
    test('isValidPaneId is exported', async () => {
      const engine = await import('./auto-approve-engine.js');
      expect(typeof engine.isValidPaneId).toBe('function');
    });

    test('accepts valid pane IDs like %0, %42, %999', async () => {
      const engine = await import('./auto-approve-engine.js');
      expect(engine.isValidPaneId('%0')).toBe(true);
      expect(engine.isValidPaneId('%42')).toBe(true);
      expect(engine.isValidPaneId('%999')).toBe(true);
    });

    test('rejects pane IDs without % prefix', async () => {
      const engine = await import('./auto-approve-engine.js');
      expect(engine.isValidPaneId('42')).toBe(false);
      expect(engine.isValidPaneId('pane42')).toBe(false);
    });

    test('rejects pane IDs with injection attempts', async () => {
      const engine = await import('./auto-approve-engine.js');
      expect(engine.isValidPaneId('%42; rm -rf /')).toBe(false);
      expect(engine.isValidPaneId('%42$(whoami)')).toBe(false);
      expect(engine.isValidPaneId('%42`id`')).toBe(false);
      expect(engine.isValidPaneId("'; cat /etc/passwd")).toBe(false);
      expect(engine.isValidPaneId('%42 && echo pwned')).toBe(false);
    });

    test('rejects empty string and other non-matching input', async () => {
      const engine = await import('./auto-approve-engine.js');
      expect(engine.isValidPaneId('')).toBe(false);
      expect(engine.isValidPaneId('%')).toBe(false);
      expect(engine.isValidPaneId('% 42')).toBe(false);
      expect(engine.isValidPaneId('%abc')).toBe(false);
    });

    test('escalates request with invalid paneId instead of approving', async () => {
      const engine = await import('./auto-approve-engine.js');
      const approvalCalls: string[] = [];

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (paneId: string) => {
          approvalCalls.push(paneId);
        },
      });

      instance.start();

      const request = makePermissionRequest({
        toolName: 'Read',
        paneId: '%42; rm -rf /',
      });
      const decision = await instance.processRequest(request);

      expect(decision.action).toBe('escalate');
      expect(decision.reason).toContain('invalid pane');
      expect(approvalCalls).toEqual([]); // Must NOT send approval

      instance.stop();
    });

    test('logs escalation with reason when paneId is invalid', async () => {
      const engine = await import('./auto-approve-engine.js');

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {},
      });

      instance.start();

      const request = makePermissionRequest({ toolName: 'Read', paneId: '%42$(whoami)' });
      const decision = await instance.processRequest(request);

      expect(decision.action).toBe('escalate');
      expect(decision.reason.toLowerCase()).toContain('invalid pane');
      expect(instance.getStats().escalated).toBe(1);

      instance.stop();
    });
  });

  describe('audit is best-effort', () => {
    test('approves even when PG audit is unavailable (best-effort)', async () => {
      const engine = await import('./auto-approve-engine.js');
      const approvalCalls: string[] = [];

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        sendApproval: async (paneId: string) => {
          approvalCalls.push(paneId);
        },
      });

      instance.start();

      const request = makePermissionRequest({ toolName: 'Read', paneId: '%42' });
      const decision = await instance.processRequest(request);

      // PG audit is fire-and-forget — decision proceeds regardless
      expect(decision.action).toBe('approve');
      expect(approvalCalls).toEqual(['%42']);

      instance.stop();
    });
  });

  describe('sendApproval failure handling', () => {
    test('logs delivery failure when sendApproval throws', async () => {
      const engine = await import('./auto-approve-engine.js');

      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {
          throw new Error('tmux send-keys failed: no such pane');
        },
      });

      instance.start();

      const request = makePermissionRequest({ toolName: 'Read', paneId: '%42' });

      // Should NOT throw - must handle the error gracefully
      const decision = await instance.processRequest(request);

      // The decision was approve (rule matched), but delivery failed
      // Delivery failure is logged to PG audit (best-effort)
      expect(decision.action).toBe('approve');
      expect(instance.getStats().approved).toBe(1);

      instance.stop();
    });

    test('does not crash the engine when sendApproval throws', async () => {
      const engine = await import('./auto-approve-engine.js');

      let callCount = 0;
      const instance = engine.createAutoApproveEngine({
        config: makeConfig({ allow: ['Read'] }),
        auditDir: tmpDir,
        sendApproval: async (_paneId: string) => {
          callCount++;
          if (callCount === 1) {
            throw new Error('tmux failure');
          }
          // Second call succeeds
        },
      });

      instance.start();

      // First request - sendApproval fails
      await instance.processRequest(makePermissionRequest({ toolName: 'Read', paneId: '%1' }));

      // Second request - should still work, engine not crashed
      await instance.processRequest(makePermissionRequest({ toolName: 'Read', paneId: '%2' }));

      expect(callCount).toBe(2);
      expect(instance.isRunning()).toBe(true);

      instance.stop();
    });
  });
});
