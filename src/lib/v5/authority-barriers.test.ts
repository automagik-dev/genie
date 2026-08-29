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
import { LocalLifecycleDisabledError } from '../orchestration-mode.js';
import { openDb } from './genie-db.js';
import { openReadonlyDb } from './mcp-tools.js';
import { writeSnapshotFile } from './roadmap-sync.js';

const originalGenieHome = process.env.GENIE_HOME;
const roots: string[] = [];
const GENIE = join(import.meta.dir, '..', '..', 'genie.ts');

function orcaFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-authority-barrier-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ orchestration: { mode: 'orca' } }));
  process.env.GENIE_HOME = home;
  return root;
}

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
    expect(() => openReadonlyDb(join(root, 'repo'))).toThrow(LocalLifecycleDisabledError);

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
});
