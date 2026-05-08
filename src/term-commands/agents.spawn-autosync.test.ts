/**
 * Spawn auto-sync tests for resolveAgentForSpawn.
 *
 * Run with: bun test src/term-commands/agents.spawn-autosync.test.ts
 */

import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DirectoryEntry } from '../lib/agent-directory.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import type { SpawnOptions } from './agents.js';

type AgentsModule = typeof import('./agents.js');
type ResolvedAgent = { entry: DirectoryEntry; builtin: boolean };

const directoryRows = new Map<string, DirectoryEntry>();
const syncCalls: Array<{ root: string; name: string }> = [];

describe('spawn auto-sync', () => {
  let agents: AgentsModule;
  let originalDeps: AgentsModule['_spawnAutoSyncDeps'];
  let originalCwd: string;
  let originalGenieHome: string | undefined;
  let originalDisableAutoSync: string | undefined;
  let tempRoots: string[] = [];

  beforeAll(async () => {
    agents = await import('./agents.js');
    originalDeps = { ...agents._spawnAutoSyncDeps };
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    originalGenieHome = process.env.GENIE_HOME;
    originalDisableAutoSync = process.env.GENIE_DISABLE_AUTO_SYNC;
    tempRoots = [];
    directoryRows.clear();
    syncCalls.length = 0;
    Object.assign(agents._spawnAutoSyncDeps, {
      resolveAgent: fakeResolveAgent,
      loadIdentity: fakeLoadIdentity,
      syncSingleAgentByName: fakeSyncSingleAgentByName,
    });

    const genieHome = mkdtempSync(join(tmpdir(), 'genie-spawn-autosync-home-'));
    tempRoots.push(genieHome);
    process.env.GENIE_HOME = genieHome;
    Reflect.deleteProperty(process.env, 'GENIE_DISABLE_AUTO_SYNC');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    Object.assign(agents._spawnAutoSyncDeps, originalDeps);
    restoreEnv('GENIE_HOME', originalGenieHome);
    restoreEnv('GENIE_DISABLE_AUTO_SYNC', originalDisableAutoSync);

    for (const root of tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('auto-registers a valid unsynced on-disk agent on first spawn resolution', async () => {
    const name = 'autosync-happy';
    const { agentDir, workspaceRoot } = createWorkspaceAgent(name, validFrontmatter(name));

    const { result, errors } = await captureConsoleError(() => agents.resolveAgentForSpawn(name, {}));

    expect(result.entry.name).toBe(name);
    expect(result.entry.dir).toBe(agentDir);
    expect(result.identityPath).toBe(join(agentDir, 'AGENTS.md'));
    expect(errors).toEqual([`Auto-registered agent '${name}' from ${agentDir}`]);
    expect([...directoryRows.keys()]).toEqual([name]);
    expect(directoryRows.get(name)?.description).toBe('Spawnable test agent');
    expect(syncCalls).toEqual([{ root: workspaceRoot, name }]);
  });

  test('second spawn resolution is idempotent and does not log auto-register again', async () => {
    const name = 'autosync-repeat';
    const { agentDir, workspaceRoot } = createWorkspaceAgent(name, validFrontmatter(name));

    const first = await captureConsoleError(() => agents.resolveAgentForSpawn(name, {}));
    expect(first.errors).toEqual([`Auto-registered agent '${name}' from ${agentDir}`]);

    const second = await captureConsoleError(() => agents.resolveAgentForSpawn(name, {}));
    expect(second.result.entry.name).toBe(name);
    expect(second.errors).toEqual([]);
    expect([...directoryRows.keys()]).toEqual([name]);
    expect(syncCalls).toEqual([{ root: workspaceRoot, name }]);
  });

  test('missing workspace preserves not-found behavior and creates no row', async () => {
    const name = 'autosync-no-workspace';
    createAgentWithoutWorkspace(name, validFrontmatter(name));

    await expectResolveNotFound(name, {});

    expect([...directoryRows.keys()]).toEqual([]);
    expect(syncCalls).toEqual([]);
  });

  test('invalid frontmatter preserves not-found behavior and creates no row', async () => {
    const mismatch = 'autosync-name-mismatch';
    createWorkspaceAgent(
      mismatch,
      `---
name: different-agent
description: Spawnable test agent
---`,
    );

    await expectResolveNotFound(mismatch, {});
    expect([...directoryRows.keys()]).toEqual([]);
    expect(syncCalls).toEqual([]);

    const emptyDescription = 'autosync-empty-description';
    createWorkspaceAgent(
      emptyDescription,
      `---
name: ${emptyDescription}
description: "   "
---`,
    );

    await expectResolveNotFound(emptyDescription, {});
    expect([...directoryRows.keys()]).toEqual([]);
    expect(syncCalls).toEqual([]);
  });

  test('GENIE_DISABLE_AUTO_SYNC=1 prevents auto-register', async () => {
    const name = 'autosync-env-disabled';
    createWorkspaceAgent(name, validFrontmatter(name));
    process.env.GENIE_DISABLE_AUTO_SYNC = '1';

    await expectResolveNotFound(name, {});

    expect([...directoryRows.keys()]).toEqual([]);
    expect(syncCalls).toEqual([]);
  });

  test('--no-auto-sync prevents auto-register', async () => {
    const name = 'autosync-flag-disabled';
    createWorkspaceAgent(name, validFrontmatter(name));

    await expectResolveNotFound(name, { noAutoSync: true });

    expect([...directoryRows.keys()]).toEqual([]);
    expect(syncCalls).toEqual([]);
  });

  function createWorkspaceAgent(name: string, frontmatter: string): { workspaceRoot: string; agentDir: string } {
    const workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), 'genie-spawn-autosync-workspace-')));
    tempRoots.push(workspaceRoot);

    mkdirSync(join(workspaceRoot, '.genie'), { recursive: true });
    writeFileSync(join(workspaceRoot, '.genie', 'workspace.json'), JSON.stringify({ name: 'autosync-test' }));

    const agentDir = join(workspaceRoot, 'agents', name);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'AGENTS.md'), `${frontmatter}\n# ${name}\n`, 'utf-8');

    process.chdir(workspaceRoot);
    return { workspaceRoot, agentDir };
  }

  function createAgentWithoutWorkspace(name: string, frontmatter: string): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'genie-spawn-autosync-no-workspace-')));
    tempRoots.push(root);

    const agentDir = join(root, 'agents', name);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'AGENTS.md'), `${frontmatter}\n# ${name}\n`, 'utf-8');

    process.chdir(root);
    return agentDir;
  }

  function validFrontmatter(name: string): string {
    return `---
name: ${name}
description: Spawnable test agent
---`;
  }

  async function fakeResolveAgent(name: string): Promise<ResolvedAgent | null> {
    const entry = directoryRows.get(name);
    return entry ? { entry, builtin: false } : null;
  }

  function fakeLoadIdentity(entry: DirectoryEntry): string | null {
    const agentsMd = join(entry.dir, 'AGENTS.md');
    return existsSync(agentsMd) ? agentsMd : null;
  }

  async function fakeSyncSingleAgentByName(root: string, name: string): Promise<string> {
    syncCalls.push({ root, name });

    const agentDir = join(root, 'agents', name);
    const agentsMd = join(agentDir, 'AGENTS.md');
    if (!existsSync(agentsMd)) return 'not-found';

    const existed = directoryRows.has(name);
    const frontmatter = parseFrontmatter(readFileSync(agentsMd, 'utf-8'));
    directoryRows.set(name, {
      name,
      dir: agentDir,
      promptMode: 'append',
      registeredAt: 'test',
      description: frontmatter.description,
    });
    return existed ? 'updated' : 'registered';
  }

  async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; errors: string[] }> {
    const errors: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });

    try {
      const result = await fn();
      return { result, errors };
    } finally {
      errorSpy.mockRestore();
    }
  }

  async function expectResolveNotFound(name: string, options: SpawnOptions): Promise<void> {
    const errors: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    const exitSpy = spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new Error(`process.exit:${code}`);
    });

    try {
      try {
        await agents.resolveAgentForSpawn(name, options);
        expect.unreachable('resolveAgentForSpawn should exit for an unknown agent');
      } catch (err) {
        expect((err as Error).message).toBe('process.exit:1');
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errors).toEqual([
        `Error: Agent "${name}" not found in directory or built-ins.`,
        `  Register with: genie dir add ${name} --dir <path>`,
        '  Or use a built-in: engineer, reviewer, qa, fix, ...',
      ]);
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  }

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
});
