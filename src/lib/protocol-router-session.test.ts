/**
 * Protocol Router — Session isolation regressions
 *
 * Verifies that offline recipients in the same session can auto-spawn,
 * while templates from other sessions are ignored.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetProtocolRouterTestDeps, __setProtocolRouterTestDeps, sendMessage } from './protocol-router.js';

const ENV_KEYS = ['GENIE_HOME', 'TMUX', 'TMUX_PANE', 'GENIE_SESSION'] as const;
let savedEnv: Record<string, string | undefined>;
let tempDir: string;

let sessionByCwd = new Map<string, string>();
let directoryResolveResult: { entry: { name: string } } | null = null;
let registryGetResult: any = null;
let registryListResult: any[] = [];
let registryBySession = new Map<string, any[]>();
let templateList: any[] = [];
let alivePanes = new Set<string>();
let spawnCalls: Array<{ resumeSessionId?: string; senderSession?: string }> = [];
let spawnAttempted = false;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'proto-router-session-test-'));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  process.env.GENIE_HOME = join(tempDir, '.genie-home');
  process.env.TMUX = '1';
  process.env.TMUX_PANE = undefined as unknown as string;
  process.env.GENIE_SESSION = undefined as unknown as string;

  sessionByCwd = new Map();
  directoryResolveResult = null;
  registryGetResult = null;
  registryListResult = [];
  registryBySession = new Map();
  templateList = [];
  alivePanes = new Set();
  spawnCalls = [];
  spawnAttempted = false;

  __resetProtocolRouterTestDeps();
  __setProtocolRouterTestDeps({
    registry: {
      get: async () => registryGetResult,
      list: async () => registryListResult,
      filterBySession: async (session: string) => registryBySession.get(session) ?? [],
      unregister: async () => {},
      listTemplates: async () => templateList,
      saveTemplate: async () => {},
    },
    resolveSessionName: async (cwd: string) => sessionByCwd.get(cwd) ?? 'unknown-session',
    resolveDirectory: async () => directoryResolveResult,
    spawnWorkerFromTemplate: async (_template, resumeSessionId, senderSession) => {
      spawnCalls.push({ resumeSessionId, senderSession });
      spawnAttempted = true;

      const worker = {
        ...registryGetResult,
        id: 'implementor-worker-2',
        paneId: '%2',
        state: 'spawning',
      };
      return { worker, paneId: '%2', workerId: worker.id };
    },
    isPaneAlive: async (paneId: string) => alivePanes.has(paneId),
    capturePaneContent: async () => 'idle',
    detectState: (output: string) => ({
      type: 'idle',
      timestamp: Date.now(),
      rawOutput: output,
      confidence: 1,
    }),
    executeTmux: async () => '',
  });
});

afterEach(async () => {
  __resetProtocolRouterTestDeps();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe('sendMessage session isolation', () => {
  test('auto-spawns a suspended worker from the same session', async () => {
    const suspendedWorker = {
      id: 'implementor-worker',
      paneId: '%1',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'suspended',
      lastStateChange: new Date().toISOString(),
      repoPath: '/repo/a',
      claudeSessionId: 'resume-123',
      team: 'alpha',
      role: 'implementor',
      nativeTeamEnabled: false,
    };

    sessionByCwd.set('/repo/a', 'project-a');
    directoryResolveResult = { entry: { name: 'implementor' } };
    registryGetResult = suspendedWorker;
    registryListResult = [suspendedWorker];
    registryBySession.set('project-a', [suspendedWorker]);
    templateList = [
      {
        id: 'implementor',
        provider: 'claude',
        team: 'alpha',
        role: 'implementor',
        cwd: '/repo/a',
        lastSpawnedAt: new Date().toISOString(),
        lastSessionId: 'resume-template',
      },
    ];
    alivePanes.add('%2');

    const result = await sendMessage(tempDir, 'alice', 'implementor', 'hello', undefined, 'project-a');

    expect(result.delivered).toBe(true);
    expect(result.workerId).toBe('implementor-worker-2');
    expect(spawnCalls).toEqual([{ resumeSessionId: 'resume-123', senderSession: 'project-a' }]);
  });

  test('rejects templates from other sessions', async () => {
    directoryResolveResult = { entry: { name: 'implementor' } };
    sessionByCwd.set('/repo/b', 'project-b');
    templateList = [
      {
        id: 'implementor',
        provider: 'claude',
        team: 'alpha',
        role: 'implementor',
        cwd: '/repo/b',
        lastSpawnedAt: new Date().toISOString(),
        lastSessionId: 'resume-template',
      },
    ];

    const result = await sendMessage(tempDir, 'alice', 'implementor', 'hello', undefined, 'project-a');

    expect(result.delivered).toBe(false);
    expect(result.reason).toContain('project-a');
    expect(spawnAttempted).toBe(false);
    expect(spawnCalls).toEqual([]);
  });
});

describe('sendMessage recipient resolution', () => {
  test('delivers to a live worker matched by exact ID', async () => {
    const liveWorker = {
      id: 'worker-abc',
      paneId: '%10',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      team: 'alpha',
      role: 'engineer',
      nativeTeamEnabled: false,
    };

    registryListResult = [liveWorker];
    registryBySession.set('project-a', [liveWorker]);
    alivePanes.add('%10');

    const result = await sendMessage(tempDir, 'alice', 'worker-abc', 'hello', undefined, 'project-a');

    expect(result.delivered).toBe(true);
    expect(result.workerId).toBe('worker-abc');
  });

  test('delivers to a live worker matched by role', async () => {
    const liveWorker = {
      id: 'worker-xyz',
      paneId: '%11',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      team: 'alpha',
      role: 'reviewer',
      nativeTeamEnabled: false,
    };

    registryListResult = [liveWorker];
    registryBySession.set('project-a', [liveWorker]);
    alivePanes.add('%11');

    const result = await sendMessage(tempDir, 'alice', 'reviewer', 'review this', undefined, 'project-a');

    expect(result.delivered).toBe(true);
    expect(result.workerId).toBe('worker-xyz');
  });

  test('delivers to a live worker matched by team:role', async () => {
    const liveWorker = {
      id: 'worker-tr',
      paneId: '%12',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      team: 'beta',
      role: 'qa',
      nativeTeamEnabled: false,
    };

    registryListResult = [liveWorker];
    registryBySession.set('project-a', [liveWorker]);
    alivePanes.add('%12');

    const result = await sendMessage(tempDir, 'alice', 'beta:qa', 'test this', undefined, 'project-a');

    expect(result.delivered).toBe(true);
    expect(result.workerId).toBe('worker-tr');
  });

  test('returns ambiguous error when multiple live workers match', async () => {
    const worker1 = {
      id: 'eng-1',
      paneId: '%20',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      team: 'alpha',
      role: 'engineer',
      nativeTeamEnabled: false,
    };
    const worker2 = {
      id: 'eng-2',
      paneId: '%21',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      team: 'alpha',
      role: 'engineer',
      nativeTeamEnabled: false,
    };

    registryListResult = [worker1, worker2];
    registryBySession.set('project-a', [worker1, worker2]);
    alivePanes.add('%20');
    alivePanes.add('%21');

    const result = await sendMessage(tempDir, 'alice', 'engineer', 'hello', undefined, 'project-a');

    expect(result.delivered).toBe(false);
    expect(result.reason).toContain('ambiguous');
    expect(result.reason).toContain('eng-1');
    expect(result.reason).toContain('eng-2');
  });

  test('suspended workers are not resolved as live recipients', async () => {
    const suspendedWorker = {
      id: 'worker-sus',
      paneId: '%30',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'suspended',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      team: 'alpha',
      role: 'engineer',
      nativeTeamEnabled: false,
    };

    const liveWorker = {
      id: 'worker-live',
      paneId: '%31',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      team: 'alpha',
      role: 'engineer',
      nativeTeamEnabled: false,
    };

    registryListResult = [suspendedWorker, liveWorker];
    registryBySession.set('project-a', [suspendedWorker, liveWorker]);
    alivePanes.add('%30');
    alivePanes.add('%31');

    const result = await sendMessage(tempDir, 'alice', 'engineer', 'hello', undefined, 'project-a');

    // Should deliver to the live worker only, not the suspended one
    expect(result.delivered).toBe(true);
    expect(result.workerId).toBe('worker-live');
  });

  test('falls through to not-found when no match and no session', async () => {
    // No workers, no directory, no templates
    registryListResult = [];
    directoryResolveResult = null;

    const result = await sendMessage(tempDir, 'alice', 'nobody', 'hello');

    expect(result.delivered).toBe(false);
    expect(result.reason).toContain('not found or not alive');
  });

  test('resolves worker candidate by role when registry.get misses', async () => {
    const worker = {
      id: 'worker-role',
      paneId: '%40',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'suspended',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      claudeSessionId: 'session-for-role',
      team: 'alpha',
      role: 'fixer',
      nativeTeamEnabled: false,
    };

    // registry.get returns null (no exact ID match) but list has the worker
    registryGetResult = null;
    registryListResult = [worker];
    registryBySession.set('project-a', [worker]);
    directoryResolveResult = { entry: { name: 'fixer' } };
    sessionByCwd.set(tempDir, 'project-a');
    templateList = [
      {
        id: 'fixer',
        provider: 'claude',
        team: 'alpha',
        role: 'fixer',
        cwd: tempDir,
        lastSpawnedAt: new Date().toISOString(),
        lastSessionId: 'template-session',
      },
    ];
    alivePanes.add('%2'); // The spawned pane

    const result = await sendMessage(tempDir, 'alice', 'fixer', 'fix this', undefined, 'project-a');

    expect(result.delivered).toBe(true);
    // The spawn should use the worker's claudeSessionId for resume
    expect(spawnCalls.length).toBeGreaterThan(0);
    expect(spawnCalls[0]?.resumeSessionId).toBe('session-for-role');
  });

  test('resolves worker candidate by team:role', async () => {
    const worker = {
      id: 'worker-teamrole',
      paneId: '%41',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'suspended',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      claudeSessionId: 'session-teamrole',
      team: 'gamma',
      role: 'docs',
      nativeTeamEnabled: false,
    };

    registryGetResult = null;
    registryListResult = [worker];
    registryBySession.set('project-a', [worker]);
    directoryResolveResult = { entry: { name: 'gamma:docs' } };
    sessionByCwd.set(tempDir, 'project-a');
    templateList = [
      {
        id: 'gamma:docs',
        provider: 'claude',
        team: 'gamma',
        role: 'docs',
        cwd: tempDir,
        lastSpawnedAt: new Date().toISOString(),
      },
    ];
    alivePanes.add('%2');

    const result = await sendMessage(tempDir, 'alice', 'gamma:docs', 'write docs', undefined, 'project-a');

    expect(result.delivered).toBe(true);
  });

  test('scopedTemplates returns all templates when no session', async () => {
    sessionByCwd.set('/repo/a', 'project-a');
    sessionByCwd.set('/repo/b', 'project-b');
    templateList = [
      { id: 't1', provider: 'claude', team: 'a', role: 'eng', cwd: '/repo/a', lastSpawnedAt: '' },
      { id: 't2', provider: 'claude', team: 'b', role: 'qa', cwd: '/repo/b', lastSpawnedAt: '' },
    ];
    directoryResolveResult = { entry: { name: 'eng' } };

    // Without senderSession, both templates should be accessible
    // We verify by checking that the router doesn't reject with "not found in session"
    const result = await sendMessage(tempDir, 'alice', 'unknown-agent', 'hello');

    // Should attempt delivery (even if it fails), not session-reject
    expect(result.reason).not.toContain('not found in session');
  });

  test('findTemplateCandidate matches by role when team matches worker', async () => {
    const worker = {
      id: 'worker-ft',
      paneId: '%50',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      team: 'alpha',
      role: 'reviewer',
      nativeTeamEnabled: false,
    };

    registryGetResult = worker;
    registryListResult = [worker];
    registryBySession.set('project-a', [worker]);
    // Worker pane is dead so it triggers auto-spawn path
    // alivePanes does NOT include '%50'
    sessionByCwd.set(tempDir, 'project-a');
    templateList = [
      {
        id: 'reviewer-tmpl',
        provider: 'claude',
        team: 'alpha',
        role: 'reviewer',
        cwd: tempDir,
        lastSpawnedAt: new Date().toISOString(),
      },
    ];
    alivePanes.add('%2'); // spawned pane

    const result = await sendMessage(tempDir, 'alice', 'reviewer', 'review', undefined, 'project-a');

    expect(result.delivered).toBe(true);
    expect(spawnAttempted).toBe(true);
  });

  test('does not auto-spawn when TMUX is not set', async () => {
    const savedTmux = process.env.TMUX;
    process.env.TMUX = undefined as unknown as string;

    const worker = {
      id: 'worker-notmux',
      paneId: '%60',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'idle',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      team: 'alpha',
      role: 'unique-no-tmux-role',
      nativeTeamEnabled: false,
    };

    registryGetResult = worker;
    registryListResult = [worker];
    registryBySession.set('project-a', [worker]);
    directoryResolveResult = { entry: { name: 'unique-no-tmux-role' } };
    sessionByCwd.set(tempDir, 'project-a');
    templateList = [
      {
        id: 'unique-no-tmux-role',
        provider: 'claude',
        team: 'alpha',
        role: 'unique-no-tmux-role',
        cwd: tempDir,
        lastSpawnedAt: new Date().toISOString(),
      },
    ];

    await sendMessage(tempDir, 'alice', 'unique-no-tmux-role', 'hello', undefined, 'project-a');

    // Auto-spawn should not be attempted without TMUX
    expect(spawnAttempted).toBe(false);

    process.env.TMUX = savedTmux;
  });

  test('ensureWorkerAlive returns null when spawned pane dies immediately', async () => {
    const worker = {
      id: 'worker-die',
      paneId: '%70',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'suspended',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      claudeSessionId: 'resume-die',
      team: 'alpha',
      role: 'unstable',
      nativeTeamEnabled: false,
    };

    registryGetResult = worker;
    registryListResult = [worker];
    registryBySession.set('project-a', [worker]);
    directoryResolveResult = { entry: { name: 'unstable' } };
    sessionByCwd.set(tempDir, 'project-a');
    templateList = [
      {
        id: 'unstable',
        provider: 'claude',
        team: 'alpha',
        role: 'unstable',
        cwd: tempDir,
        lastSpawnedAt: new Date().toISOString(),
      },
    ];
    // Spawned pane %2 is NOT alive → simulates immediate death
    // alivePanes stays empty

    const result = await sendMessage(tempDir, 'alice', 'unstable', 'hello', undefined, 'project-a');

    expect(result.delivered).toBe(false);
    expect(spawnAttempted).toBe(true);
  });

  test('uses template lastSessionId when worker has no claudeSessionId', async () => {
    const worker = {
      id: 'worker-noid',
      paneId: '%80',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'suspended',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      // No claudeSessionId
      team: 'alpha',
      role: 'engineer',
      nativeTeamEnabled: false,
    };

    registryGetResult = worker;
    registryListResult = [worker];
    registryBySession.set('project-a', [worker]);
    directoryResolveResult = { entry: { name: 'engineer' } };
    sessionByCwd.set(tempDir, 'project-a');
    templateList = [
      {
        id: 'engineer',
        provider: 'claude',
        team: 'alpha',
        role: 'engineer',
        cwd: tempDir,
        lastSpawnedAt: new Date().toISOString(),
        lastSessionId: 'template-session-123',
      },
    ];
    alivePanes.add('%2');

    const result = await sendMessage(tempDir, 'alice', 'engineer', 'hello', undefined, 'project-a');

    expect(result.delivered).toBe(true);
    expect(spawnCalls[0]?.resumeSessionId).toBe('template-session-123');
  });

  test('codex provider template does not pass resumeSessionId', async () => {
    const worker = {
      id: 'codex-worker',
      paneId: '%90',
      session: 'project-a',
      worktree: null,
      startedAt: new Date().toISOString(),
      state: 'suspended',
      lastStateChange: new Date().toISOString(),
      repoPath: tempDir,
      claudeSessionId: 'should-not-use',
      team: 'alpha',
      role: 'codex-eng',
      nativeTeamEnabled: false,
    };

    registryGetResult = worker;
    registryListResult = [worker];
    registryBySession.set('project-a', [worker]);
    directoryResolveResult = { entry: { name: 'codex-eng' } };
    sessionByCwd.set(tempDir, 'project-a');
    templateList = [
      {
        id: 'codex-eng',
        provider: 'codex',
        team: 'alpha',
        role: 'codex-eng',
        cwd: tempDir,
        lastSpawnedAt: new Date().toISOString(),
        lastSessionId: 'some-session',
      },
    ];
    alivePanes.add('%2');

    const result = await sendMessage(tempDir, 'alice', 'codex-eng', 'hello', undefined, 'project-a');

    expect(result.delivered).toBe(true);
    // Codex provider should not pass resume session ID
    expect(spawnCalls[0]?.resumeSessionId).toBeUndefined();
  });
});
