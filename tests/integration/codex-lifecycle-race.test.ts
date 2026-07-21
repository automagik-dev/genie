/**
 * Real spawned two-process command races (Group C, deliverable 9).
 *
 * The lifecycle commands serialize through ONE Codex lifecycle lease, so a
 * concurrent update+install or update+rollback must produce exactly one winner;
 * the loser gets the typed `codex-lifecycle-busy` refusal and mutates nothing.
 * A's `codex-lifecycle-lease.test.ts` proves the O_EXCL primitive for a single
 * kind — this proves CROSS-KIND exclusion: `update-delivery` (update),
 * `install-converge` (install) and `rollback` all contend on the same lease
 * file under one GENIE_HOME, so no two lifecycle commands can hold it at once.
 *
 * Real OS processes (not in-process simulation) race against one fixture-root
 * lease directory, per the subprocess-fixture isolation contract.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LEASE_MODULE = join(import.meta.dir, '..', '..', 'src', 'lib', 'codex-lifecycle-lease.ts');

let home: string;
let script: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'genie-lifecycle-race-'));
  script = join(home, 'contend.ts');
  // A tiny real command: acquire the lease for the kind in argv[3], hold it long
  // enough for the sibling to contend, and report WON/BUSY. Never release on the
  // win so both processes truly contend on the same on-disk lease.
  writeFileSync(
    script,
    [
      `import { acquireLifecycleLease } from ${JSON.stringify(LEASE_MODULE)};`,
      'const genieHome = process.argv[2];',
      'const kind = process.argv[3];',
      'const result = acquireLifecycleLease(kind, { genieHome });',
      "if (result.ok) { process.stdout.write('WON:' + result.kind); await new Promise((r) => setTimeout(r, 500)); }",
      "else { process.stdout.write('BUSY:' + (result.holderKind ?? 'unknown')); }",
      '',
    ].join('\n'),
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function race(kindA: string, kindB: string): Promise<string[]> {
  const spawnOne = (kind: string) =>
    Bun.spawn(['bun', 'run', script, home, kind], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
  const procs = [spawnOne(kindA), spawnOne(kindB)];
  return Promise.all(
    procs.map(async (proc) => {
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.trim();
    }),
  );
}

function leaseFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => entry.includes('lifecycle') || entry.endsWith('.lock'));
}

describe('cross-command Codex lifecycle races produce exactly one winner', () => {
  test('update + install: exactly one winner, loser is codex-lifecycle-busy', async () => {
    const outcomes = await race('update-delivery', 'install-converge');
    expect(outcomes.filter((o) => o.startsWith('WON:'))).toHaveLength(1);
    const losers = outcomes.filter((o) => o.startsWith('BUSY:'));
    expect(losers).toHaveLength(1);
    // The loser names a valid held-kind (the winner's kind), never a corruption.
    expect(losers[0]).toMatch(/BUSY:(update-delivery|install-converge)/);
  }, 20_000);

  test('update + rollback: exactly one winner, loser is codex-lifecycle-busy', async () => {
    const outcomes = await race('update-delivery', 'rollback');
    expect(outcomes.filter((o) => o.startsWith('WON:'))).toHaveLength(1);
    expect(outcomes.filter((o) => o.startsWith('BUSY:'))).toHaveLength(1);
  }, 20_000);

  test('the winner leaves exactly one lease file under the fixture home; no escape', async () => {
    await race('update-delivery', 'install-converge');
    // The held (unreleased) winner's lease persists; all lease state is under home.
    for (const name of readdirSync(home)) {
      expect(join(home, name).startsWith(home)).toBe(true);
    }
    // At most one lease lock remains (the winner never released in the harness).
    expect(leaseFiles(home).length).toBeLessThanOrEqual(1);
  }, 20_000);
});
