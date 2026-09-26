import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OrcaAdapterError } from '../../src/lib/orca-orchestration-adapter';
import { createOrcaPluginRuntime } from './orca-runtime';

const runRealSmoke = process.env.GENIE_ORCA_REAL_RUNTIME_SMOKE === '1' ? test : test.skip;
const lifecyclePaths = [
  '.genie/genie.db',
  '.genie/genie.db-wal',
  '.genie/genie.db-shm',
  '.genie/INDEX.md',
  '.genie/wishes',
];

async function digestPath(path: string): Promise<string> {
  try {
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      const entries = (await readdir(path)).sort();
      const children = await Promise.all(
        entries.map(async (entry) => `${entry}:${await digestPath(resolve(path, entry))}`),
      );
      return createHash('sha256').update(children.join('\n')).digest('hex');
    }
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

async function snapshotLocalLifecycle(): Promise<Readonly<Record<string, string>>> {
  return Object.freeze(
    Object.fromEntries(await Promise.all(lifecyclePaths.map(async (path) => [path, await digestPath(path)]))),
  );
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected an object');
  return value as Record<string, unknown>;
}

function receiptEntityId(result: unknown, entity: 'run' | 'task', legacyId: 'runId' | 'taskId'): string {
  const record = object(result);
  const value = record[legacyId] ?? object(record[entity]).id;
  if (typeof value !== 'string') throw new Error(`missing ${entity} identifier`);
  return value;
}

runRealSmoke(
  'real Orca runtime either completes the disposable flow or fails unsupported without mutation',
  async () => {
    const before = await snapshotLocalLifecycle();
    const runtime = createOrcaPluginRuntime();
    try {
      await runtime.probe();
    } catch (error) {
      expect(error).toBeInstanceOf(OrcaAdapterError);
      expect((error as OrcaAdapterError).code).toBe('unsupported_environment');
      expect(await snapshotLocalLifecycle()).toEqual(before);
      console.warn('Orca real-runtime smoke: unsupported_environment (no local lifecycle mutation)');
      return;
    }

    // A terminal that is not bound to a Run reads back `run: null`; the smoke
    // must not dereference it — there is simply nothing to restore afterwards.
    const prior = await runtime.execute({ operation: 'run-current' });
    const priorRun = object(prior.result).run;
    const priorRunId = priorRun === null || priorRun === undefined ? null : String(object(priorRun).id);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    let disposableTaskId: string | undefined;

    try {
      const createdRun = await runtime.execute({
        operation: 'run-create',
        objective: `Genie A3 disposable smoke ${suffix}`,
      });
      const disposableRunId = receiptEntityId(createdRun.result, 'run', 'runId');
      const runReadback = await runtime.execute({ operation: 'run-show', id: disposableRunId });
      expect(object(object(runReadback.result).run).id).toBe(disposableRunId);

      const createdTask = await runtime.execute({ operation: 'task-create', spec: `Disposable A3 task ${suffix}` });
      disposableTaskId = receiptEntityId(createdTask.result, 'task', 'taskId');
      await runtime.execute({
        operation: 'task-update',
        id: disposableTaskId,
        status: 'completed',
        result: { summary: 'Disposable A3 real-runtime smoke settled successfully.' },
      });
      const tasks = object(await runtime.execute({ operation: 'task-list' }).then((response) => response.result)).tasks;
      expect(
        Array.isArray(tasks) &&
          tasks.some((task) => object(task).id === disposableTaskId && object(task).status === 'completed'),
      ).toBe(true);
    } finally {
      if (priorRunId !== null) await runtime.execute({ operation: 'run-use', id: priorRunId });
    }

    expect(disposableTaskId).toBeDefined();
    if (priorRunId !== null) {
      const restored = await runtime.execute({ operation: 'run-current' });
      expect(object(object(restored.result).run).id).toBe(priorRunId);
    }
    expect(await snapshotLocalLifecycle()).toEqual(before);
  },
  30_000,
);
