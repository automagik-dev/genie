import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { OrcaOperation, OrcaOrchestrationAdapter } from '../../src/lib/orca-orchestration-adapter';
import { ORCA_AGENT_PLUGIN_SCHEMA, ORCA_MINIMUM_RUNTIME_VERSION, createOrcaPluginRuntime } from './orca-runtime';

const response = (runtimeVersion = ORCA_MINIMUM_RUNTIME_VERSION) => ({
  id: 'response_1',
  ok: true as const,
  result: { runs: [] },
  _meta: { runtimeId: 'runtime_1', runtimeVersion },
});

describe('native Orca plugin contract', () => {
  test('uses the Orca-supported Agent Plugins manifest and existing marketplace path', async () => {
    const manifest = JSON.parse(await readFile(resolve(import.meta.dir, 'plugin.json'), 'utf8'));
    const marketplace = JSON.parse(
      await readFile(resolve(import.meta.dir, '../../.agents/plugins/marketplace.json'), 'utf8'),
    );

    expect(manifest).toMatchObject({
      $schema: ORCA_AGENT_PLUGIN_SCHEMA,
      name: 'genie',
      extensions: {
        'dev.orca.compatibility': {
          minimumRuntimeVersion: ORCA_MINIMUM_RUNTIME_VERSION,
          requiredContract: 'orchestration.contract.v1',
          transport: 'public-cli',
        },
      },
    });
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({ name: 'genie', source: { source: 'local', path: './plugins/genie' } }),
    );
    expect(manifest).not.toHaveProperty('mcpServers');
  });

  test('probes with one read-only public adapter call before allowing operations', async () => {
    const calls: OrcaOperation[] = [];
    const adapter: OrcaOrchestrationAdapter = {
      executable: 'opaque-to-plugin',
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
    expect(calls).toEqual([{ operation: 'run-list', limit: 1 }]);
  });

  test('converts every probe failure to unsupported_environment and never mutates', async () => {
    for (const failure of [new Error('spawn denied'), response('1.3.999'), { ...response(), _meta: undefined }]) {
      const calls: OrcaOperation[] = [];
      const adapter: OrcaOrchestrationAdapter = {
        executable: 'opaque-to-plugin',
        execute: async (operation) => {
          calls.push(operation as OrcaOperation);
          if (failure instanceof Error) throw failure;
          return failure;
        },
      };

      await expect(createOrcaPluginRuntime(adapter).probe()).rejects.toMatchObject({
        code: 'unsupported_environment',
        operation: 'runtime',
        phase: 'resolve',
        retrySafety: 'safe',
      });
      expect(calls).toEqual([{ operation: 'run-list', limit: 1 }]);
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
