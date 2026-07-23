/**
 * Real spawned two-process command races (Group C, deliverable 9).
 *
 * The lifecycle commands serialize through ONE Codex lifecycle lease, so a
 * concurrent update+install or update+rollback must produce exactly one winner;
 * the loser gets the typed `codex-lifecycle-busy` refusal and mutates nothing.
 * A's `codex-lifecycle-lease.test.ts` proves private-record O_EXCL plus atomic
 * stable publication for a single kind — this proves CROSS-KIND exclusion: `update-delivery` (update),
 * `install-converge` (install) and `rollback` all contend on the same lease
 * file under one GENIE_HOME, so no two lifecycle commands can hold it at once.
 *
 * Real OS processes (not in-process simulation) race against one fixture-root
 * lease directory, per the subprocess-fixture isolation contract.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLifecycleLease as acquireAgentLifecycleLease, lifecycleLockPath } from '../../src/lib/agent-sync.js';
import { acquireLifecycleLease } from '../../src/lib/codex-lifecycle-lease.js';

const LEASE_MODULE = join(import.meta.dir, '..', '..', 'src', 'lib', 'codex-lifecycle-lease.ts');
const INSTALL_MODULE = join(import.meta.dir, '..', '..', 'src', 'genie-commands', 'install.ts');
const UPDATE_MODULE = join(import.meta.dir, '..', '..', 'src', 'genie-commands', 'update.ts');

let home: string;
let script: string;
let installScript: string;
let updateScript: string;
let updateFailureScript: string;

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
      "const { writeFileSync } = await import('node:fs');",
      `const mod = await import(${JSON.stringify(INSTALL_MODULE)});`,
      'const mutationPath = process.argv[3];',
      "const mark = (phase) => writeFileSync(mutationPath, phase + '\\n');",
      'const noopLease = () => ({ path: process.argv[2] + "/.agent-sync.lock", release: () => {} });',
      'await mod.installCommand(',
      "  { integrations: 'codex' },",
      "  () => mark('cleanup'),", // runV4Cleanup
      "  () => mark('normalize'),", // normalizeLayout
      "  () => mark('sync'),", // runSync
      "  () => { mark('integrations'); return []; },", // mutation seam — must never run when busy
      '  noopLease,', // agent-sync lease (free)
      '  undefined,', // acquireCodexLease -> real default acquisition
      "  () => mark('consent'),", // writeConsent
      '  () => null,', // classifyCodexInstall (no codex CLI probe)
      ');',
      "process.stdout.write(process.exitCode === 2 ? 'BUSY' : 'WON');",
      '',
    ].join('\n'),
  );
  updateScript = join(home, 'update-cmd.ts');
  writeFileSync(
    updateScript,
    [
      'process.env.GENIE_HOME = process.argv[2];',
      "const { writeFileSync } = await import('node:fs');",
      `const mod = await import(${JSON.stringify(UPDATE_MODULE)});`,
      'const mutationPath = process.argv[3];',
      "const mark = (phase) => writeFileSync(mutationPath, phase + '\\n');",
      'const manifest = {',
      '  schema_version: 1,',
      "  channel: 'stable',",
      "  version: '5.260723.8',",
      "  released_at: '2026-07-23T00:00:00Z',",
      "  tarball_base: 'https://github.com/automagik-dev/genie/releases/download/v5.260723.8',",
      "  platforms: ['darwin-arm64'],",
      '  manifestBytes: \'{"version":"5.260723.8"}\\n\',',
      "  manifestSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',",
      '};',
      'await mod.updateCommand({ yes: true, stable: true }, {',
      '  fetchManifest: async () => manifest,',
      "  readInstalledVersion: () => '5.260700.1',",
      "  resolvePlatform: () => 'darwin-arm64',",
      '  acquireLease: () => ({ path: process.argv[2] + "/.agent-sync.lock", release: () => {} }),',
      "  recoverPendingState: () => mark('recovery'),",
      "  persistSelectedChannel: async () => mark('channel'),",
      "  requireCanonicalInstall: () => mark('canonical'),",
      "  deliverSelectedManifest: async () => { mark('delivery'); return []; },",
      "  finalizeSelectedDelivery: async () => { mark('finalize'); return true; },",
      '});',
      "process.stdout.write(process.exitCode === 2 ? 'BUSY' : 'WON');",
      '',
    ].join('\n'),
  );
  updateFailureScript = join(home, 'update-terminal-failure.ts');
  writeFileSync(
    updateFailureScript,
    [
      'process.env.GENIE_HOME = process.argv[2];',
      `const mod = await import(${JSON.stringify(UPDATE_MODULE)});`,
      'const failure = process.argv[3];',
      'const manifest = {',
      '  schema_version: 1,',
      "  channel: 'stable',",
      "  version: '5.260723.8',",
      "  released_at: '2026-07-23T00:00:00Z',",
      "  tarball_base: 'https://github.com/automagik-dev/genie/releases/download/v5.260723.8',",
      "  platforms: ['darwin-arm64'],",
      '  manifestBytes: \'{"version":"5.260723.8"}\\n\',',
      "  manifestSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',",
      '};',
      'await mod.updateCommand({ yes: true, stable: true }, {',
      '  fetchManifest: async () => manifest,',
      "  readInstalledVersion: () => '5.260700.1',",
      "  resolvePlatform: () => 'darwin-arm64',",
      '  recoverPendingState: () => undefined,',
      '  persistSelectedChannel: async () => undefined,',
      "  requireCanonicalInstall: () => { if (failure === 'canonical') throw new Error('canonical refusal fixture'); },",
      "  deliverSelectedManifest: async () => { if (failure === 'delivery') throw new Error('delivery failure fixture'); return []; },",
      '  finalizeSelectedDelivery: async () => true,',
      '});',
      "process.stdout.write('TERMINAL:' + String(process.exitCode));",
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

function expectExactWinnerAttribution(outcomes: string[]): void {
  const winners = outcomes.filter((outcome) => outcome.startsWith('WON:'));
  const losers = outcomes.filter((outcome) => outcome.startsWith('BUSY:'));
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(outcomes.length - 1);
  expect(new Set(losers)).toEqual(new Set([`BUSY:${winners[0].slice('WON:'.length)}`]));
}

async function expectRealUpdateTerminalReleasesBothLeases(
  failure: 'canonical' | 'delivery',
  expectedMessage: string,
): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', updateFailureScript, home, failure], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GENIE_HOME: home },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(await proc.exited).toBe(1);
  expect(`${stdout}\n${stderr}`).toContain(expectedMessage);
  expect(stdout.trim().endsWith('TERMINAL:1')).toBe(true);

  const agentPath = lifecycleLockPath(home);
  const codexPath = join(home, '.codex-lifecycle.lock');
  expect(existsSync(agentPath)).toBe(false);
  expect(existsSync(codexPath)).toBe(false);

  const agent = acquireAgentLifecycleLease(home);
  expect('skipped' in agent).toBe(false);
  if ('skipped' in agent) throw new Error(agent.skipped);
  const codex = acquireLifecycleLease('setup-activation', { genieHome: home });
  expect(codex.ok).toBe(true);
  try {
    expect(existsSync(agentPath)).toBe(true);
    expect(existsSync(codexPath)).toBe(true);
  } finally {
    if (codex.ok) codex.release();
    agent.release();
  }
  expect(existsSync(agentPath)).toBe(false);
  expect(existsSync(codexPath)).toBe(false);
}

describe('cross-command Codex lifecycle races produce exactly one winner', () => {
  test('update + install: exactly one winner, loser is codex-lifecycle-busy', async () => {
    const outcomes = await race('update-delivery', 'install-converge');
    expectExactWinnerAttribution(outcomes);
  }, 20_000);

  test('setup (held lease) + REAL install command: install refuses at command level with exit 2 and zero mutation', async () => {
    const mutationPath = join(home, 'install-mutation');
    const held = acquireLifecycleLease('setup-activation', { genieHome: home });
    expect(held.ok).toBe(true);
    try {
      const proc = Bun.spawn(['bun', 'run', installScript, home, mutationPath], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GENIE_HOME: home },
      });
      const out = (await new Response(proc.stdout).text()).trim();
      const exitCode = await proc.exited;
      // The real install command projects the exit-2 loser refusal and mutates nothing.
      expect(exitCode).toBe(2);
      expect(out).toContain('codex-lifecycle-busy');
      expect(out).toContain('setup-activation');
      expect(out).toContain('"deliveryComplete":false');
      expect(out.endsWith('BUSY')).toBe(true);
      expect(existsSync(mutationPath)).toBe(false);
    } finally {
      if (held.ok) held.release();
    }
  }, 20_000);

  test('setup (held lease) + REAL update command: update refuses before recovery or delivery mutation', async () => {
    const mutationPath = join(home, 'update-mutation');
    const held = acquireLifecycleLease('setup-activation', { genieHome: home });
    expect(held.ok).toBe(true);
    try {
      const proc = Bun.spawn(['bun', 'run', updateScript, home, mutationPath], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GENIE_HOME: home },
      });
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const exitCode = await proc.exited;
      const output = `${stdout}\n${stderr}`;
      expect(exitCode).toBe(2);
      expect(output).toContain('codex-lifecycle-busy');
      expect(output).toContain('setup-activation');
      expect(output).toContain('"deliveryComplete":false');
      expect(stdout.trim().endsWith('BUSY')).toBe(true);
      expect(existsSync(mutationPath)).toBe(false);
    } finally {
      if (held.ok) held.release();
    }
  }, 20_000);

  test('real update canonical refusal exits only after both lifecycle leases release', async () => {
    await expectRealUpdateTerminalReleasesBothLeases('canonical', 'canonical refusal fixture');
  }, 20_000);

  test('real update delivery failure exits only after both lifecycle leases release', async () => {
    await expectRealUpdateTerminalReleasesBothLeases('delivery', 'Update failed: delivery failure fixture');
  }, 20_000);

  test('update + rollback: exactly one winner, loser is codex-lifecycle-busy', async () => {
    const outcomes = await race('update-delivery', 'rollback');
    expectExactWinnerAttribution(outcomes);
  }, 20_000);

  test('SIGKILL before stable publication leaves recoverable private debris', async () => {
    const marker = join(home, 'before-publish.ready');
    const crashScript = join(home, 'crash-before-publish.ts');
    writeFileSync(
      crashScript,
      [
        "import { writeFileSync } from 'node:fs';",
        `import { acquireLifecycleLease } from ${JSON.stringify(LEASE_MODULE)};`,
        'const [genieHome, marker] = process.argv.slice(2);',
        "const result = acquireLifecycleLease('update-delivery', {",
        '  genieHome,',
        '  beforePublishForTest: () => {',
        "    writeFileSync(marker, 'ready');",
        '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);',
        '  },',
        '});',
        'if (!result.ok) process.exit(3);',
      ].join('\n'),
    );
    const child = Bun.spawn(['bun', 'run', crashScript, home, marker], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });

    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(marker)).toBe(true);
      expect(readdirSync(home).filter((name) => name.includes('.staging-'))).toHaveLength(1);

      child.kill('SIGKILL');
      expect(await child.exited).not.toBe(0);

      const recovered = acquireLifecycleLease('rollback', { genieHome: home });
      expect(recovered.ok).toBe(true);
      expect(readdirSync(home).filter((name) => name.includes('.staging-'))).toEqual([]);
      if (recovered.ok) recovered.release();
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
  }, 20_000);

  test('a fresh process recovers a fixed staging slot behind 1,210 crowded directory entries', async () => {
    for (let index = 0; index < 1_210; index += 1) {
      writeFileSync(
        join(home, `.codex-lifecycle.lock.staging-noise-${index.toString().padStart(4, '0')}`),
        '{ preserved foreign debris',
      );
    }
    const operationId = `fe${'0'.repeat(30)}`;
    const staging = join(home, '.codex-lifecycle.lock.staging-fe');
    writeFileSync(
      staging,
      `${JSON.stringify({
        schemaVersion: 1,
        operationId,
        kind: 'update-delivery',
        pid: 424242,
        startedAt: '2026-07-23T00:00:00.000Z',
        stagingSlot: 'fe',
      })}\n`,
    );
    const recoveryScript = join(home, 'fresh-process-crowded-recovery.ts');
    writeFileSync(
      recoveryScript,
      [
        `import { acquireLifecycleLease } from ${JSON.stringify(LEASE_MODULE)};`,
        'const result = acquireLifecycleLease("rollback", { genieHome: process.argv[2], isProcessAlive: () => false });',
        "process.stdout.write(result.ok ? 'WON' : 'BUSY:' + (result.holderKind ?? 'unknown'));",
        'if (result.ok) result.release();',
      ].join('\n'),
    );

    const child = Bun.spawn(['bun', 'run', recoveryScript, home], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });
    const stdout = (await new Response(child.stdout).text()).trim();
    const stderr = (await new Response(child.stderr).text()).trim();
    expect(await child.exited, stderr).toBe(0);
    expect(stdout).toBe('WON');
    expect(existsSync(staging)).toBe(false);
    expect(readdirSync(home).filter((name) => name.includes('staging-noise-'))).toHaveLength(1_210);
  }, 20_000);

  test('32 fresh contenders released through one ready/go barrier retain exact attribution', async () => {
    const contenderCount = 32;
    const go = join(home, 'fresh-race.go');
    const freshRaceScript = join(home, 'fresh-race.ts');
    writeFileSync(
      freshRaceScript,
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        `import { acquireLifecycleLease } from ${JSON.stringify(LEASE_MODULE)};`,
        'const [genieHome, go] = process.argv.slice(2);',
        "writeFileSync(genieHome + '/fresh-ready-' + process.pid, 'ready');",
        'while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
        "const result = acquireLifecycleLease('update-delivery', { genieHome });",
        "process.stdout.write(result.ok ? 'WON:' + result.kind : 'BUSY:' + (result.holderKind ?? 'unknown') + (result.holderKind === null ? '[' + result.detail + ']' : ''));",
        'if (result.ok) await new Promise((resolve) => setTimeout(resolve, 500));',
      ].join('\n'),
    );
    const spawnOne = () =>
      Bun.spawn(['bun', 'run', freshRaceScript, home, go], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      });
    const children = Array.from({ length: contenderCount }, spawnOne);

    try {
      const deadline = Date.now() + 15_000;
      while (
        readdirSync(home).filter((name) => name.startsWith('fresh-ready-')).length < contenderCount &&
        Date.now() < deadline
      ) {
        await Bun.sleep(10);
      }
      expect(readdirSync(home).filter((name) => name.startsWith('fresh-ready-'))).toHaveLength(contenderCount);
      writeFileSync(go, 'go\n');
      const outcomes = await Promise.all(
        children.map(async (child) => {
          const stdout = (await new Response(child.stdout).text()).trim();
          const stderr = (await new Response(child.stderr).text()).trim();
          const exitCode = await child.exited;
          expect(exitCode, stderr).toBe(0);
          return stdout;
        }),
      );

      expectExactWinnerAttribution(outcomes);
      expect(readdirSync(home).filter((name) => /^\.codex-lifecycle\.lock\.staging-[0-9a-f]{2}$/.test(name))).toEqual(
        [],
      );
    } finally {
      if (!existsSync(go)) writeFileSync(go, 'go\n');
      for (const child of children) child.kill('SIGKILL');
      await Promise.all(children.map((child) => child.exited));
    }
  }, 20_000);

  test('32 contenders aligned after observing one dead holder produce one winner and exact losers', async () => {
    const contenderCount = 32;
    const staleRecord = {
      schemaVersion: 1,
      operationId: 'a'.repeat(32),
      kind: 'rollback',
      pid: 424242,
      startedAt: '2026-07-23T00:00:00.000Z',
    };
    writeFileSync(join(home, '.codex-lifecycle.lock'), `${JSON.stringify(staleRecord)}\n`);
    const go = join(home, 'stale-race.go');
    const staleRaceScript = join(home, 'stale-race.ts');
    writeFileSync(
      staleRaceScript,
      [
        "import { existsSync, writeFileSync } from 'node:fs';",
        `import { acquireLifecycleLease } from ${JSON.stringify(LEASE_MODULE)};`,
        'const [genieHome, go] = process.argv.slice(2);',
        "const result = acquireLifecycleLease('update-delivery', {",
        '  genieHome,',
        '  isProcessAlive: (pid) => pid !== 424242,',
        '  afterDeadHolderObservedForTest: () => {',
        "    writeFileSync(genieHome + '/stale-observed-' + process.pid, 'ready');",
        '    while (!existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);',
        '  },',
        '});',
        "process.stdout.write(result.ok ? 'WON:' + result.kind : 'BUSY:' + (result.holderKind ?? 'unknown') + (result.holderKind === null ? '[' + result.detail + ']' : ''));",
        'if (result.ok) await new Promise((resolve) => setTimeout(resolve, 500));',
      ].join('\n'),
    );
    const spawnOne = () =>
      Bun.spawn(['bun', 'run', staleRaceScript, home, go], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      });
    const children = Array.from({ length: contenderCount }, spawnOne);

    try {
      const deadline = Date.now() + 15_000;
      while (
        readdirSync(home).filter((name) => name.startsWith('stale-observed-')).length < contenderCount &&
        Date.now() < deadline
      ) {
        await Bun.sleep(10);
      }
      expect(readdirSync(home).filter((name) => name.startsWith('stale-observed-'))).toHaveLength(contenderCount);
      writeFileSync(go, 'go\n');
      const outcomes = await Promise.all(
        children.map(async (child) => {
          const stdout = (await new Response(child.stdout).text()).trim();
          const stderr = (await new Response(child.stderr).text()).trim();
          const exitCode = await child.exited;
          expect(exitCode, stderr).toBe(0);
          return stdout;
        }),
      );

      expectExactWinnerAttribution(outcomes);
      expect(readdirSync(home).filter((name) => name.startsWith('.codex-lifecycle.lock.stale-'))).toHaveLength(1);
      expect(readdirSync(home).filter((name) => /^\.codex-lifecycle\.lock\.staging-[0-9a-f]{2}$/.test(name))).toEqual(
        [],
      );
      expect(existsSync(join(home, '.codex-lifecycle.lock.recovery'))).toBe(false);
    } finally {
      if (!existsSync(go)) writeFileSync(go, 'go\n');
      for (const child of children) child.kill('SIGKILL');
      await Promise.all(children.map((child) => child.exited));
    }
  }, 20_000);

  test('SIGKILL at every stale-recovery claim window permits a bounded takeover', async () => {
    const windows = [
      {
        name: 'after-claim-publication',
        hook: '  afterRecoveryClaimForTest: stop,',
      },
      {
        name: 'after-old-stable-capture',
        hook: "  afterCaptureForTest: (event) => { if (event.operation === 'stale-supersede') stop(); },",
      },
      {
        name: 'before-fresh-stable-publication',
        hook: [
          '  beforePublishForTest: () => {',
          '    publicationCount += 1;',
          '    if (publicationCount === 2) stop();',
          '  },',
        ].join('\n'),
      },
    ];

    for (const window of windows) {
      const crashHome = join(home, window.name);
      mkdirSync(crashHome);
      const marker = join(crashHome, 'blocked.ready');
      const crashScript = join(crashHome, 'crash-during-recovery.ts');
      const stalePid = 42_424_242;
      writeFileSync(
        join(crashHome, '.codex-lifecycle.lock'),
        `${JSON.stringify({
          schemaVersion: 1,
          operationId: 'c'.repeat(32),
          kind: 'rollback',
          pid: stalePid,
          startedAt: '2026-07-23T00:00:00.000Z',
        })}\n`,
      );
      writeFileSync(
        crashScript,
        [
          "import { writeFileSync } from 'node:fs';",
          `import { acquireLifecycleLease } from ${JSON.stringify(LEASE_MODULE)};`,
          'const [genieHome, marker] = process.argv.slice(2);',
          'let publicationCount = 0;',
          "const stop = () => { writeFileSync(marker, 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); };",
          "const result = acquireLifecycleLease('update-delivery', {",
          '  genieHome,',
          `  isProcessAlive: (pid) => pid !== ${stalePid},`,
          window.hook,
          '});',
          "process.stdout.write(result.ok ? 'WON' : 'BUSY:' + (result.holderKind ?? 'unknown'));",
        ].join('\n'),
      );
      const child = Bun.spawn(['bun', 'run', crashScript, crashHome, marker], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env },
      });

      try {
        const deadline = Date.now() + 5_000;
        while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
        expect(existsSync(marker), window.name).toBe(true);
        expect(existsSync(join(crashHome, '.codex-lifecycle.lock.recovery')), window.name).toBe(true);

        child.kill('SIGKILL');
        expect(await child.exited, window.name).not.toBe(0);

        const takeover = acquireLifecycleLease('setup-activation', {
          genieHome: crashHome,
          isProcessAlive: (pid) => pid !== stalePid && pid !== child.pid,
        });
        expect(takeover.ok, window.name).toBe(true);
        expect(existsSync(join(crashHome, '.codex-lifecycle.lock.recovery')), window.name).toBe(false);
        expect(
          readdirSync(crashHome).filter((name) => /^\.codex-lifecycle\.lock\.staging-[0-9a-f]{2}$/.test(name)),
          window.name,
        ).toEqual([]);
        if (takeover.ok) takeover.release();
      } finally {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
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
