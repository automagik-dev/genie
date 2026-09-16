import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { OrcaOperation, OrcaOrchestrationAdapter } from '../../src/lib/orca-orchestration-adapter';
import { ORCA_MINIMUM_RUNTIME_VERSION, createOrcaPluginRuntime } from './orca-runtime';

const response = (runtimeVersion = ORCA_MINIMUM_RUNTIME_VERSION) => ({
  id: 'response_1',
  ok: true as const,
  result: { runs: [] },
  _meta: { runtimeId: 'runtime_1', runtimeVersion },
});

const status = (
  runtimeVersion = ORCA_MINIMUM_RUNTIME_VERSION,
  capabilities: string[] = ['orchestration.contract.v1'],
) => ({
  id: 'local-status',
  ok: true as const,
  result: {
    target: { kind: 'local' as const },
    app: { running: true as const, pid: 123, desktopWindowStatus: 'available' as const },
    runtime: {
      state: 'ready' as const,
      reachable: true as const,
      runtimeId: 'runtime_1',
      appVersion: runtimeVersion,
      remoteUpdateSupport: { installMode: 'manual', automatic: false, reason: 'manual-update' },
      capabilities,
    },
    graph: { state: 'ready' as const },
  },
  _meta: { runtimeId: 'runtime_1' },
});

describe('native Orca plugin contract', () => {
  test('discovers, loads, and invokes the public adapter through the native Orca entrypoint', async () => {
    const manifest = JSON.parse(await readFile(resolve(import.meta.dir, 'orca-plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      id: 'genie',
      publisher: 'automagik',
      engines: { orca: `>=${ORCA_MINIMUM_RUNTIME_VERSION}` },
      pluginApi: 1,
      main: 'orca-entrypoint.min.js',
      contributes: {
        commands: [{ id: 'genie.orca.run-list', title: 'Genie: List Orca Runs' }],
      },
      capabilities: [],
    });

    const entrypoint = await import(resolve(import.meta.dir, manifest.main));
    expect(entrypoint.default).toBeFunction();
    expect(entrypoint.createOrcaPluginEntrypoint).toBeFunction();

    const calls: OrcaOperation[] = [];
    const handlers = new Map<string, (args?: unknown) => Promise<unknown>>();
    const adapter: OrcaOrchestrationAdapter = {
      executable: 'opaque-to-plugin',
      status: async () => status(),
      execute: async (operation) => {
        calls.push(operation as OrcaOperation);
        return response();
      },
    };
    await entrypoint.createOrcaPluginEntrypoint(adapter)({
      commands: { register: (id: string, handler: (args?: unknown) => Promise<unknown>) => handlers.set(id, handler) },
    });

    expect(await handlers.get('genie.orca.run-list')?.()).toEqual(response());
    expect(calls).toEqual([{ operation: 'run-list', limit: 100 }]);
  });

  test('probes with one read-only public adapter call before allowing operations', async () => {
    const calls: OrcaOperation[] = [];
    const adapter: OrcaOrchestrationAdapter = {
      executable: 'opaque-to-plugin',
      status: async () => status(),
      execute: async (operation) => {
        calls.push(operation as OrcaOperation);
        return response();
      },
    };
    const runtime = createOrcaPluginRuntime(adapter);

    expect(await runtime.probe()).toEqual({
      runtimeId: 'runtime_1',
      runtimeVersion: ORCA_MINIMUM_RUNTIME_VERSION,
      contract: 'orchestration.contract.v1',
    });
    expect(calls).toEqual([]);
  });

  test('converts status, version, and capability failures to unsupported_environment and never mutates', async () => {
    for (const failure of [new Error('spawn denied'), status('1.3.999'), status(undefined, [])]) {
      const calls: OrcaOperation[] = [];
      const adapter: OrcaOrchestrationAdapter = {
        executable: 'opaque-to-plugin',
        status: async () => {
          if (failure instanceof Error) throw failure;
          return failure;
        },
        execute: async (operation) => {
          calls.push(operation as OrcaOperation);
          return response();
        },
      };

      await expect(createOrcaPluginRuntime(adapter).probe()).rejects.toMatchObject({
        code: 'unsupported_environment',
        operation: 'runtime',
        phase: 'resolve',
        retrySafety: 'safe',
      });
      expect(calls).toEqual([]);
    }
  });

  // A prerelease of the minimum is NOT the minimum. The version gate dropped the
  // `-rc.1` suffix, so `1.4.192-rc.1` compared equal to the released `1.4.192`
  // and satisfied `>=1.4.192` — the plugin then ran against a runtime whose
  // orchestration contract is still in flux.
  test('rejects a prerelease of the minimum runtime version and accepts real successors', async () => {
    const accepted = [
      ORCA_MINIMUM_RUNTIME_VERSION,
      '1.4.193',
      '1.5.0',
      '2.0.0',
      '1.4.193-rc.1',
      `${ORCA_MINIMUM_RUNTIME_VERSION}+build.7`,
    ];
    const rejected = [
      '1.4.192-rc.1',
      '1.4.192-0',
      '1.4.192-alpha',
      '1.4.191',
      '1.3.999',
      '0.9.9',
      'not-a-version',
      '1.4',
    ];
    const probeWith = async (runtimeVersion: string) => {
      const adapter: OrcaOrchestrationAdapter = {
        executable: 'opaque-to-plugin',
        status: async () => status(runtimeVersion),
        execute: async () => response(),
      };
      return createOrcaPluginRuntime(adapter).probe();
    };
    for (const runtimeVersion of accepted) {
      expect(await probeWith(runtimeVersion), runtimeVersion).toMatchObject({ runtimeVersion });
    }
    for (const runtimeVersion of rejected) {
      await expect(probeWith(runtimeVersion), runtimeVersion).rejects.toMatchObject({
        code: 'unsupported_environment',
      });
    }
  });

  test('does not expose stores, fallback, argv, shells, dispatch injection, or executable selection', async () => {
    const source = await readFile(resolve(import.meta.dir, 'orca-runtime.ts'), 'utf8');
    for (const forbidden of [
      'node:child_process',
      'shell:',
      'Database',
      'dispatch --inject',
      'terminal send',
      'execPath',
      'executable:',
      'fallback',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
