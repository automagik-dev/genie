import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openReadonlyHandle } from '../../term-commands/context.js';
import { InvalidOrchestrationAuthorityError, LocalLifecycleDisabledError } from '../orchestration-mode.js';
import { openDb } from './genie-db.js';
import { writeSnapshotFile } from './roadmap-sync.js';

const originalGenieHome = process.env.GENIE_HOME;
const roots: string[] = [];
const GENIE = join(import.meta.dir, '..', '..', 'genie.ts');

function authorityFixture(config: unknown = { orchestration: { mode: 'orca' } }): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-authority-barrier-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  process.env.GENIE_HOME = home;
  return root;
}

const orcaFixture = (): string => authorityFixture();

afterEach(() => {
  if (originalGenieHome === undefined) process.env.GENIE_HOME = undefined;
  else process.env.GENIE_HOME = originalGenieHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Orca authority barriers', () => {
  test('task, board, and idea CLI routes return the stable refusal without creating repository state', async () => {
    const root = orcaFixture();
    const repo = join(root, 'repo');
    mkdirSync(repo);

    for (const args of [['task', 'list'], ['board'], ['idea', 'do not persist']]) {
      const proc = Bun.spawn(['bun', GENIE, ...args], {
        cwd: repo,
        env: { ...process.env, GENIE_HOME: process.env.GENIE_HOME as string, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain('local_lifecycle_disabled_in_orca_mode');
      expect(existsSync(join(repo, '.genie'))).toBe(false);
    }
  });

  test('direct and indirect writable DB opens fail before SQLite creates any filesystem state', () => {
    const root = orcaFixture();
    const direct = join(root, 'direct', 'genie.db');
    const repo = join(root, 'repo');
    mkdirSync(repo);

    expect(() => openDb({ path: direct })).toThrow(LocalLifecycleDisabledError);
    expect(() => openDb({ cwd: repo })).toThrow(LocalLifecycleDisabledError);
    expect(existsSync(join(root, 'direct'))).toBe(false);
    expect(existsSync(join(repo, '.genie'))).toBe(false);
  });

  test('context and MCP read paths refuse an existing local DB without creating sidecars or changing bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-authority-existing-'));
    roots.push(root);
    const home = join(root, 'home');
    const dbPath = join(root, 'repo', '.genie', 'genie.db');
    process.env.GENIE_HOME = home;
    const db = openDb({ path: dbPath });
    db.close();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ orchestration: { mode: 'orca' } }));
    const directory = join(root, 'repo', '.genie');
    const beforeNames = readdirSync(directory);
    const beforeBytes = readFileSync(dbPath);
    const beforeMtime = statSync(dbPath).mtimeMs;

    expect(() => openReadonlyHandle(dbPath)).toThrow(LocalLifecycleDisabledError);

    expect(readdirSync(directory)).toEqual(beforeNames);
    expect(readFileSync(dbPath)).toEqual(beforeBytes);
    expect(statSync(dbPath).mtimeMs).toBe(beforeMtime);
  });

  test('roadmap writes fail before bytes, metadata, or temporary siblings change', () => {
    const root = orcaFixture();
    const roadmap = join(root, 'roadmap.json');
    writeFileSync(roadmap, '{"sentinel":true}\n');
    const before = statSync(roadmap);

    expect(() => writeSnapshotFile(roadmap, { sentinel: false })).toThrow(LocalLifecycleDisabledError);

    const after = statSync(roadmap);
    expect(readFileSync(roadmap, 'utf8')).toBe('{"sentinel":true}\n');
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(existsSync(`${roadmap}.${process.pid}.tmp`)).toBe(false);
  });

  test('standalone remains the default for DB creation and roadmap writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-authority-standalone-'));
    roots.push(root);
    process.env.GENIE_HOME = join(root, 'absent-home');
    const dbPath = join(root, 'repo', '.genie', 'genie.db');
    const roadmap = join(root, 'repo', '.genie', 'roadmap.json');

    const db = openDb({ path: dbPath });
    db.close();
    writeSnapshotFile(roadmap, { version: 1 });

    expect(existsSync(dbPath)).toBe(true);
    expect(JSON.parse(readFileSync(roadmap, 'utf8'))).toEqual({ version: 1 });
  });

  for (const fixtureCase of [
    {
      name: 'explicit Orca with an unrelated invalid field',
      config: { orchestration: { mode: 'orca' }, runtime: { defaultAgent: 'invalid' } },
      error: LocalLifecycleDisabledError,
      code: 'local_lifecycle_disabled_in_orca_mode',
    },
    {
      name: 'malformed authority field',
      config: { orchestration: { mode: 'automatic' } },
      error: InvalidOrchestrationAuthorityError,
      code: 'invalid_orchestration_authority',
    },
    {
      name: 'missing authority mode',
      config: { orchestration: {} },
      error: InvalidOrchestrationAuthorityError,
      code: 'invalid_orchestration_authority',
    },
    {
      name: 'misspelled authority field',
      config: { orchestration: { mod: 'orca' } },
      error: InvalidOrchestrationAuthorityError,
      code: 'invalid_orchestration_authority',
    },
    {
      name: 'extra authority field',
      config: { orchestration: { mode: 'orca', extra: true } },
      error: InvalidOrchestrationAuthorityError,
      code: 'invalid_orchestration_authority',
    },
  ] as const) {
    test(`${fixtureCase.name} refuses CLI and low-level operations without lifecycle mutations`, async () => {
      const root = authorityFixture(fixtureCase.config);
      const repo = join(root, 'repo');
      const dbPath = join(repo, '.genie', 'genie.db');
      const roadmap = join(repo, '.genie', 'roadmap.json');
      mkdirSync(repo);

      for (const args of [['task', 'list'], ['board'], ['idea', 'do not persist']]) {
        const proc = Bun.spawn(['bun', GENIE, ...args], {
          cwd: repo,
          env: { ...process.env, GENIE_HOME: process.env.GENIE_HOME as string, NO_COLOR: '1' },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        expect(exitCode).toBe(1);
        expect(stderr).toContain(fixtureCase.code);
        expect(existsSync(join(repo, '.genie'))).toBe(false);
      }

      expect(() => openDb({ path: dbPath })).toThrow(fixtureCase.error);
      expect(() => openReadonlyHandle(dbPath)).toThrow(fixtureCase.error);
      expect(() => writeSnapshotFile(roadmap, { forbidden: true })).toThrow(fixtureCase.error);

      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
      expect(existsSync(roadmap)).toBe(false);
      expect(existsSync(`${roadmap}.${process.pid}.tmp`)).toBe(false);
      expect(existsSync(join(repo, '.genie'))).toBe(false);
    });
  }

  test('the shipped SessionStart hook never opens genie.db under Orca authority (no -wal/-shm, no task injection)', async () => {
    // Build a real standalone genie.db first, then hand authority to Orca.
    const root = authorityFixture({ orchestration: { mode: 'standalone' } });
    const repo = join(root, 'repo');
    mkdirSync(repo);
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
    openDb({ cwd: repo }).close();
    const dbDir = join(repo, '.genie');
    expect(existsSync(join(dbDir, 'genie.db'))).toBe(true);
    for (const sidecar of ['genie.db-wal', 'genie.db-shm']) rmSync(join(dbDir, sidecar), { force: true });
    const hook = join(import.meta.dir, '..', '..', '..', 'plugins', 'genie', 'scripts', 'session-context.cjs');

    const run = async (config: string) => {
      writeFileSync(join(process.env.GENIE_HOME as string, 'config.json'), config);
      const proc = Bun.spawn(['node', hook], {
        cwd: repo,
        env: { ...process.env, GENIE_HOME: process.env.GENIE_HOME as string },
        stdin: new Response(JSON.stringify({ cwd: repo })).body ?? undefined,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { exitCode, stdout, stderr, sidecars: readdirSync(dbDir).filter((name) => name.startsWith('genie.db-')) };
    };

    const orca = await run(JSON.stringify({ orchestration: { mode: 'orca' } }));
    expect(orca.exitCode).toBe(0);
    expect(orca.stderr).toContain('Orca is the selected lifecycle authority');
    expect(orca.sidecars).toEqual([]);

    // Every shape the CLI's strict schema rejects fails closed here too —
    // never a guess, and never a fail-open divergence between the two readers.
    for (const config of [
      '{ not json',
      JSON.stringify({ orchestration: {} }),
      JSON.stringify({ orchestration: { mode: 'standalone', extra: 1 } }),
      JSON.stringify({ orchestration: { mode: 'kraken' } }),
      JSON.stringify({ orchestration: null }),
      JSON.stringify([]),
    ]) {
      const invalid = await run(config);
      expect(invalid.exitCode, config).toBe(0);
      expect(invalid.stderr, config).toContain('orchestration authority config is unreadable');
      expect(invalid.sidecars, config).toEqual([]);
    }

    // And the shapes the CLI accepts as standalone still open the database.
    for (const config of [JSON.stringify({}), JSON.stringify({ orchestration: { mode: 'standalone' } })]) {
      const standalone = await run(config);
      expect(standalone.exitCode, config).toBe(0);
      expect(standalone.stderr, config).not.toContain('not opened');
    }
  });
});
