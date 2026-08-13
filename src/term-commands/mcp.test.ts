/**
 * genie mcp — CLI-level tests. Drives the real `genie.ts mcp` stdio server as a
 * subprocess (as an MCP client would), speaking newline-delimited JSON-RPC 2.0,
 * against throwaway git-repo fixtures seeded via the real v5 state layer.
 *
 * Also asserts the LAZY-LOAD contract with a static import-graph probe: the
 * `bun:sqlite` opens in `mcp-tools.ts` must NOT be reachable from `genie.ts`
 * except through the dynamic `import()` inside the `mcp` action.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { openDb, resolveDbPath } from '../lib/v5/genie-db.js';
import { DEFAULT_LIFECYCLE_LANES, createBoard, createTask, getTaskEvents, getTaskLane } from '../lib/v5/task-state.js';

const GENIE = join(import.meta.dir, '..', 'genie.ts');
const SRC_ROOT = resolve(import.meta.dir, '..');

// ============================================================================
// Fixtures
// ============================================================================

let repo: string;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'genie-mcp-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// ============================================================================
// JSON-RPC driver — write all requests, close stdin, collect response lines.
// ============================================================================

interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function driveMcp(cwd: string, requests: Record<string, unknown>[]): Promise<RpcResponse[]> {
  const proc = Bun.spawn(['bun', GENIE, 'mcp'], {
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' },
  });
  const payload = `${requests.map((r) => JSON.stringify(r)).join('\n')}\n`;
  proc.stdin.write(payload);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RpcResponse);
}

/** Like driveMcp but sends raw (already-serialized) lines — for malformed input. */
async function driveMcpRaw(cwd: string, rawLines: string[]): Promise<RpcResponse[]> {
  const proc = Bun.spawn(['bun', GENIE, 'mcp'], {
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' },
  });
  proc.stdin.write(`${rawLines.join('\n')}\n`);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RpcResponse);
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

/** Parse the JSON text payload out of a tools/call result envelope. */
function toolPayload<T>(res: RpcResponse): T {
  const content = (res.result?.content as Array<{ type: string; text: string }>) ?? [];
  return JSON.parse(content[0].text) as T;
}

function seed(cwd: string): { taskId: string } {
  const db = openDb({ cwd });
  const board = createBoard(db, 'repo');
  const t = createTask(db, { title: 'seed task', boardId: board.id, wish: 'genie-mcp', group: 'g2' });
  createTask(db, { title: 'other', boardId: board.id });
  // Fold pending WAL frames into the main db before the reader subprocess opens,
  // so the `genie mcp` server isn't racing an open WAL writer under
  // cross-file test contention ("database is locked").
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return { taskId: t.id };
}

function fileContentHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ============================================================================
// Handshake
// ============================================================================

describe('mcp handshake', () => {
  test('a bare `null` / primitive line is dropped and does not crash the server', async () => {
    // `JSON.parse('null')` is valid JSON but not a JSON-RPC object; without the
    // non-object guard, dispatch(null) throws on null.id and the server crashes.
    const res = await driveMcpRaw(repo, ['null', '5', 'true', '"str"', JSON.stringify(INIT)]);
    // The malformed lines are silently dropped; the server survives + answers initialize.
    expect(res.some((r) => r.id === 1 && (r.result as { serverInfo?: unknown })?.serverInfo)).toBe(true);
  });

  test('initialize replies with protocolVersion, tools capability, and serverInfo', async () => {
    const [res] = await driveMcp(repo, [INIT]);
    expect(res.id).toBe(1);
    expect(res.result?.protocolVersion).toBe('2024-11-05');
    expect(res.result?.capabilities).toEqual({ tools: {} });
    const serverInfo = res.result?.serverInfo as { name: string; version: string };
    expect(serverInfo.name).toBe('genie');
    expect(typeof serverInfo.version).toBe('string');
  });

  test('notifications/initialized gets NO reply', async () => {
    // Two ids (init, ping) + the notification → exactly two responses.
    const responses = await driveMcp(repo, [INIT, INITIALIZED, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
    expect(responses.map((r) => r.id)).toEqual([1, 2]);
  });

  test('unknown method with an id → JSON-RPC -32601', async () => {
    const responses = await driveMcp(repo, [INIT, { jsonrpc: '2.0', id: 9, method: 'bogus/method' }]);
    const bogus = responses.find((r) => r.id === 9);
    expect(bogus?.error?.code).toBe(-32601);
  });
});

// ============================================================================
// tools/list
// ============================================================================

describe('mcp tools/list', () => {
  test('lists exactly the 5 read tools + 12 write tools with input schemas', async () => {
    const responses = await driveMcp(repo, [INIT, INITIALIZED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const list = responses.find((r) => r.id === 2);
    const tools = list?.result?.tools as Array<{ name: string; inputSchema: unknown }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'genie_active',
      'genie_board',
      'genie_task',
      'genie_task_add_dependency',
      'genie_task_block',
      'genie_task_checkout',
      'genie_task_comment',
      'genie_task_create',
      'genie_task_done',
      'genie_task_heartbeat',
      'genie_task_move',
      'genie_task_release',
      'genie_task_report',
      'genie_task_set_wish',
      'genie_task_unblock',
      'genie_wish_status',
      'genie_worktree_context',
    ]);
    for (const t of tools) expect(t.inputSchema).toBeDefined();
  });
});

// ============================================================================
// tools/call — real state
// ============================================================================

describe('mcp tools/call', () => {
  test('genie_board reflects real seeded db state', async () => {
    seed(repo);
    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'genie_board', arguments: {} } },
    ]);
    const res = responses.find((r) => r.id === 3);
    expect(res?.result?.isError).toBe(false);
    const payload = toolPayload<{ counts: { total: number; ready: number }; tasks: Array<{ wish: string }> }>(res!);
    expect(payload.counts.total).toBe(2);
    expect(payload.counts.ready).toBe(2);
    expect(payload.tasks.some((t) => t.wish === 'genie-mcp')).toBe(true);
  });

  test('genie_board stays read-only with a divergent sync-owned card in an immutable database', async () => {
    const wishDir = join(repo, '.genie', 'wishes', 'mcp-read-only');
    mkdirSync(wishDir, { recursive: true });
    writeFileSync(join(wishDir, 'WISH.md'), '| **Status** | DONE |\n');

    const dbPath = resolveDbPath(repo);
    const sqlitePaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    const stateDir = dirname(dbPath);
    const db = openDb({ cwd: repo });
    const originalModes = new Map<string, number>();
    const mutatedModes = new Set<string>();
    const beforeHashes = new Map<string, string>();
    const cleanupErrors: unknown[] = [];
    let testError: unknown;

    try {
      const roadmap = createBoard(db, 'roadmap', DEFAULT_LIFECYCLE_LANES);
      const task = createTask(db, {
        title: 'divergent sync-owned card',
        boardId: roadmap.id,
        lane: 'Idea',
        wish: 'mcp-read-only',
      });
      expect(getTaskLane(db, task.id)).toBe('Idea');
      expect(getTaskEvents(db, task.id)).toHaveLength(0);

      for (const path of sqlitePaths) {
        expect(existsSync(path)).toBe(true);
        beforeHashes.set(path, fileContentHash(path));
        originalModes.set(path, statSync(path).mode & 0o777);
        mutatedModes.add(path);
        chmodSync(path, 0o444);
        expect(statSync(path).mode & 0o777).toBe(0o444);
      }
      originalModes.set(stateDir, statSync(stateDir).mode & 0o777);
      mutatedModes.add(stateDir);
      chmodSync(stateDir, 0o555);
      expect(statSync(stateDir).mode & 0o777).toBe(0o555);

      const responses = await driveMcp(repo, [
        INIT,
        INITIALIZED,
        { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'genie_board', arguments: {} } },
      ]);

      const response = responses.find((entry) => entry.id === 31);
      expect(response?.result?.isError).toBe(false);
      const payload = toolPayload<{ tasks: Array<{ id: string; wish: string }> }>(response!);
      expect(payload.tasks).toContainEqual(expect.objectContaining({ id: task.id, wish: 'mcp-read-only' }));
      expect(getTaskLane(db, task.id)).toBe('Idea');
      expect(getTaskEvents(db, task.id)).toHaveLength(0);

      for (const path of sqlitePaths) {
        expect(existsSync(path)).toBe(true);
        expect(fileContentHash(path)).toBe(beforeHashes.get(path)!);
      }
    } catch (error) {
      testError = error;
    } finally {
      for (const path of [stateDir, ...sqlitePaths]) {
        if (!mutatedModes.has(path)) continue;
        try {
          chmodSync(path, originalModes.get(path)!);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        db.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (testError !== undefined && cleanupErrors.length > 0) {
      throw new AggregateError([testError, ...cleanupErrors], 'MCP proof failed and fixture cleanup was incomplete');
    }
    if (testError !== undefined) throw testError;
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Failed to restore immutable SQLite fixture');
  });

  test('genie_wish_status returns a literal empty groups array plus the wish tasks', async () => {
    seed(repo);
    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'genie_wish_status', arguments: { wish: 'genie-mcp' } },
      },
    ]);
    const payload = toolPayload<{ wish: string; groups: Array<{ name: string; status: string; dependsOn: string[] }> }>(
      responses.find((r) => r.id === 4)!,
    );
    expect(payload.wish).toBe('genie-mcp');
    // Wish-group machinery is production-dead — groups is a hardcoded [].
    expect(payload.groups).toEqual([]);
  });

  test('genie_task returns full detail by id, or not_found', async () => {
    const { taskId } = seed(repo);
    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'genie_task', arguments: { id: taskId } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'genie_task', arguments: { id: 't_nope' } } },
    ]);
    const found = toolPayload<{ id: string; title: string }>(responses.find((r) => r.id === 5)!);
    expect(found.id).toBe(taskId);
    expect(found.title).toBe('seed task');
    const missingRes = responses.find((r) => r.id === 6)!;
    // An `error`-keyed payload is DATA, not the error channel: stays isError false.
    expect(missingRes.result?.isError).toBe(false);
    const missing = toolPayload<{ error: string; id: string }>(missingRes);
    expect(missing).toEqual({ error: 'not_found', id: 't_nope' });
  });

  test('genie_worktree_context resolves a wish/<slug>-<group> branch', async () => {
    seed(repo);
    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'genie_worktree_context', arguments: { branch: 'wish/genie-mcp-g2' } },
      },
    ]);
    const payload = toolPayload<{ resolved: boolean; wish: string; group: string; tasks: Array<{ group: string }> }>(
      responses.find((r) => r.id === 7)!,
    );
    expect(payload.resolved).toBe(true);
    expect(payload.wish).toBe('genie-mcp');
    expect(payload.group).toBe('g2');
    expect(payload.tasks.every((t) => t.group === 'g2')).toBe(true);
  });

  test('genie_worktree_context falls back to unresolved on a non-wish branch', async () => {
    seed(repo);
    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'genie_worktree_context', arguments: { branch: 'main' } },
      },
    ]);
    const payload = toolPayload<{ resolved: boolean; wish: null; tasks: unknown[] }>(
      responses.find((r) => r.id === 8)!,
    );
    expect(payload.resolved).toBe(false);
    expect(payload.wish).toBeNull();
    expect(payload.tasks.length).toBe(2); // repo-board fallback: all tasks
  });

  test('genie_active lists in-progress tasks with claimant', async () => {
    const { taskId } = seed(repo);
    // Claim the seed task so it becomes in_progress.
    const db = openDb({ cwd: repo });
    db.query("UPDATE tasks SET status='in_progress', claimed_by='worker-1', claimed_at=? WHERE id=?").run(
      Date.now(),
      taskId,
    );
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'genie_active', arguments: {} } },
    ]);
    const payload = toolPayload<{ tasks: Array<{ id: string; claimedBy: string; status: string }> }>(
      responses.find((r) => r.id === 10)!,
    );
    expect(payload.tasks).toHaveLength(1);
    expect(payload.tasks[0].id).toBe(taskId);
    expect(payload.tasks[0].claimedBy).toBe('worker-1');
    expect(payload.tasks[0].status).toBe('in_progress');
  });

  test('unknown tool name → isError result (not a protocol error)', async () => {
    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'genie_nope', arguments: {} } },
    ]);
    const res = responses.find((r) => r.id === 11);
    expect(res?.error).toBeUndefined();
    expect(res?.result?.isError).toBe(true);
    const payload = toolPayload<{ error: string; name: string }>(res!);
    expect(payload).toEqual({ error: 'unknown_tool', name: 'genie_nope' });
  });
});

// ============================================================================
// Backward-compat: the runtime layer is additive-only over the MCP surface
// ============================================================================

describe('mcp runtime-layer backward compatibility', () => {
  test('genie_task keeps the frozen TaskRow shape — no runtime/lane fields leak', async () => {
    const { taskId } = seed(repo);
    // Add runtime state (block + claim) and a declared routing so a leak would
    // actually surface if any.
    const db = openDb({ cwd: repo });
    db.query(
      "UPDATE tasks SET blocked_by='x', blocked_reason='r', heartbeat_at=1, agent_kind='codex', lane='Idea', assigned_agent='codex', assigned_reason='routed' WHERE id=?",
    ).run(taskId);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();

    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'genie_task', arguments: { id: taskId } } },
    ]);
    const task = toolPayload<Record<string, unknown>>(responses.find((r) => r.id === 40)!);
    // The projection is byte-frozen: exactly the pre-assignment TaskRow keys.
    expect(Object.keys(task).sort()).toEqual([
      'boardId',
      'claimedAt',
      'claimedBy',
      'createdAt',
      'group',
      'id',
      'status',
      'title',
      'updatedAt',
      'wish',
    ]);
    for (const leaked of [
      'lane',
      'agentKind',
      'heartbeatAt',
      'blockedBy',
      'blockedReason',
      'assignedAgent',
      'assignedReason',
    ]) {
      expect(leaked in task).toBe(false);
    }
  });

  test('genie_board task summaries carry no runtime fields', async () => {
    seed(repo);
    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'genie_board', arguments: {} } },
    ]);
    const payload = toolPayload<{ tasks: Array<Record<string, unknown>> }>(responses.find((r) => r.id === 41)!);
    expect(payload.tasks.length).toBeGreaterThan(0);
    for (const summary of payload.tasks) {
      for (const leaked of ['lane', 'agentKind', 'heartbeatAt', 'blockedBy', 'blockedReason']) {
        expect(leaked in summary).toBe(false);
      }
    }
  });
});

// ============================================================================
// Fail-closed: a missing genie.db is a typed error, never an empty board
// ============================================================================

describe('mcp missing-database fail-closed', () => {
  function seedRawDatabase(sql: string): string {
    const dbPath = join(repo, '.genie', 'genie.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(sql);
    db.close();
    return dbPath;
  }

  async function expectProjectDatabaseUnavailable(id: number): Promise<{ error: string; detail: string }> {
    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'genie_board', arguments: {} } },
    ]);
    const response = responses.find((candidate) => candidate.id === id);
    expect(response?.error).toBeUndefined();
    expect(response?.result?.isError).toBe(true);
    const payload = toolPayload<{ error: string; detail: string }>(response!);
    expect(payload.error).toBe('project-database-unavailable');
    expect(payload.detail).toContain(join(repo, '.genie', 'genie.db'));
    expect(payload).not.toHaveProperty('counts');
    expect(payload).not.toHaveProperty('tasks');
    return payload;
  }

  test('genie_board on a git repo with no genie.db returns project-database-unavailable, not empty success', async () => {
    // Fresh git repo, never seeded → no .genie/genie.db. The old behavior served
    // a healthy-looking empty board (the masquerade); Group A returns a typed error.
    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'genie_board', arguments: {} } },
    ]);
    const res = responses.find((r) => r.id === 12);
    expect(res?.result?.isError).toBe(true);
    const payload = toolPayload<{ error: string; detail: string }>(res!);
    expect(payload.error).toBe('project-database-unavailable');
    // The error names the exact storage-root DB candidate, never a cache path.
    expect(payload.detail).toContain('.genie/genie.db');
    expect(payload).not.toHaveProperty('counts');
    expect(payload).not.toHaveProperty('tasks');
  });

  test('every read tool fails closed identically when the database is absent', async () => {
    const calls = [
      { id: 13, name: 'genie_board', arguments: {} },
      { id: 14, name: 'genie_wish_status', arguments: { wish: 'x' } },
      { id: 15, name: 'genie_worktree_context', arguments: { branch: 'main' } },
      { id: 16, name: 'genie_task', arguments: { id: 't_1' } },
      { id: 17, name: 'genie_active', arguments: {} },
    ];
    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      ...calls.map((c) => ({
        jsonrpc: '2.0',
        id: c.id,
        method: 'tools/call',
        params: { name: c.name, arguments: c.arguments },
      })),
    ]);
    for (const c of calls) {
      const res = responses.find((r) => r.id === c.id);
      expect(res?.result?.isError).toBe(true);
      expect(toolPayload<{ error: string }>(res!).error).toBe('project-database-unavailable');
    }
  });

  for (const fixture of ['directory', 'malformed-file'] as const) {
    test(`genie_board fails closed when genie.db is an existing ${fixture}`, async () => {
      const dbPath = join(repo, '.genie', 'genie.db');
      mkdirSync(join(repo, '.genie'), { recursive: true });
      if (fixture === 'directory') mkdirSync(dbPath);
      else writeFileSync(dbPath, 'not a sqlite database');

      const responses = await driveMcp(repo, [
        INIT,
        INITIALIZED,
        { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'genie_board', arguments: {} } },
      ]);
      const res = responses.find((response) => response.id === 18);
      expect(res?.result?.isError).toBe(true);
      const payload = toolPayload<{ error: string; detail: string }>(res!);
      expect(payload.error).toBe('project-database-unavailable');
      expect(payload.detail).toContain(dbPath);
      expect(payload).not.toHaveProperty('counts');
      expect(payload).not.toHaveProperty('tasks');
    });
  }

  for (const alias of ['genie-directory', 'database-file'] as const) {
    test(`genie_board rejects a ${alias} symlink to another valid repository database`, async () => {
      const other = mkdtempSync(join(tmpdir(), 'genie-mcp-alias-'));
      git(other, 'init', '-b', 'main');
      git(other, 'commit', '--allow-empty', '-m', 'init');
      seed(other);
      try {
        if (alias === 'genie-directory') {
          symlinkSync(join(other, '.genie'), join(repo, '.genie'), 'dir');
        } else {
          mkdirSync(join(repo, '.genie'));
          symlinkSync(join(other, '.genie', 'genie.db'), join(repo, '.genie', 'genie.db'), 'file');
        }

        const payload = await expectProjectDatabaseUnavailable(alias === 'genie-directory' ? 51 : 52);
        expect(payload.detail).toContain(alias === 'genie-directory' ? 'physical directory' : 'physical regular file');
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  }

  test('rejects a foreign-version database with a lookalike tasks table instead of exposing its rows', async () => {
    seedRawDatabase(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        board_id TEXT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        claimed_by TEXT,
        claimed_at INTEGER,
        wish TEXT,
        group_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO tasks VALUES ('foreign', NULL, 'attacker row', 'ready', NULL, NULL, NULL, NULL, 1, 1);
      PRAGMA user_version = 99;
    `);

    await expectProjectDatabaseUnavailable(50);
  });

  test('rejects a user_version=0 foreign SQLite database as a structured project database error', async () => {
    seedRawDatabase(
      "CREATE TABLE inventory (id TEXT PRIMARY KEY, secret TEXT); INSERT INTO inventory VALUES ('x', 'y')",
    );

    await expectProjectDatabaseUnavailable(51);
  });

  test('rejects a current-version database whose required Genie schema is incomplete', async () => {
    seedRawDatabase(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
      PRAGMA user_version = 1;
    `);

    await expectProjectDatabaseUnavailable(52);
  });

  test('reopens a genuine current db created AFTER the server started (no stale empty board)', async () => {
    // Server starts against a repo with no genie.db (null handle), THEN the db
    // is created mid-session — a per-call reopen must pick it up, not serve empty.
    const proc = Bun.spawn(['bun', GENIE, 'mcp'], {
      cwd: repo,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' },
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let out = '';
    // Synchronize: wait for the initialize reply BEFORE seeding, which proves the
    // server's startup open already ran against an absent db (null) —
    // otherwise the test could seed first and pass without exercising the reopen.
    proc.stdin.write(`${JSON.stringify(INIT)}\n`);
    while (!out.includes('"serverInfo"')) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    seed(repo); // create .genie/genie.db + tasks AFTER the startup open saw nothing
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'genie_board', arguments: {} } })}\n`,
    );
    await proc.stdin.end();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    await proc.exited;
    const responses = out
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as RpcResponse);
    const res = responses.find((r) => r.id === 20);
    expect(res?.result?.isError).toBe(false);
    const payload = toolPayload<{ counts: { total: number } }>(res!);
    expect(payload.counts.total).toBeGreaterThan(0); // saw the db created mid-session
  });
});

// ============================================================================
// Write-capable open (Group 1 of wish mcp-write-tools): the server now serves
// against the hardened write path; the no-create and degrade guarantees hold.
// ============================================================================

describe('mcp write-capable open', () => {
  test('outside a git repo, tool calls fail closed and create neither .genie/ nor genie.db', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'genie-mcp-nonrepo-'));
    try {
      const responses = await driveMcp(plain, [
        INIT,
        INITIALIZED,
        { jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'genie_board', arguments: {} } },
      ]);
      const res = responses.find((r) => r.id === 19);
      expect(res?.error).toBeUndefined();
      expect(res?.result?.isError).toBe(true);
      const payload = toolPayload<{ error: string }>(res!);
      expect(payload.error).toBe('project-context-unavailable');
      // Resolver ordering (Decision 5): a non-ok context never reaches the
      // write open, so no file or directory is created.
      expect(existsSync(join(plain, '.genie'))).toBe(false);
      expect(existsSync(join(plain, 'genie.db'))).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test('on a write-protected fully-current db, all 5 read tools serve (strict validator intact)', async () => {
    const { taskId } = seed(repo);
    const dbPath = resolveDbPath(repo);
    const sqlitePaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
    const stateDir = dirname(dbPath);
    const originalModes = new Map<string, number>();
    const mutatedModes = new Set<string>();
    const cleanupErrors: unknown[] = [];
    let testError: unknown;

    try {
      for (const path of sqlitePaths) {
        if (!existsSync(path)) continue;
        originalModes.set(path, statSync(path).mode & 0o777);
        mutatedModes.add(path);
        chmodSync(path, 0o444);
      }
      originalModes.set(stateDir, statSync(stateDir).mode & 0o777);
      mutatedModes.add(stateDir);
      chmodSync(stateDir, 0o555);

      const calls = [
        { id: 21, name: 'genie_board', arguments: {} },
        { id: 22, name: 'genie_wish_status', arguments: { wish: 'genie-mcp' } },
        { id: 23, name: 'genie_worktree_context', arguments: { branch: 'main' } },
        { id: 24, name: 'genie_task', arguments: { id: taskId } },
        { id: 25, name: 'genie_active', arguments: {} },
      ];
      const responses = await driveMcp(repo, [
        INIT,
        INITIALIZED,
        ...calls.map((c) => ({
          jsonrpc: '2.0',
          id: c.id,
          method: 'tools/call',
          params: { name: c.name, arguments: c.arguments },
        })),
      ]);
      for (const c of calls) {
        const res = responses.find((r) => r.id === c.id);
        expect(res?.error).toBeUndefined();
        expect(res?.result?.isError).toBe(false);
        expect(toolPayload<Record<string, unknown>>(res!)).not.toHaveProperty('error');
      }
      const board = toolPayload<{ counts: { total: number } }>(responses.find((r) => r.id === 21)!);
      expect(board.counts.total).toBe(2); // the fully-current db's real state
    } catch (error) {
      testError = error;
    } finally {
      for (const path of [stateDir, ...sqlitePaths]) {
        if (!mutatedModes.has(path)) continue;
        try {
          chmodSync(path, originalModes.get(path)!);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (testError !== undefined && cleanupErrors.length > 0) {
      throw new AggregateError([testError, ...cleanupErrors], 'MCP write-capable proof failed and cleanup incomplete');
    }
    if (testError !== undefined) throw testError;
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Failed to restore write-protected fixture');
  });
});
// ============================================================================
// E2e stdio round-trip (Group 3 of wish mcp-write-tools): ONE spawned `genie
// mcp` process serves a real client session — initialize → tools/list (5 read +
// 12 write) → create → checkout → done — and genie_board reflects the terminal
// state; a follow-up `genie task sync` publishes the card to the tracked
// .genie/roadmap.json snapshot.
// ============================================================================

describe('mcp e2e round-trip', () => {
  test('create → checkout → done lands on genie_board and task sync publishes the card', async () => {
    // Seed a current, empty db so the server opens against a healthy repo
    // (the round trip itself must create the card via the write tools).
    const db = openDb({ cwd: repo });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();

    const proc = Bun.spawn(['bun', GENIE, 'mcp'], {
      cwd: repo,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' },
    });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let out = '';
    const completed = (): RpcResponse[] =>
      out
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as RpcResponse);

    proc.stdin.write(`${JSON.stringify(INIT)}\n`);
    proc.stdin.write(`${JSON.stringify(INITIALIZED)}\n`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 71,
        method: 'tools/call',
        params: { name: 'genie_task_create', arguments: { title: 'e2e card', wish: 'mcp-e2e', group: 'g3' } },
      })}\n`,
    );
    // Read until the create response arrives; the server stays alive because
    // stdin is still open, so the rest of the round trip shares this session.
    while (!completed().some((r) => r.id === 71)) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    const created = completed().find((r) => r.id === 71);
    expect(created, 'genie_task_create response missing').toBeDefined();
    expect(created!.result?.isError).toBe(false);
    const taskId = toolPayload<{ task: { id: string; status: string } }>(created!).task.id;
    expect(toolPayload<{ task: { status: string } }>(created!).task.status).toBe('ready');

    // Same-session tools/list: 5 read + 12 write tools.
    const list = completed().find((r) => r.id === 2);
    expect(list, 'tools/list response missing').toBeDefined();
    const names = (list!.result?.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toHaveLength(17);
    const nameSet = new Set(names);
    for (const read of ['genie_board', 'genie_wish_status', 'genie_worktree_context', 'genie_task', 'genie_active']) {
      expect(nameSet.has(read)).toBe(true);
    }
    for (const write of [
      'genie_task_create',
      'genie_task_checkout',
      'genie_task_done',
      'genie_task_move',
      'genie_task_block',
      'genie_task_unblock',
      'genie_task_release',
      'genie_task_comment',
      'genie_task_report',
      'genie_task_heartbeat',
      'genie_task_set_wish',
      'genie_task_add_dependency',
    ]) {
      expect(nameSet.has(write)).toBe(true);
    }

    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 72,
        method: 'tools/call',
        params: { name: 'genie_task_checkout', arguments: { id: taskId, worker: 'g3-worker' } },
      })}\n`,
    );
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 73,
        method: 'tools/call',
        params: { name: 'genie_task_done', arguments: { id: taskId } },
      })}\n`,
    );
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 74, method: 'tools/call', params: { name: 'genie_board', arguments: {} } })}\n`,
    );
    await proc.stdin.end();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    await proc.exited;

    const checkout = completed().find((r) => r.id === 72)!;
    expect(checkout.result?.isError).toBe(false);
    expect(toolPayload<{ task: { status: string; claimedBy: string } }>(checkout).task).toMatchObject({
      status: 'in_progress',
      claimedBy: 'g3-worker',
    });

    const done = completed().find((r) => r.id === 73)!;
    expect(done.result?.isError).toBe(false);
    expect(toolPayload<{ task: { status: string } }>(done).task.status).toBe('done');

    const board = completed().find((r) => r.id === 74)!;
    expect(board.result?.isError).toBe(false);
    const boardPayload = toolPayload<{
      counts: Record<string, number>;
      tasks: Array<{ id: string; title: string; status: string; wish: string }>;
    }>(board);
    expect(boardPayload.counts).toEqual({ blocked: 0, ready: 0, in_progress: 0, done: 1, total: 1 });
    expect(boardPayload.tasks).toContainEqual(
      expect.objectContaining({ id: taskId, title: 'e2e card', status: 'done', wish: 'mcp-e2e' }),
    );

    // Follow-up: the CLI's snapshot publication path (also the husky hook) now
    // writes the card into the tracked .genie/roadmap.json.
    const genieHome = mkdtempSync(join(tmpdir(), 'genie-mcp-ghome-'));
    try {
      const sync = Bun.spawnSync(['bun', GENIE, 'task', 'sync'], {
        cwd: repo,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1', GENIE_HOME: genieHome },
      });
      expect(sync.exitCode, `task sync failed: ${sync.stderr.toString()}`).toBe(0);
      const roadmapPath = join(repo, '.genie', 'roadmap.json');
      expect(existsSync(roadmapPath)).toBe(true);
      const snapshot = JSON.parse(readFileSync(roadmapPath, 'utf-8')) as {
        tasks: Array<{ id: string; title: string; status: string }>;
      };
      expect(snapshot.tasks).toContainEqual(expect.objectContaining({ id: taskId, title: 'e2e card', status: 'done' }));
    } finally {
      rmSync(genieHome, { recursive: true, force: true });
    }
  });
});

describe('mcp worktree branch resolution', () => {
  test('disambiguates a hyphenated wish slug against known wishes', async () => {
    seed(repo); // wish 'genie-mcp' (slug has a hyphen), groups g1/g2, a task in g2
    // Top-level `wish/genie-mcp` must resolve to the genie-mcp wish (group null),
    // NOT a mis-split `genie` wish with an `mcp` group.
    const top = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      {
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: { name: 'genie_worktree_context', arguments: { branch: 'wish/genie-mcp' } },
      },
    ]);
    const topP = toolPayload<{ resolved: boolean; wish: string; group: string | null }>(top.find((r) => r.id === 30)!);
    expect(topP.resolved).toBe(true);
    expect(topP.wish).toBe('genie-mcp');
    expect(topP.group).toBeNull();

    // A group branch `wish/genie-mcp-g2` → genie-mcp / g2 (last-dash is correct here).
    const grp = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      {
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: { name: 'genie_worktree_context', arguments: { branch: 'wish/genie-mcp-g2' } },
      },
    ]);
    const grpP = toolPayload<{ wish: string; group: string | null }>(grp.find((r) => r.id === 31)!);
    expect(grpP.wish).toBe('genie-mcp');
    expect(grpP.group).toBe('g2');
  });

  test('an exact known slug wins when no live wish_groups can verify a launch worktree', async () => {
    // No wish-group rows exist (the machinery is production-dead), so a `genie`
    // wish with an `mcp` group AND a separate `genie-mcp` wish collide on
    // `wish/genie-mcp` — the exact known slug wins, group unverifiable (null).
    const db = openDb({ cwd: repo });
    const board = createBoard(db, 'repo');
    createTask(db, { title: 'a', boardId: board.id, wish: 'genie', group: 'mcp' });
    createTask(db, { title: 'b', boardId: board.id, wish: 'genie-mcp', group: 'g1' });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    const res = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      {
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: { name: 'genie_worktree_context', arguments: { branch: 'wish/genie-mcp' } },
      },
    ]);
    const p = toolPayload<{ wish: string; group: string | null }>(res.find((r) => r.id === 32)!);
    expect(p.wish).toBe('genie-mcp');
    expect(p.group).toBeNull();
  });
});

// ============================================================================
// Lazy-load probe — mcp-tools (the write-capable bun:sqlite open) must NOT be in the
// STATIC import graph reachable from genie.ts. It is only `await import`-ed
// inside the `mcp` action, so non-mcp paths (board/task/--help) never load it.
// ============================================================================

/** Value (non-type) static import/re-export specifiers in a source file. */
function staticValueImports(file: string): string[] {
  const src = readFileSync(file, 'utf-8');
  const specs: string[] = [];
  // `import ... from '<spec>'` and `export ... from '<spec>'`, skipping the
  // type-only forms (`import type` / `export type`) which are erased at runtime.
  const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;'"]*?from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(src)) !== null) {
    if (m[1]) continue; // `type` import — erased, no runtime load
    specs.push(m[2]);
  }
  // Bare side-effect imports: `import '<spec>'`.
  const sideEffect = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = sideEffect.exec(src)) !== null) specs.push(m[1]);
  return specs;
}

/** Files transitively reachable via STATIC value imports from `entry`. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticValueImports(file)) {
      if (!spec.startsWith('.')) continue; // external / node: — not our source graph
      const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      stack.push(target);
    }
  }
  return seen;
}

describe('mcp lazy-load probe', () => {
  test('mcp-tools.ts is NOT statically reachable from genie.ts', () => {
    const reachable = reachableFrom(join(SRC_ROOT, 'genie.ts'));
    const mcpTools = join(SRC_ROOT, 'lib', 'v5', 'mcp-tools.ts');
    expect(reachable.has(mcpTools)).toBe(false);
    // Sanity: the lightweight registration module IS eagerly loaded (expected).
    expect(reachable.has(join(SRC_ROOT, 'term-commands', 'mcp.ts'))).toBe(true);
  });

  test('mcp.ts loads bun:sqlite / mcp-tools only via dynamic import()', () => {
    const src = readFileSync(join(SRC_ROOT, 'term-commands', 'mcp.ts'), 'utf-8');
    // No static value import of the tools module or bun:sqlite.
    expect(src).not.toMatch(/(?:^|\n)\s*import\s+\{[^}]*\}\s+from\s+['"]\.\.\/lib\/v5\/mcp-tools/);
    expect(src).not.toMatch(/from\s+['"]bun:sqlite['"]/);
    // The tools ARE reached, via a dynamic import inside the action.
    expect(src).toMatch(/await import\(['"]\.\.\/lib\/v5\/mcp-tools\.js['"]\)/);
  });
});
