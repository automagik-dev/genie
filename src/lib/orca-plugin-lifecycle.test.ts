import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOrcaLifecycle } from '../genie-commands/doctor.js';
import { setupCommand } from '../genie-commands/setup.js';
import {
  inspectOrcaPluginLifecycle,
  refreshOwnedOrcaPluginMetadata,
  switchOrchestrationMode,
  uninstallOwnedOrcaPluginMetadata,
} from './orca-plugin-lifecycle.js';

let home: string;
let previousHome: string | undefined;

function writePayload(manifest = '{"version":"1"}', entrypoint = 'export default {}') {
  const root = join(home, 'plugins', 'genie');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'orca-plugin.json'), manifest);
  writeFileSync(join(root, 'orca-entrypoint.min.js'), entrypoint);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'genie-orca-lifecycle-'));
  previousHome = process.env.GENIE_HOME;
  process.env.GENIE_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) process.env.GENIE_HOME = undefined;
  else process.env.GENIE_HOME = previousHome;
});

describe('Orca plugin lifecycle transitions', () => {
  test('switches to Orca only after the public compatibility probe and preserves unrelated config', async () => {
    writePayload();
    writeFileSync(join(home, 'config.json'), '{\n  "custom": {"kept": true}\n}\n');
    let probed = false;

    const result = await switchOrchestrationMode('orca', {
      probe: async () => {
        probed = true;
        return { runtimeId: 'runtime_1', runtimeVersion: '1.4.193', contract: 'orchestration.contract.v1' };
      },
    });

    expect(probed).toBe(true);
    expect(result.changed).toBe(true);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toMatchObject({
      custom: { kept: true },
      orchestration: { mode: 'orca' },
    });
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(inspectOrcaPluginLifecycle()).toMatchObject({ payload: 'owned-clean', mode: 'orca' });
  });

  test('probe failure preserves exact config bytes and creates no ownership claim', async () => {
    writePayload();
    const original = '{\n  "custom": true\n}\n';
    writeFileSync(join(home, 'config.json'), original);

    await expect(
      switchOrchestrationMode('orca', {
        probe: async () => {
          throw new Error('incompatible');
        },
      }),
    ).rejects.toThrow('incompatible');

    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(original);
    expect(inspectOrcaPluginLifecycle().payload).toBe('unmanaged');
  });

  for (const boundary of ['afterBackup', 'afterOwnership', 'beforeConfigCommit'] as const) {
    test(`failure at ${boundary} restores config and ownership exactly`, async () => {
      writePayload();
      const original = '{\n  "custom": "preserved"\n}\n';
      writeFileSync(join(home, 'config.json'), original);

      await expect(
        switchOrchestrationMode('orca', {
          probe: async () => ({
            runtimeId: 'runtime_1',
            runtimeVersion: '1.4.193',
            contract: 'orchestration.contract.v1',
          }),
          hooks: {
            [boundary]: () => {
              throw new Error(`failed at ${boundary}`);
            },
          },
        }),
      ).rejects.toThrow(`failed at ${boundary}`);
      expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe(original);
      expect(inspectOrcaPluginLifecycle().payload).toBe('unmanaged');
    });
  }

  test('repeat transitions are idempotent and standalone never probes or rewrites lifecycle history', async () => {
    writePayload();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ orchestration: { mode: 'standalone' } }));
    writeFileSync(join(home, 'genie.db'), 'database-history');
    let probes = 0;
    const deps = {
      probe: async () => {
        probes += 1;
        return { runtimeId: 'runtime_1', runtimeVersion: '1.4.193', contract: 'orchestration.contract.v1' as const };
      },
    };

    expect((await switchOrchestrationMode('orca', deps)).changed).toBe(true);
    expect((await switchOrchestrationMode('orca', deps)).changed).toBe(false);
    expect((await switchOrchestrationMode('standalone', deps)).changed).toBe(true);
    expect((await switchOrchestrationMode('standalone', deps)).changed).toBe(false);
    expect(probes).toBe(1);
    expect(readFileSync(join(home, 'genie.db'), 'utf8')).toBe('database-history');
  });

  test('uninstall removes only a clean Genie ownership marker and never payload or history', async () => {
    writePayload();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ orchestration: { mode: 'standalone' } }));
    writeFileSync(join(home, 'roadmap.json'), 'history');
    await switchOrchestrationMode('orca', {
      probe: async () => ({
        runtimeId: 'runtime_1',
        runtimeVersion: '1.4.193',
        contract: 'orchestration.contract.v1',
      }),
    });

    expect(uninstallOwnedOrcaPluginMetadata()).toBe('removed');
    expect(existsSync(join(home, 'plugins', 'genie', 'orca-plugin.json'))).toBe(true);
    expect(readFileSync(join(home, 'roadmap.json'), 'utf8')).toBe('history');
    expect(uninstallOwnedOrcaPluginMetadata()).toBe('absent');
  });

  test('update refreshes only an existing ownership claim after compatibility succeeds', async () => {
    writePayload();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ orchestration: { mode: 'standalone' } }));
    const compatible = async () => ({
      runtimeId: 'runtime_1',
      runtimeVersion: '1.4.193',
      contract: 'orchestration.contract.v1' as const,
    });
    await switchOrchestrationMode('orca', { probe: compatible });
    const markerPath = join(home, 'plugins', 'genie', '.orca-plugin-ownership.json');
    const previousMarker = readFileSync(markerPath, 'utf8');
    writeFileSync(join(home, 'plugins', 'genie', 'orca-entrypoint.min.js'), 'updated');

    await expect(
      refreshOwnedOrcaPluginMetadata(async () => {
        throw new Error('unsupported update payload');
      }),
    ).rejects.toThrow('unsupported update payload');
    expect(readFileSync(markerPath, 'utf8')).toBe(previousMarker);
    expect(await refreshOwnedOrcaPluginMetadata(compatible)).toBe('refreshed');
    expect(inspectOrcaPluginLifecycle().payload).toBe('owned-clean');
  });

  test('setup mode surface reports success, idempotency, and error exit/stderr', async () => {
    writePayload();
    const output: string[] = [];
    const errors: string[] = [];
    const priorLog = console.log;
    const priorError = console.error;
    const priorExit = process.exitCode;
    console.log = (...args) => output.push(args.join(' '));
    console.error = (...args) => errors.push(args.join(' '));
    process.exitCode = 0;
    try {
      const probe = async () => ({
        runtimeId: 'runtime_1',
        runtimeVersion: '1.4.193',
        contract: 'orchestration.contract.v1' as const,
      });
      await setupCommand({ orchestrationMode: 'orca' }, { orcaCompatibilityProbe: probe });
      await setupCommand({ orchestrationMode: 'orca' }, { orcaCompatibilityProbe: probe });
      expect(output.join('\n')).toContain('Orchestration mode changed: orca');
      expect(output.join('\n')).toContain('Orchestration mode already selected: orca');
      expect(process.exitCode).toBe(0);

      await setupCommand({ orchestrationMode: 'automatic' as never });
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('orchestration mode must be either');
    } finally {
      console.log = priorLog;
      console.error = priorError;
      process.exitCode = priorExit;
    }
  });

  test('doctor truthfully reports selected mode, compatibility, and unmanaged host registration', async () => {
    writePayload();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ orchestration: { mode: 'standalone' } }));
    const probe = async () => ({
      runtimeId: 'runtime_1',
      runtimeVersion: '1.4.193',
      contract: 'orchestration.contract.v1' as const,
    });
    await switchOrchestrationMode('orca', { probe });

    const checks = await checkOrcaLifecycle({ orcaCompatibilityProbe: probe });
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ status: 'pass' });
    expect(checks[0]?.detail).toContain('mode=orca');
    expect(checks[0]?.detail).toContain('host_registration=not-managed');
    expect(checks[1]?.detail).toContain('runtime=1.4.193');
  });
});
