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
