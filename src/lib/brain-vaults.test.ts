import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BrainServerApi,
  type BrainVaultResolution,
  findBrainVault,
  resolveBrainVaults,
  startResolvedBrainVaults,
} from './brain-vaults.js';

let testDir: string;
let homeDir: string;
let warn: ReturnType<typeof mock>;
let log: ReturnType<typeof mock>;

function makeVault(name: string, brainJson = '{}'): string {
  const path = join(testDir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'brain.json'), brainJson, 'utf-8');
  return path;
}

function makeDir(name: string): string {
  const path = join(testDir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function deps(overrides: Parameters<typeof resolveBrainVaults>[0] = {}): Parameters<typeof resolveBrainVaults>[0] {
  return {
    cwd: testDir,
    homeDir,
    workspaceRoot: null,
    warn,
    log,
    ...overrides,
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `genie-brain-vaults-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  homeDir = join(testDir, 'home');
  mkdirSync(homeDir, { recursive: true });
  warn = mock(() => {});
  log = mock(() => {});
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('resolveBrainVaults', () => {
  test('uses explicit brain.paths and does not consult registry', async () => {
    const first = makeVault('first');
    const second = makeVault('second');
    const listBrains = mock(async () => [{ homePath: makeVault('registered') }]);

    const result = await resolveBrainVaults(
      deps({
        config: { brain: { embedded: true, paths: [first, second] } },
        brain: { listBrains },
      }),
    );

    expect(result).toEqual({ source: 'config', paths: [first, second] });
    expect(listBrains.mock.calls.length).toBe(0);
    expect(warn.mock.calls.length).toBe(0);
  });

  test('warns and filters configured vaults missing brain.json without consulting registry', async () => {
    const missingBrainJson = makeDir('configured-missing');
    const listBrains = mock(async () => [{ homePath: makeVault('registered') }]);

    const result = await resolveBrainVaults(
      deps({
        config: { brain: { embedded: true, paths: [missingBrainJson] } },
        brain: { listBrains },
      }),
    );

    expect(result).toEqual({ source: 'config', paths: [] });
    expect(listBrains.mock.calls.length).toBe(0);
    expect(warn.mock.calls.length).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`skipped configured vault ${missingBrainJson}`);
    expect(String(warn.mock.calls[0]?.[0])).toContain('missing brain.json');
  });

  test('treats brain.paths: [] as registry discovery mode', async () => {
    const registered = makeVault('registered');
    const workspaceRoot = makeDir('workspace');
    mkdirSync(join(workspaceRoot, 'brain'), { recursive: true });
    writeFileSync(join(workspaceRoot, 'brain', 'brain.json'), '{}', 'utf-8');

    const result = await resolveBrainVaults(
      deps({
        config: { brain: { embedded: true, paths: [] } },
        workspaceRoot,
        brain: { listBrains: mock(async () => [{ homePath: registered }]) },
      }),
    );

    expect(result).toEqual({ source: 'registry', paths: [registered], registryCount: 1 });
  });

  test('discovers multiple registered brain vaults', async () => {
    const first = makeVault('registered-a');
    const second = makeVault('registered-b');

    const result = await resolveBrainVaults(
      deps({
        config: { brain: { embedded: true } },
        brain: {
          listBrains: mock(async () => [
            { id: 'a', homePath: first },
            { id: 'b', brainPath: second },
          ]),
        },
      }),
    );

    expect(result).toEqual({ source: 'registry', paths: [first, second], registryCount: 2 });
  });

  test('falls back to the legacy workspace brain when registry is empty', async () => {
    const workspaceRoot = makeDir('workspace');
    const legacy = join(workspaceRoot, 'brain');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'brain.json'), '{}', 'utf-8');

    const result = await resolveBrainVaults(
      deps({
        config: { brain: { embedded: true } },
        workspaceRoot,
        brain: { listBrains: mock(async () => []) },
      }),
    );

    expect(result).toEqual({ source: 'legacy', paths: [legacy] });
  });

  test('warns and filters registered vaults missing brain.json', async () => {
    const valid = makeVault('valid');
    const missingBrainJson = makeDir('missing');

    const result = await resolveBrainVaults(
      deps({
        config: { brain: { embedded: true } },
        brain: {
          listBrains: mock(async () => [
            { id: 'valid', homePath: valid },
            { id: 'missing', homePath: missingBrainJson },
          ]),
        },
      }),
    );

    expect(result).toEqual({ source: 'registry', paths: [valid], registryCount: 2 });
    expect(warn.mock.calls.length).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(`skipped registered vault ${missingBrainJson}`);
    expect(String(warn.mock.calls[0]?.[0])).toContain('missing brain.json');
  });
});

describe('findBrainVault', () => {
  test('returns the first configured valid vault without consulting registry', async () => {
    const first = makeVault('configured-a');
    const second = makeVault('configured-b');
    const listBrains = mock(async () => [{ homePath: makeVault('registered') }]);

    const result = await findBrainVault(
      deps({
        config: { brain: { embedded: true, paths: [first, second] } },
        brain: { listBrains },
      }),
    );

    expect(result).toBe(first);
    expect(listBrains.mock.calls.length).toBe(0);
  });

  test('returns a registered vault before legacy fallback candidates', async () => {
    const registered = makeVault('registered');
    const workspaceRoot = makeDir('workspace');
    const legacy = join(workspaceRoot, 'brain');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'brain.json'), '{}', 'utf-8');

    const result = await findBrainVault(
      deps({
        config: { brain: { embedded: true } },
        workspaceRoot,
        brain: { listBrains: mock(async () => [{ homePath: registered }]) },
      }),
    );

    expect(result).toBe(registered);
  });

  test('falls back to the legacy workspace brain when registry is empty', async () => {
    const workspaceRoot = makeDir('workspace');
    const legacy = join(workspaceRoot, 'brain');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'brain.json'), '{}', 'utf-8');

    const result = await findBrainVault(
      deps({
        config: { brain: { embedded: true } },
        workspaceRoot,
        brain: { listBrains: mock(async () => []) },
      }),
    );

    expect(result).toBe(legacy);
  });
});

describe('startResolvedBrainVaults', () => {
  test('continues starting valid configured vaults after one brain.json is invalid', async () => {
    const corrupt = makeVault('corrupt', '{not-json');
    const valid = makeVault('valid');
    const stop = mock(async () => {});
    const startEmbeddedBrainServer = mock(async ({ brainPath }: { brainPath: string }) => {
      if (brainPath === corrupt) throw new Error('invalid brain.json');
      return { port: 4401, stop };
    });
    const brain: BrainServerApi = {
      startEmbeddedBrainServer,
    };

    const result = await startResolvedBrainVaults({ source: 'config', paths: [corrupt, valid] }, brain, 19642, deps());

    expect(startEmbeddedBrainServer.mock.calls.length).toBe(2);
    expect(result.map((handle) => handle.brainPath)).toEqual([valid]);
    expect(warn.mock.calls.length).toBe(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('invalid brain.json');
  });

  test('starts every unique resolved vault once for multi-vault autostart', async () => {
    const first = makeVault('first');
    const second = makeVault('second');
    const stop = mock(async () => {});
    const started: string[] = [];
    const startEmbeddedBrainServer = mock(async ({ brainPath }: { brainPath: string }) => {
      started.push(brainPath);
      return { port: 4500 + started.length, stop };
    });
    const brain: BrainServerApi = {
      startEmbeddedBrainServer,
    };
    const resolution: BrainVaultResolution = { source: 'registry', paths: [first, second, first] };

    const result = await startResolvedBrainVaults(resolution, brain, 19642, deps());

    expect(started).toEqual([first, second]);
    expect(result.map((handle) => handle.brainPath)).toEqual([first, second]);
    expect(startEmbeddedBrainServer.mock.calls.length).toBe(2);
  });

  test('starts resolved vaults with bounded parallelism when an earlier vault is pending', async () => {
    const first = makeVault('first');
    const second = makeVault('second');
    const third = makeVault('third');
    const stop = mock(async () => {});
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const ports = new Map([
      [first, 4601],
      [second, 4602],
      [third, 4603],
    ]);
    const startEmbeddedBrainServer = mock(({ brainPath }: { brainPath: string }) => {
      started.push(brainPath);
      if (brainPath === third) {
        return Promise.resolve({ port: ports.get(brainPath) ?? 4603, stop });
      }
      return new Promise<{ port: number; stop: () => Promise<void> }>((resolve) => {
        release.set(brainPath, () => resolve({ port: ports.get(brainPath) ?? 4600, stop }));
      });
    });
    const brain: BrainServerApi = {
      startEmbeddedBrainServer,
    };

    const pending = startResolvedBrainVaults(
      { source: 'config', paths: [first, second, third] },
      brain,
      19642,
      deps({ startupConcurrency: 2 }),
    );

    await Promise.resolve();
    expect(started).toEqual([first, second]);
    expect(startEmbeddedBrainServer.mock.calls.length).toBe(2);

    release.get(second)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([first, second, third]);

    release.get(first)?.();
    const result = await pending;
    expect(result.map((handle) => handle.brainPath)).toEqual([first, second, third]);
  });

  test('warns when registry starts fewer vaults than the registry reports', async () => {
    const valid = makeVault('valid');
    const stop = mock(async () => {});
    const startEmbeddedBrainServer = mock(async () => ({ port: 4701, stop }));
    const brain: BrainServerApi = {
      startEmbeddedBrainServer,
    };

    const result = await startResolvedBrainVaults(
      { source: 'registry', paths: [valid], registryCount: 2 },
      brain,
      19642,
      deps(),
    );

    expect(result.map((handle) => handle.brainPath)).toEqual([valid]);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('registry drift: started 1/2'))).toBe(true);
  });
});
