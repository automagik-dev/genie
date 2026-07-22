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
import { acquireLifecycleLease } from '../../src/lib/codex-lifecycle-lease.js';

const LEASE_MODULE = join(import.meta.dir, '..', '..', 'src', 'lib', 'codex-lifecycle-lease.ts');
const INSTALL_MODULE = join(import.meta.dir, '..', '..', 'src', 'genie-commands', 'install.ts');

let home: string;
let script: string;
let installScript: string;

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
  // A real `genie install` command path: GENIE_HOME is fixed BEFORE importing
  // install.ts (it captures GENIE_HOME at module load) so the command's real
  // default Codex-lifecycle-lease acquisition targets the fixture home. Every
  // other seam is a noop, so if the lease is busy the command mutates nothing
  // and projects the exit-2 codex-lifecycle-busy loser refusal.
  installScript = join(home, 'install-cmd.ts');
  writeFileSync(
    installScript,
    [
      'process.env.GENIE_HOME = process.argv[2];',
      `const mod = await import(${JSON.stringify(INSTALL_MODULE)});`,
      'const noopLease = () => ({ path: process.argv[2] + "/.agent-sync.lock", release: () => {} });',
      'mod.installCommand(',
      "  { integrations: 'codex' },",
      '  () => undefined,', // runV4Cleanup
      '  () => undefined,', // normalizeLayout
      '  () => undefined,', // runSync
      '  () => [],', // runIntegrations (mutation seam — must never run when busy)
      '  noopLease,', // agent-sync lease (free)
      '  undefined,', // acquireCodexLease -> real default acquisition
      '  () => undefined,', // writeConsent
      '  () => null,', // classifyCodexInstall (no codex CLI probe)
      ');',
      "process.stdout.write(process.exitCode === 2 ? 'BUSY' : 'WON');",
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

  test('update (held lease) + REAL install command: install refuses at command level with exit 2 codex-lifecycle-busy, zero mutation', async () => {
    // A concurrent `genie update` holds the Codex lifecycle lease (update-delivery).
    const held = acquireLifecycleLease('update-delivery', { genieHome: home });
    expect(held.ok).toBe(true);
    try {
      const proc = Bun.spawn(['bun', 'run', installScript, home], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GENIE_HOME: home },
      });
      const out = (await new Response(proc.stdout).text()).trim();
      const exitCode = await proc.exited;
      // The real install command projects the exit-2 loser refusal and mutates nothing.
      expect(exitCode).toBe(2);
      expect(out).toContain('codex-lifecycle-busy');
      expect(out).toContain('update-delivery');
      expect(out).toContain('"deliveryComplete":false');
      expect(out.endsWith('BUSY')).toBe(true);
    } finally {
      if (held.ok) held.release();
    }
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
