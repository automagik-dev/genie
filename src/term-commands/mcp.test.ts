/**
 * genie mcp — CLI-level tests. Drives the real `genie.ts mcp` stdio server as a
 * subprocess (as an MCP client would), speaking newline-delimited JSON-RPC 2.0,
 * against throwaway git-repo fixtures seeded via the real v5 state layer.
 *
 * Also asserts the LAZY-LOAD contract with a static import-graph probe: the
 * read-only `bun:sqlite` open in `mcp-tools.ts` must NOT be reachable from
 * `genie.ts` except through the dynamic `import()` inside the `mcp` action.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { openDb } from '../lib/v5/genie-db.js';
import { createBoard, createTask, createWishGroups } from '../lib/v5/task-state.js';

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
  createWishGroups(db, 'genie-mcp', [{ name: 'g1' }, { name: 'g2', dependsOn: ['g1'] }]);
  // Fold pending WAL frames into the main db before the reader subprocess opens,
  // so the readonly `genie mcp` server isn't racing an open WAL writer under
  // cross-file test contention ("database is locked").
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return { taskId: t.id };
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
  test('lists exactly the 5 read-only tools with input schemas', async () => {
    const responses = await driveMcp(repo, [INIT, INITIALIZED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const list = responses.find((r) => r.id === 2);
    const tools = list?.result?.tools as Array<{ name: string; inputSchema: unknown }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'genie_active',
      'genie_board',
      'genie_task',
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

  test('genie_wish_status returns the group DAG and tasks', async () => {
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
    expect(payload.groups.map((g) => g.name).sort()).toEqual(['g1', 'g2']);
    const g2 = payload.groups.find((g) => g.name === 'g2');
    expect(g2?.dependsOn).toEqual(['g1']);
    expect(g2?.status).toBe('blocked');
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
    const missing = toolPayload<{ error: string; id: string }>(responses.find((r) => r.id === 6)!);
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
    // Add runtime state (block + claim) so a leak would actually surface if any.
    const db = openDb({ cwd: repo });
    db.query(
      "UPDATE tasks SET blocked_by='x', blocked_reason='r', heartbeat_at=1, agent_kind='codex', lane='Idea' WHERE id=?",
    ).run(taskId);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();

    const responses = await driveMcp(repo, [
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'genie_task', arguments: { id: taskId } } },
    ]);
    const task = toolPayload<Record<string, unknown>>(responses.find((r) => r.id === 40)!);
    // The projection is byte-frozen: exactly the pre-runtime TaskRow keys.
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
    for (const leaked of ['lane', 'agentKind', 'heartbeatAt', 'blockedBy', 'blockedReason']) {
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

  test('reopens a db created AFTER the server started (no stale empty board)', async () => {
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
    // server's startup read-only open already ran against an absent db (null) —
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
    const payload = toolPayload<{ counts: { total: number } }>(res!);
    expect(payload.counts.total).toBeGreaterThan(0); // saw the db created mid-session
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

  test('a launch group branch beats a same-named top-level wish slug', async () => {
    // Ambiguous collision: a `genie` wish WITH a real `mcp` group, AND a separate
    // `genie-mcp` wish. `wish/genie-mcp` must resolve to the verified launch
    // worktree (genie / mcp), not the exact-slug top-level `genie-mcp` wish.
    const db = openDb({ cwd: repo });
    const board = createBoard(db, 'repo');
    createTask(db, { title: 'a', boardId: board.id, wish: 'genie', group: 'mcp' });
    createWishGroups(db, 'genie', [{ name: 'mcp' }]);
    createTask(db, { title: 'b', boardId: board.id, wish: 'genie-mcp', group: 'g1' });
    createWishGroups(db, 'genie-mcp', [{ name: 'g1' }]);
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
    expect(p.wish).toBe('genie');
    expect(p.group).toBe('mcp');
  });
});

// ============================================================================
// Lazy-load probe — mcp-tools (the readonly bun:sqlite open) must NOT be in the
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
