import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HeldLifecycleLease, LifecycleFencingError, acquireLifecycleLease } from './codex-lifecycle-lease.js';

const roots: string[] = [];
const heldLeases: HeldLifecycleLease[] = [];

function freshHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-lease-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

const LEASE_FILE = '.codex-lifecycle.lock';

afterEach(() => {
  for (const lease of heldLeases.splice(0)) lease.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hold(result: ReturnType<typeof acquireLifecycleLease>): HeldLifecycleLease {
  if (!result.ok) throw new Error(`expected a held lease, got busy: ${result.detail}`);
  heldLeases.push(result);
  return result;
}

describe('acquireLifecycleLease — acquisition and mutual exclusion', () => {
  test('a fresh home grants a lease with a 32-hex operation id and the requested kind', () => {
    const genieHome = freshHome();
    const lease = hold(acquireLifecycleLease('update-delivery', { genieHome }));
    expect(lease.operationId).toMatch(/^[0-9a-f]{32}$/);
    expect(lease.kind).toBe('update-delivery');
    expect(existsSync(join(genieHome, LEASE_FILE))).toBe(true);
  });

  test('a second acquisition while held returns a typed busy refusal naming the holder kind', () => {
    const genieHome = freshHome();
    hold(acquireLifecycleLease('setup-activation', { genieHome }));
    const second = acquireLifecycleLease('rollback', { genieHome });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.reason).toBe('codex-lifecycle-busy');
    expect(second.holderKind).toBe('setup-activation');
  });

  test('release makes the slot acquirable again and is idempotent', () => {
    const genieHome = freshHome();
    const first = acquireLifecycleLease('update-delivery', { genieHome });
    if (!first.ok) throw new Error('unreachable');
    first.release();
    first.release(); // idempotent
    expect(existsSync(join(genieHome, LEASE_FILE))).toBe(false);
    const second = hold(acquireLifecycleLease('update-delivery', { genieHome }));
    expect(second.ok).toBe(true);
  });

  test('an unsupported kind throws rather than acquiring', () => {
    const genieHome = freshHome();
    const invalidKind = 'totally-invalid' as unknown as Parameters<typeof acquireLifecycleLease>[0];
    expect(() => acquireLifecycleLease(invalidKind, { genieHome })).toThrow();
  });

  test('uninstall is a valid lease kind and serialises against setup-activation (both directions)', () => {
    const genieHome = freshHome();
    const uninstall = hold(acquireLifecycleLease('uninstall', { genieHome }));
    expect(uninstall.kind).toBe('uninstall');
    const setupLoser = acquireLifecycleLease('setup-activation', { genieHome });
    expect(setupLoser.ok).toBe(false);
    if (setupLoser.ok) throw new Error('unreachable');
    expect(setupLoser.reason).toBe('codex-lifecycle-busy');
    expect(setupLoser.holderKind).toBe('uninstall');

    uninstall.release();
    // Reverse direction: a held setup-activation makes uninstall busy.
    hold(acquireLifecycleLease('setup-activation', { genieHome }));
    const uninstallLoser = acquireLifecycleLease('uninstall', { genieHome });
    expect(uninstallLoser.ok).toBe(false);
    if (uninstallLoser.ok) throw new Error('unreachable');
    expect(uninstallLoser.holderKind).toBe('setup-activation');
  });
});

describe('acquireLifecycleLease — stale holder supersession', () => {
  test('a provably dead holder is superseded exactly once, retaining rename evidence', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    const staleRecord = {
      schemaVersion: 1,
      operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      kind: 'setup-activation',
      pid: 424242,
      startedAt: '2026-07-12T00:00:00.000Z',
    };
    writeFileSync(leasePath, `${JSON.stringify(staleRecord)}\n`);

    const lease = hold(acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false }));
    expect(lease.kind).toBe('update-delivery');

    const staleFiles = readdirSync(genieHome).filter((name) => name.startsWith(`${LEASE_FILE}.stale-`));
    expect(staleFiles.length).toBe(1);
    expect(staleFiles[0]).toBe(`${LEASE_FILE}.stale-${lease.operationId}`);
    const superseded = JSON.parse(readFileSync(join(genieHome, staleFiles[0]), 'utf8'));
    expect(superseded.operationId).toBe(staleRecord.operationId);
  });

  test('a live holder is never superseded and stays busy', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    writeFileSync(
      leasePath,
      `${JSON.stringify({ schemaVersion: 1, operationId: 'b'.repeat(32), kind: 'rollback', pid: 4242, startedAt: 'x' })}\n`,
    );
    const result = acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.holderKind).toBe('rollback');
    // The live holder's lease was neither superseded nor deleted.
    expect(readdirSync(genieHome).filter((n) => n.startsWith(`${LEASE_FILE}.stale-`)).length).toBe(0);
    expect(existsSync(leasePath)).toBe(true);
  });

  test('an indeterminate (EPERM-style) holder stays busy', () => {
    const genieHome = freshHome();
    writeFileSync(
      join(genieHome, LEASE_FILE),
      `${JSON.stringify({ schemaVersion: 1, operationId: 'c'.repeat(32), kind: 'install-converge', pid: 4242, startedAt: 'x' })}\n`,
    );
    // A liveness probe that reports alive for anything it cannot disprove.
    const result = acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => true });
    expect(result.ok).toBe(false);
  });
});

describe('acquireLifecycleLease — fail-closed invalid lease files', () => {
  test('a symlinked lease path fails closed as busy and is never deleted', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    const decoy = join(genieHome, 'decoy.json');
    writeFileSync(
      decoy,
      `${JSON.stringify({ schemaVersion: 1, operationId: 'd'.repeat(32), kind: 'rollback', pid: 4242, startedAt: 'x' })}\n`,
    );
    symlinkSync(decoy, leasePath);
    const result = acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.holderKind).toBeNull();
    expect(existsSync(leasePath)).toBe(true); // symlink preserved, not deleted
  });

  test('an oversized lease file fails closed as busy', () => {
    const genieHome = freshHome();
    writeFileSync(join(genieHome, LEASE_FILE), 'x'.repeat(17 * 1024));
    const result = acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.holderKind).toBeNull();
    expect(existsSync(join(genieHome, LEASE_FILE))).toBe(true);
  });

  test('a schema-invalid lease file fails closed as busy without deletion', () => {
    const genieHome = freshHome();
    writeFileSync(join(genieHome, LEASE_FILE), '{ not valid json');
    const result = acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false });
    expect(result.ok).toBe(false);
    expect(existsSync(join(genieHome, LEASE_FILE))).toBe(true);
  });
});

describe('acquireLifecycleLease — operation-id fencing', () => {
  test('assertOperation accepts the held id and rejects a foreign id', () => {
    const genieHome = freshHome();
    const lease = hold(acquireLifecycleLease('update-delivery', { genieHome }));
    expect(() => lease.assertOperation(lease.operationId)).not.toThrow();
    expect(() => lease.assertOperation('f'.repeat(32))).toThrow(LifecycleFencingError);
  });

  test('a superseded on-disk lease fences the prior holder and blocks its release', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    const first = acquireLifecycleLease('update-delivery', { genieHome });
    if (!first.ok) throw new Error('unreachable');
    // Simulate another acquirer replacing the on-disk record.
    writeFileSync(
      leasePath,
      `${JSON.stringify({ schemaVersion: 1, operationId: 'e'.repeat(32), kind: 'rollback', pid: process.pid, startedAt: 'x' })}\n`,
    );
    expect(() => first.assertOperation(first.operationId)).toThrow(LifecycleFencingError);
    // Releasing the fenced holder must not delete the new owner's lease.
    first.release();
    expect(existsSync(leasePath)).toBe(true);
    expect(JSON.parse(readFileSync(leasePath, 'utf8')).operationId).toBe('e'.repeat(32));
  });

  test('assertOperation on a released lease throws', () => {
    const genieHome = freshHome();
    const lease = acquireLifecycleLease('update-delivery', { genieHome });
    if (!lease.ok) throw new Error('unreachable');
    lease.release();
    expect(() => lease.assertOperation(lease.operationId)).toThrow(LifecycleFencingError);
  });
});

describe('acquireLifecycleLease — real two-process race', () => {
  test('exactly one of two spawned processes wins the O_EXCL create', async () => {
    const genieHome = freshHome();
    const script = join(genieHome, 'race.ts');
    const modulePath = join(import.meta.dir, 'codex-lifecycle-lease.ts');
    writeFileSync(
      script,
      [
        `import { acquireLifecycleLease } from ${JSON.stringify(modulePath)};`,
        'const genieHome = process.argv[2];',
        `const result = acquireLifecycleLease('update-delivery', { genieHome });`,
        // Do NOT release: hold the lock so both processes contend on the same file.
        `process.stdout.write(result.ok ? 'WON' : 'BUSY');`,
        'if (result.ok) { await new Promise((r) => setTimeout(r, 400)); }',
      ].join('\n'),
    );

    const spawnOne = () =>
      Bun.spawn(['bun', 'run', script, genieHome], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
    const procs = [spawnOne(), spawnOne(), spawnOne()];
    const outcomes = await Promise.all(
      procs.map(async (proc) => {
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        return out.trim();
      }),
    );
    const wins = outcomes.filter((o) => o === 'WON').length;
    const busy = outcomes.filter((o) => o === 'BUSY').length;
    expect(wins).toBe(1);
    expect(busy).toBe(2);
  }, 20_000);
});

describe('fixture isolation', () => {
  test('all lease state stays under the fixture home', () => {
    const genieHome = freshHome();
    const lease = hold(acquireLifecycleLease('update-delivery', { genieHome }));
    for (const name of readdirSync(genieHome)) {
      expect(join(genieHome, name).startsWith(genieHome)).toBe(true);
    }
    lease.release();
  });
});
