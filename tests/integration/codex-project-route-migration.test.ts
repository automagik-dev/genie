/**
 * Two-repository Codex project-route migration (Group A, D7 + acceptance).
 *
 * After the global plugin MCP route disappears (the Codex plugin ships none),
 * an untouched repository has an EXPLICITLY ABSENT project route and NO fallback:
 * `genie mcp` launched there fails closed with `project-database-unavailable`
 * rather than serving an outer/cache-root empty board or another repo's state.
 * The single reconciliation command is `cd <repo> && genie init`, which creates
 * only that repo's marker-owned route. Afterward each repo returns ONLY its own
 * unique seeded sentinel.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/lib/v5/genie-db.js';
import { createBoard, createTask, createWishGroups } from '../../src/lib/v5/task-state.js';

const GENIE = join(import.meta.dir, '..', '..', 'src', 'genie.ts');

let base: string;
let genieHome: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e.com',
    },
  });
}

function initRepo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'commit', '--allow-empty', '-m', 'init');
  return dir;
}

function runInit(cwd: string): { code: number; stderr: string } {
  const res = Bun.spawnSync([process.execPath, GENIE, 'init'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // No Codex CLI on PATH + isolated GENIE_HOME: the marker route is plugin-independent.
    env: { ...process.env, PATH: '/usr/bin:/bin', GENIE_HOME: genieHome },
  });
  return { code: res.exitCode, stderr: res.stderr.toString() };
}

/** Seed a repo's db with a UNIQUE sentinel wish so cross-repo bleed is detectable. */
function seedSentinel(repo: string, sentinel: string): void {
  const db = openDb({ cwd: repo });
  const board = createBoard(db, 'repo');
  createTask(db, { title: `task-${sentinel}`, boardId: board.id, wish: sentinel, group: 'g' });
  createWishGroups(db, sentinel, [{ name: 'g' }]);
  db.close();
}

interface RpcResponse {
  id: number | string | null;
  result?: { content?: Array<{ text: string }>; isError?: boolean };
}

async function driveBoard(cwd: string): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const proc = Bun.spawn(['bun', GENIE, 'mcp'], {
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' },
  });
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'genie_board', arguments: {} } },
  ];
  proc.stdin.write(`${requests.map((r) => JSON.stringify(r)).join('\n')}\n`);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  const responses = stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RpcResponse);
  const res = responses.find((r) => r.id === 2);
  if (!res?.result) throw new Error(`no tools/call result: ${stdout}`);
  return { isError: res.result.isError === true, payload: JSON.parse(res.result.content?.[0]?.text ?? '{}') };
}

const markerPath = (repo: string) => join(repo, '.codex', 'config.toml');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'genie-migrate-'));
  genieHome = join(base, 'genie-home');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('two-repo Codex project-route migration', () => {
  test('reconciled A serves only A; untouched B fails closed; `cd B && genie init` reconciles only B', async () => {
    const repoA = initRepo('repoA');
    const repoB = initRepo('repoB');

    // --- A: reconcile the marker-owned route and seed A's unique sentinel. ---
    expect(runInit(repoA).code).toBe(0);
    const tomlA = readFileSync(markerPath(repoA), 'utf8');
    expect(tomlA).toContain('# BEGIN GENIE MCP FALLBACK');
    expect(tomlA).toContain(`${join(genieHome, 'bin', 'genie')}`); // stable facade, not a cache path
    expect(existsSync(join(repoA, '.mcp.json'))).toBe(true); // Claude/Warp route from init
    seedSentinel(repoA, 'alpha-sentinel');

    const aBoard = await driveBoard(repoA);
    expect(aBoard.isError).toBe(false);
    expect((aBoard.payload.tasks as Array<{ wish: string }>).some((t) => t.wish === 'alpha-sentinel')).toBe(true);

    // --- B untouched: no project route, no fallback, fails closed (no A bleed). ---
    expect(existsSync(markerPath(repoB))).toBe(false); // explicitly absent project route
    expect(existsSync(join(repoB, '.mcp.json'))).toBe(false);
    const bBefore = await driveBoard(repoB);
    expect(bBefore.isError).toBe(true);
    expect(bBefore.payload.error).toBe('project-database-unavailable');
    // Critically: B never returns A's sentinel nor a healthy empty board.
    expect(JSON.stringify(bBefore.payload)).not.toContain('alpha-sentinel');
    expect(bBefore.payload).not.toHaveProperty('counts');

    // --- `cd B && genie init` reconciles ONLY B; A is untouched. ---
    expect(runInit(repoB).code).toBe(0);
    expect(existsSync(markerPath(repoB))).toBe(true);
    expect(readFileSync(markerPath(repoB), 'utf8')).toContain(`${join(genieHome, 'bin', 'genie')}`);
    seedSentinel(repoB, 'bravo-sentinel');

    const bAfter = await driveBoard(repoB);
    expect(bAfter.isError).toBe(false);
    const bWishes = (bAfter.payload.tasks as Array<{ wish: string }>).map((t) => t.wish);
    expect(bWishes).toContain('bravo-sentinel');
    expect(bWishes).not.toContain('alpha-sentinel'); // B returns ONLY B's sentinel

    // A still serves only A after B's reconciliation.
    const aAgain = await driveBoard(repoA);
    const aWishes = (aAgain.payload.tasks as Array<{ wish: string }>).map((t) => t.wish);
    expect(aWishes).toContain('alpha-sentinel');
    expect(aWishes).not.toContain('bravo-sentinel');
  });

  test('an untouched repo with no genie.db never serializes a healthy empty board', async () => {
    const repo = initRepo('lonely');
    // No init, no db. The read server must refuse rather than masquerade as empty.
    const board = await driveBoard(repo);
    expect(board.isError).toBe(true);
    expect(board.payload.error).toBe('project-database-unavailable');
    expect(board.payload.detail).toContain('genie init');
  });
});
