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
import {
  InvalidOrchestrationAuthorityError,
  LocalLifecycleDisabledError,
  ORCA_INVALID_AUTHORITY_MESSAGE,
  ORCA_REFUSAL_MESSAGE,
} from '../orchestration-mode.js';
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
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      // AMENDED (owner decision 2026-09-19): the refusal is no longer the
      // internal typed-error code leaking through the generic `Error:` printer
      // at exit 1. It is the `ORCA_FORBIDDEN` gate in `src/genie.ts`: one fixed
      // operator-facing line naming the remedy, at exit 2 — genie's "the
      // operator must act" family, the same one the v4 workspace gate and
      // `mikro call`'s usage refusals use.
      expect(exitCode).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toBe(`${ORCA_REFUSAL_MESSAGE}\n`);
      expect(existsSync(join(repo, '.genie'))).toBe(false);
    }
  });

  test('`task sync` is the one carve-out: exit 0, both streams empty, no repository state', async () => {
    // The git hooks run `task sync` on every commit, merge and rewrite. In orca
    // mode there is no board and no snapshot to reconcile, so it says nothing
    // at all — anything else printed `board snapshot not refreshed` on every
    // single commit. This fixture has NO `.genie`, which is the harder half:
    // the orca check sits ahead of the workspace guard in `handleSync`.
    const root = orcaFixture();
    const repo = join(root, 'repo');
    mkdirSync(repo);

    const proc = Bun.spawn(['bun', GENIE, 'task', 'sync'], {
      cwd: repo,
      env: { ...process.env, GENIE_HOME: process.env.GENIE_HOME as string, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(existsSync(join(repo, '.genie'))).toBe(false);
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
      // Orca WAS read successfully here — the invalid field is unrelated — so
      // this case keeps the orca line. Only the four below are unparseable.
      message: ORCA_REFUSAL_MESSAGE,
    },
    {
      name: 'malformed authority field',
      config: { orchestration: { mode: 'automatic' } },
      error: InvalidOrchestrationAuthorityError,
      code: 'invalid_orchestration_authority',
      message: ORCA_INVALID_AUTHORITY_MESSAGE,
    },
    {
      name: 'missing authority mode',
      config: { orchestration: {} },
      error: InvalidOrchestrationAuthorityError,
      code: 'invalid_orchestration_authority',
      message: ORCA_INVALID_AUTHORITY_MESSAGE,
    },
    {
      name: 'misspelled authority field',
      config: { orchestration: { mod: 'orca' } },
      error: InvalidOrchestrationAuthorityError,
      code: 'invalid_orchestration_authority',
      message: ORCA_INVALID_AUTHORITY_MESSAGE,
    },
    {
      name: 'extra authority field',
      config: { orchestration: { mode: 'orca', extra: true } },
      error: InvalidOrchestrationAuthorityError,
      code: 'invalid_orchestration_authority',
      message: ORCA_INVALID_AUTHORITY_MESSAGE,
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
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        // AMENDED (owner decision 2026-09-19): an authority genie cannot parse
        // proves nothing — least of all standalone — so the CLI gate fails
        // closed at the same exit 2 as explicit orca. It gets its OWN line,
        // though: claiming "orca is the lifecycle authority" about a config
        // that was never successfully read is a claim genie cannot support,
        // and it sent an operator with a corrupt `config.json` hunting for an
        // Orca install that need not exist. The typed codes below are still the
        // low-level contract.
        expect(exitCode).toBe(2);
        expect(stdout).toBe('');
        expect(stderr).toBe(`${fixtureCase.message}\n`);
        expect(existsSync(join(repo, '.genie'))).toBe(false);
      }

      expect(() => openDb({ path: dbPath })).toThrow(fixtureCase.error);
      expect(() => openReadonlyHandle(dbPath)).toThrow(fixtureCase.error);
      expect(() => writeSnapshotFile(roadmap, { forbidden: true })).toThrow(fixtureCase.error);
      // The operator-facing line is one fixed sentence, but the low-level
      // barriers keep their own stable machine-readable code.
      try {
        openDb({ path: dbPath });
        throw new Error('expected the authority barrier to throw');
      } catch (error) {
        expect((error as { code?: string }).code).toBe(fixtureCase.code);
      }

      expect(existsSync(dbPath)).toBe(false);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
      expect(existsSync(roadmap)).toBe(false);
      expect(existsSync(`${roadmap}.${process.pid}.tmp`)).toBe(false);
      expect(existsSync(join(repo, '.genie'))).toBe(false);
    });
  }
});
