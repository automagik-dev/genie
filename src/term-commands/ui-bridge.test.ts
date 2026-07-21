/**
 * genie ui-bridge — CLI-level tests. Drives the real `genie.ts ui-bridge` stdio
 * server as a subprocess (as the dash-fork UI would), speaking newline-delimited
 * JSON-RPC 2.0 against throwaway git-repo fixtures seeded via the real v5 state
 * layer. Also drives `genie mcp` to prove the plumbing extraction left it
 * unchanged (regression: zero write tools + pinned initialize response).
 *
 * Timing tests are deadline-based with generous margins (≤1s push, ≤2s
 * shutdown) to stay flake-free in CI.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../lib/v5/genie-db.js';
import {
  claimTask,
  createBoard,
  createTask,
  createWishGroups,
  exportState,
  getHire,
  listHires,
} from '../lib/v5/task-state.js';

const GENIE = join(import.meta.dir, '..', 'genie.ts');

// ============================================================================
// Fixtures
// ============================================================================

let repo: string;
let genieHome: string;

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
  repo = mkdtempSync(join(tmpdir(), 'genie-bridge-'));
  genieHome = mkdtempSync(join(tmpdir(), 'genie-home-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'commit', '--allow-empty', '-m', 'init');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(genieHome, { recursive: true, force: true });
});

function bridgeEnv(): Record<string, string> {
  return { ...process.env, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1', GENIE_HOME: genieHome } as Record<
    string,
    string
  >;
}

// ============================================================================
// JSON-RPC shapes + drivers
// ============================================================================

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** One-shot driver: write all requests, close stdin, collect every output line. */
async function driveOnce(cmd: string, cwd: string, requests: Record<string, unknown>[]): Promise<RpcMessage[]> {
  const proc = Bun.spawn(['bun', GENIE, cmd], {
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: bridgeEnv(),
  });
  proc.stdin.write(`${requests.map((r) => JSON.stringify(r)).join('\n')}\n`);
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return parseLines(stdout);
}

function parseLines(stdout: string): RpcMessage[] {
  return stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RpcMessage);
}

/** Streaming client for long-lived interactions (push, shutdown, sockets). */
class BridgeClient {
  readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  readonly messages: RpcMessage[] = [];
  private buf = '';

  constructor(cwd: string) {
    this.proc = Bun.spawn(['bun', GENIE, 'ui-bridge'], {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: bridgeEnv(),
    });
    void this.pump();
  }

  private async pump(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      this.buf += decoder.decode(value, { stream: true });
      let nl = this.buf.indexOf('\n');
      while (nl !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line.length > 0) this.messages.push(JSON.parse(line) as RpcMessage);
        nl = this.buf.indexOf('\n');
      }
    }
  }

  send(obj: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  async waitFor(pred: (m: RpcMessage) => boolean, timeoutMs = 4000): Promise<RpcMessage | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.messages.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    return this.messages.find(pred) ?? null;
  }

  async endStdin(): Promise<void> {
    await this.proc.stdin.end();
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

const INIT_OK = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', bridgeProtocolVersion: '1.0', clientInfo: { name: 't', version: '0' } },
};

function toolPayload<T>(res: RpcMessage): T {
  const content = (res.result?.content as Array<{ type: string; text: string }>) ?? [];
  return JSON.parse(content[0].text) as T;
}

function call(id: number, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function seed(cwd: string): { taskIds: string[]; boardName: string } {
  const db = openDb({ cwd });
  const board = createBoard(db, 'repo');
  const t1 = createTask(db, { title: 'alpha g1', boardId: board.id, wish: 'w-alpha', group: 'g1' });
  const t2 = createTask(db, {
    title: 'alpha g2',
    boardId: board.id,
    wish: 'w-alpha',
    group: 'g2',
    dependsOn: [t1.id],
  });
  const t3 = createTask(db, { title: 'loose', boardId: board.id });
  createWishGroups(db, 'w-alpha', [{ name: 'g1' }, { name: 'g2', dependsOn: ['g1'] }]);
  claimTask(db, t1.id, 'worker-1'); // t1 → in_progress
  db.close();
  return { taskIds: [t1.id, t2.id, t3.id], boardName: 'repo' };
}

// ============================================================================
// Success Criterion 1 — handshake (happy + incompatible)
// ============================================================================

describe('ui-bridge handshake', () => {
  test('reports bridge protocol version + genie version on a compatible client', async () => {
    const [res] = await driveOnce('ui-bridge', repo, [INIT_OK]);
    expect(res.id).toBe(1);
    expect(res.result?.bridgeProtocolVersion).toBe('1.0');
    expect(typeof res.result?.genieVersion).toBe('string');
    expect(res.result?.protocolVersion).toBe('2024-11-05');
    const serverInfo = res.result?.serverInfo as { name: string; version: string };
    expect(serverInfo.name).toBe('genie-ui-bridge');
    expect(res.error).toBeUndefined();
  });

  test('an incompatible declared version gets a structured error, not silence', async () => {
    const [res] = await driveOnce('ui-bridge', repo, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { bridgeProtocolVersion: '2.0' } },
    ]);
    expect(res.result).toBeUndefined();
    expect(res.error?.code).toBe(-32001);
    const data = res.error?.data as { serverBridgeProtocolVersion: string; clientBridgeProtocolVersion: string };
    expect(data.serverBridgeProtocolVersion).toBe('1.0');
    expect(data.clientBridgeProtocolVersion).toBe('2.0');
  });

  test('a client declaring no bridge version is accepted (best-effort)', async () => {
    const [res] = await driveOnce('ui-bridge', repo, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    ]);
    expect(res.error).toBeUndefined();
    expect(res.result?.bridgeProtocolVersion).toBe('1.0');
  });

  test('exposes the 5 read tools plus the 2 roster write tools; roster_hire requires worktree', async () => {
    const responses = await driveOnce('ui-bridge', repo, [INIT_OK, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const list = responses.find((r) => r.id === 2);
    const tools = list?.result?.tools as Array<{ name: string; inputSchema: { required?: string[] } }>;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'genie_active',
      'genie_board',
      'genie_task',
      'genie_wish_status',
      'genie_worktree_context',
      'roster_hire',
      'roster_unhire',
    ]);
    const hire = tools.find((t) => t.name === 'roster_hire');
    expect(hire?.inputSchema.required).toEqual(['wish', 'agentAdapterId', 'worktree']);
  });
});

// ============================================================================
// Success Criterion 2 — read parity vs exportState()
// ============================================================================

describe('ui-bridge read parity', () => {
  test('every task/board/wish row the read tools surface matches exportState()', async () => {
    const { boardName } = seed(repo);
    const db = openDb({ cwd: repo });
    const exp = exportState(db);
    db.close();

    const responses = await driveOnce('ui-bridge', repo, [
      INIT_OK,
      call(3, 'genie_board'),
      call(4, 'genie_board', { board: boardName }),
      call(5, 'genie_wish_status', { wish: 'w-alpha' }),
      call(6, 'genie_active'),
    ]);

    // Task rows: same ids, statuses, wish/group, claimant as the export.
    const boardPayload = toolPayload<{ tasks: Array<Record<string, unknown>> }>(responses.find((r) => r.id === 3)!);
    const byId = new Map(boardPayload.tasks.map((t) => [t.id as string, t]));
    expect(byId.size).toBe(exp.tasks.length);
    for (const raw of exp.tasks) {
      const t = byId.get(raw.id);
      expect(t).toBeDefined();
      expect(t?.status).toBe(raw.status);
      expect(t?.wish).toBe(raw.wish);
      expect(t?.group).toBe(raw.group_name);
      expect(t?.claimedBy).toBe(raw.claimed_by);
    }

    // Board projection: the named board resolves and carries its own tasks.
    const namedBoard = toolPayload<{ board: string; tasks: unknown[] }>(responses.find((r) => r.id === 4)!);
    const boardRow = exp.boards.find((b) => b.name === boardName);
    expect(boardRow).toBeDefined();
    expect(namedBoard.board).toBe(boardName);
    expect(namedBoard.tasks.length).toBe(exp.tasks.filter((t) => t.board_id === boardRow?.id).length);

    // Wish groups: same names, statuses, dependsOn as the exported wish_groups.
    const wish = toolPayload<{ groups: Array<{ name: string; status: string; dependsOn: string[] }> }>(
      responses.find((r) => r.id === 5)!,
    );
    const expGroups = exp.wish_groups.filter((g) => g.wish === 'w-alpha');
    expect(wish.groups.map((g) => g.name).sort()).toEqual(expGroups.map((g) => g.name).sort());
    for (const eg of expGroups) {
      const bg = wish.groups.find((g) => g.name === eg.name);
      expect(bg?.status).toBe(eg.status);
      expect(bg?.dependsOn).toEqual(JSON.parse(eg.depends_on));
    }

    // Active projection: exactly the in_progress rows from the export.
    const active = toolPayload<{ tasks: Array<{ id: string }> }>(responses.find((r) => r.id === 6)!);
    expect(active.tasks.map((t) => t.id).sort()).toEqual(
      exp.tasks
        .filter((t) => t.status === 'in_progress')
        .map((t) => t.id)
        .sort(),
    );
  });
});

// ============================================================================
// Success Criterion 3 — roster write tools + concurrency
// ============================================================================

describe('ui-bridge roster write tools', () => {
  test('roster_hire / roster_unhire round-trip through task-state and surface in exportState()', async () => {
    const responses = await driveOnce('ui-bridge', repo, [
      INIT_OK,
      call(2, 'roster_hire', { wish: 'w-alpha', agentAdapterId: 'codex-1', worktree: '/wt/codex-1', profile: 'high' }),
      call(3, 'roster_unhire', { wish: 'w-alpha', agentAdapterId: 'codex-1' }),
      call(4, 'roster_unhire', { wish: 'w-alpha', agentAdapterId: 'never' }),
    ]);

    const hired = toolPayload<{ wish: string; agentAdapterId: string; worktree: string; profile: string }>(
      responses.find((r) => r.id === 2)!,
    );
    expect(hired).toMatchObject({
      wish: 'w-alpha',
      agentAdapterId: 'codex-1',
      worktree: '/wt/codex-1',
      profile: 'high',
    });

    const removed = toolPayload<{ removed: boolean }>(responses.find((r) => r.id === 3)!);
    expect(removed.removed).toBe(true);
    const absent = toolPayload<{ removed: boolean }>(responses.find((r) => r.id === 4)!);
    expect(absent.removed).toBe(false);

    // Final state: hire then unhire → gone. (Prove it went through the real db.)
    const db = openDb({ cwd: repo });
    expect(getHire(db, 'w-alpha', 'codex-1')).toBeNull();
    db.close();
  });

  test('roster_hire persists a row visible in a fresh export', async () => {
    await driveOnce('ui-bridge', repo, [
      INIT_OK,
      call(2, 'roster_hire', { wish: 'w-beta', agentAdapterId: 'a1', worktree: '/wt/a1' }),
    ]);
    const db = openDb({ cwd: repo });
    const exp = exportState(db);
    db.close();
    expect(exp.hire_roster.some((h) => h.wish === 'w-beta' && h.agent_adapter_id === 'a1')).toBe(true);
  });

  test('missing required argument returns a structured invalid_arguments payload', async () => {
    const responses = await driveOnce('ui-bridge', repo, [
      INIT_OK,
      call(2, 'roster_hire', { wish: 'w', agentAdapterId: 'a' }), // no worktree
    ]);
    const payload = toolPayload<{ error: string; missing: string[] }>(responses.find((r) => r.id === 2)!);
    expect(payload.error).toBe('invalid_arguments');
    expect(payload.missing).toEqual(['worktree']);
  });

  test('concurrent CLI writer during bridge roster writes: no corruption, no busy-failure', async () => {
    seed(repo);
    const N = 8;
    const requests: Record<string, unknown>[] = [INIT_OK];
    for (let i = 0; i < N; i++) {
      requests.push(
        call(100 + i, 'roster_hire', { wish: 'w-alpha', agentAdapterId: `agent-${i}`, worktree: `/wt/${i}` }),
      );
    }

    // A parallel, separate-connection CLI-style writer racing the bridge's writes.
    const cliWriter = (async () => {
      const db = openDb({ cwd: repo });
      for (let i = 0; i < N; i++) createTask(db, { title: `concurrent-${i}`, wish: 'w-alpha', group: 'g1' });
      db.close();
    })();

    const [responses] = await Promise.all([driveOnce('ui-bridge', repo, requests), cliWriter]);

    // Every roster write succeeded (no SQLITE_BUSY escaping as a JSON-RPC error).
    for (let i = 0; i < N; i++) {
      const res = responses.find((r) => r.id === 100 + i);
      expect(res?.error).toBeUndefined();
      expect(res?.result?.isError).toBe(false);
    }

    // Final state is consistent: all roster rows AND all concurrent tasks landed.
    const db = openDb({ cwd: repo });
    const hires = listHires(db, 'w-alpha');
    const tasks = exportState(db).tasks.filter((t) => t.title.startsWith('concurrent-'));
    db.close();
    expect(hires.length).toBe(N);
    expect(tasks.length).toBe(N);
  });
});

// ============================================================================
// Success Criterion 4 — push within 1s
// ============================================================================

describe('ui-bridge change push', () => {
  test('an external genie task create yields a change notification within 1s', async () => {
    seed(repo);
    const client = new BridgeClient(repo);
    try {
      client.send(INIT_OK);
      const init = await client.waitFor((m) => m.id === 1 && m.result !== undefined);
      expect(init?.result?.bridgeProtocolVersion).toBe('1.0');

      // External write on a separate connection while the bridge is running.
      const t0 = Date.now();
      const db = openDb({ cwd: repo });
      createTask(db, { title: 'pushed', wish: 'w-alpha', group: 'g1' });
      db.close();

      const note = await client.waitFor((m) => m.method === 'notifications/genie/changed', 3000);
      const elapsed = Date.now() - t0;
      expect(note).not.toBeNull();
      expect(typeof (note?.params?.dataVersion as number)).toBe('number');
      expect(elapsed).toBeLessThanOrEqual(1000);
    } finally {
      client.kill();
    }
  });
});

// ============================================================================
// Success Criterion 5 — lifetime (shutdown ≤2s + zero listening sockets)
// ============================================================================

describe('ui-bridge lifetime', () => {
  test('closing client stdin ends the bridge within 2s', async () => {
    const client = new BridgeClient(repo);
    client.send(INIT_OK);
    await client.waitFor((m) => m.id === 1);
    const t0 = Date.now();
    await client.endStdin();
    const code = await client.proc.exited;
    const elapsed = Date.now() - t0;
    expect(code).toBe(0);
    expect(elapsed).toBeLessThanOrEqual(2000);
  });

  test('holds zero listening TCP sockets while running', async () => {
    const client = new BridgeClient(repo);
    try {
      client.send(INIT_OK);
      await client.waitFor((m) => m.id === 1);
      const pid = client.proc.pid;
      const listening = execFileSync('ss', ['-H', '-tlnp'], { encoding: 'utf-8' });
      const owned = listening.split('\n').filter((l) => new RegExp(`pid=${pid}\\b`).test(l));
      expect(owned).toEqual([]);
    } finally {
      client.kill();
    }
  });
});

// ============================================================================
// Success Criterion 6 — genie mcp unchanged by the plumbing extraction
// ============================================================================

describe('genie mcp regression (unchanged by extraction)', () => {
  test('initialize response is byte-for-byte the pinned read-only reply', async () => {
    const [res] = await driveOnce('mcp', repo, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    ]);
    const result = res.result as Record<string, unknown>;
    // Pin the exact shape + key order the read-only server has always sent.
    expect(Object.keys(result)).toEqual(['protocolVersion', 'capabilities', 'serverInfo']);
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities).toEqual({ tools: {} });
    const serverInfo = result.serverInfo as { name: string; version: string };
    expect(serverInfo.name).toBe('genie');
    // Read-only server never advertises the bridge fields.
    expect(result.bridgeProtocolVersion).toBeUndefined();
    expect(result.genieVersion).toBeUndefined();
  });

  test('registers exactly the 5 read tools and ZERO write tools', async () => {
    const responses = await driveOnce('mcp', repo, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const tools = responses.find((r) => r.id === 2)?.result?.tools as Array<{ name: string }>;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['genie_active', 'genie_board', 'genie_task', 'genie_wish_status', 'genie_worktree_context']);
    // No roster_* / write tool leaked into the read-only server.
    expect(names.some((n) => n.startsWith('roster_'))).toBe(false);
  });
});
