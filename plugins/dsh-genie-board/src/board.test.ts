import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { minimumGenieVersion, trusted } from './index';
import { MAX_OUTPUT, compatible, execute, hostEnvironment } from './process';
import { aggregateSchema, requestSchema } from './schema';
import { BoardService, actionArgs } from './service';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const card = {
  id: 't_abc',
  boardId: 'b_abc',
  title: 'Task',
  status: 'ready',
  claimedBy: null,
  claimedAt: null,
  wish: null,
  group: null,
  assignedAgent: null,
  assignedReason: null,
  createdAt: 1,
  updatedAt: 1,
  lane: 'Ready',
  enforcedBlock: null,
  agentKind: null,
  heartbeatAt: null,
  blockedBy: null,
  blockedReason: null,
  liveness: null,
  dependencies: [],
  timeline: [],
  comments: [],
};
const aggregate = {
  schemaVersion: 1,
  scope: 'Board',
  lanes: [
    { name: 'Ready', label: null, action: null, cards: [card] },
    { name: 'Done', label: null, action: null, cards: [] },
  ],
};
const boards = [{ id: 'b_abc', name: 'Board', laneCount: 2, cardCount: 1 }];
const selection = { workspaceId: 'workspace', boardRef: 'b_abc' };
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'genie-plugin-test-'));
  directories.push(path);
  await mkdir(join(path, '.git'));
  await mkdir(join(path, '.genie'));
  const workspaces = [{ id: 'workspace', path, title: 'Workspace' }];
  const calls: string[][] = [];
  let output: unknown = aggregate;
  let listed = boards;
  let failure = false;
  const service = new BoardService({ list: () => workspaces }, '/fixed/genie', async (_binary, argv, cwd, env) => {
    expect(cwd).toBe(path);
    expect(env.GENIE_AGENT_KIND).toBe('dsh');
    calls.push(argv);
    if (failure) throw new Error('failure');
    return JSON.stringify(argv[0] === 'board' && argv[1] === 'list' ? listed : output);
  });
  const list = () => service.request({ action: 'list', workspaceId: 'workspace' });
  const load = () => service.request({ action: 'load', ...selection });
  return {
    service,
    calls,
    workspaces,
    list,
    load,
    setBoards(value: typeof boards) {
      listed = value;
    },
    setOutput(value: unknown) {
      output = value;
    },
    fail() {
      failure = true;
    },
  };
}
describe('closed inputs and fixed argv', () => {
  test('all mutation argv are fixed; title shell syntax remains a single argument', () => {
    expect(
      actionArgs(
        requestSchema.parse({ action: 'create', ...selection, title: '$(touch /tmp/bad); hi' }) as never,
        'host',
      ),
    ).toEqual(['task', 'create', '--title', '$(touch /tmp/bad); hi', '--board', 'b_abc']);
    const vectors = [
      ['move', { lane: 'Done' }, ['task', 'move', 't_abc', '--to', 'Done']],
      ['comment', { text: 'hello' }, ['task', 'comment', '--', 't_abc', 'hello']],
      ['block', { text: 'reason', hold: true }, ['task', 'block', 't_abc', '--reason', 'reason', '--hold']],
      ['checkout', {}, ['task', 'checkout', 't_abc', '--worker', 'host']],
      ...['unblock', 'release', 'done'].map((action) => [action, {}, ['task', action, 't_abc']]),
    ];
    for (const [action, extra, argv] of vectors)
      expect(
        actionArgs(requestSchema.parse({ action, ...selection, id: 't_abc', ...(extra as object) }) as never, 'host'),
      ).toEqual(argv as string[]);
  });
  test('rejects injected authority, identifiers, hold types and controls', () => {
    const input = { action: 'block', ...selection, id: 't_abc', text: 'reason' };
    for (const key of ['worker', 'path', 'executable', 'environment', 'command', 'argv', 'unknown'])
      expect(requestSchema.safeParse({ ...input, [key]: 'evil' }).success).toBe(false);
    for (const id of ['--help', 't_abc;evil', '../t_abc', 't_ABC', 't_abc\0'])
      expect(requestSchema.safeParse({ ...input, id }).success).toBe(false);
    for (const hold of ['true', 1, null]) expect(requestSchema.safeParse({ ...input, hold }).success).toBe(false);
    for (const text of ['', '   ', 'x\0x', 'x\nx', 'x\tx', '\ntitle', 'title\n'])
      expect(requestSchema.safeParse({ ...input, text }).success).toBe(false);
  });
  test.each([
    ['C1 next line', '\u0085'],
    ['C1 control sequence introducer', '\u009b'],
    ['bidi override', '\u202e'],
    ['bidi isolate', '\u2066'],
    ['zero width space', '\u200b'],
    ['byte order mark', '\ufeff'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
    ['supplementary format control', '\u{e0001}'],
  ])('rejects %s at every text boundary before any CLI call', async (_name, control) => {
    const f = await fixture();
    await f.list();
    await f.load();
    const before = f.calls.length;
    for (const value of [`${control}text`, `te${control}xt`, `text${control}`]) {
      for (const input of [
        { action: 'create', ...selection, title: value },
        { action: 'comment', ...selection, id: 't_abc', text: value },
        { action: 'block', ...selection, id: 't_abc', text: value },
      ]) {
        await expect(f.service.request(input)).rejects.toThrow('Control characters are not allowed');
        expect(f.calls.length).toBe(before);
      }
    }
  });
  test('ordinary Unicode text is trimmed and forwarded unchanged for all three actions', async () => {
    const f = await fixture();
    await f.list();
    await f.load();
    const value = 'café 漢字 🙂 e\u0301';
    const padded = `  ${value}  `;
    const vectors = [
      [{ action: 'create', title: padded }, ['task', 'create', '--title', value, '--board', 'b_abc']],
      [{ action: 'comment', id: 't_abc', text: padded }, ['task', 'comment', '--', 't_abc', value]],
      [{ action: 'block', id: 't_abc', text: padded }, ['task', 'block', 't_abc', '--reason', value]],
    ] as const;
    for (const [input, argv] of vectors) {
      const before = f.calls.length;
      await f.service.request({ ...selection, ...input });
      expect(f.calls.slice(before)).toEqual([[...argv], ['board', '--board', 'b_abc', '--json']]);
    }
  });
  test('byte bounds for title/comment/reason', () => {
    for (const [action, field, limit] of [
      ['create', 'title', 200],
      ['comment', 'text', 4000],
      ['block', 'text', 1000],
    ] as const) {
      const base = { action, ...selection, ...(action === 'create' ? {} : { id: 't_abc' }) };
      expect(requestSchema.safeParse({ ...base, [field]: 'é'.repeat(limit / 2) }).success).toBe(true);
      expect(requestSchema.safeParse({ ...base, [field]: `${'é'.repeat(limit / 2)}x` }).success).toBe(false);
    }
  });
});
test('complete closed aggregate rejects missing detail, unknown keys, duplicate cards/lanes', () => {
  expect(aggregateSchema.safeParse(aggregate).success).toBe(true);
  for (const field of Object.keys(card)) {
    const changed = { ...card };
    delete changed[field as keyof typeof changed];
    expect(
      aggregateSchema.safeParse({ ...aggregate, lanes: [{ ...aggregate.lanes[0], cards: [changed] }] }).success,
    ).toBe(false);
  }
  expect(aggregateSchema.safeParse({ ...aggregate, extra: true }).success).toBe(false);
  expect(aggregateSchema.safeParse({ ...aggregate, lanes: [aggregate.lanes[0], aggregate.lanes[0]] }).success).toBe(
    false,
  );
});
test('list and load each use one process; all mutations use exactly mutation+aggregate', async () => {
  const f = await fixture();
  await f.list();
  expect(f.calls.length).toBe(1);
  await f.load();
  expect(f.calls.length).toBe(2);
  for (const action of ['checkout', 'release', 'unblock', 'done']) {
    const before = f.calls.length;
    await f.service.request({ action, ...selection, id: 't_abc' });
    expect(f.calls.length - before).toBe(2);
    expect(f.calls.at(-1)).toEqual(['board', '--board', 'b_abc', '--json']);
  }
});
test('foreign workspace, board, task and lane never execute', async () => {
  for (const extra of [
    { workspaceId: 'foreign' },
    { boardRef: 'b_foreign' },
    { id: 't_foreign' },
    { lane: 'Foreign' },
  ]) {
    const f = await fixture();
    await f.list();
    await f.load();
    const before = f.calls.length;
    await expect(
      f.service.request({ action: 'move', ...selection, id: 't_abc', lane: 'Done', ...extra }),
    ).rejects.toThrow();
    expect(f.calls.length).toBe(before);
  }
});
test('failed mutation refresh invalidates selection and reports possible completion', async () => {
  const f = await fixture();
  await f.list();
  await f.load();
  f.setOutput({});
  await expect(f.service.request({ action: 'done', ...selection, id: 't_abc' })).rejects.toThrow('may have completed');
  const before = f.calls.length;
  await expect(f.service.request({ action: 'done', ...selection, id: 't_abc' })).rejects.toThrow();
  expect(f.calls.length).toBe(before);
});
test('registry removal and path rebinding invalidate evidence', async () => {
  const f = await fixture();
  await f.list();
  await f.load();
  f.workspaces[0].path = '/nonexistent';
  await expect(f.load()).rejects.toThrow();
  expect(f.calls.length).toBe(2);
  f.workspaces.splice(0);
  await expect(f.list()).rejects.toThrow('Unknown workspace');
});
test('overlapping load and mutation are rejected without spawning', async () => {
  const f = await fixture();
  await f.list();
  await f.load();
  const load = f.load();
  await expect(f.service.request({ action: 'done', ...selection, id: 't_abc' })).rejects.toThrow('in progress');
  await load;
  expect(f.calls.length).toBe(3);
});
test('loopback and exact same-origin mutation fence', () => {
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' },
  };
  expect(trusted(req as IncomingMessage)).toBe(true);
  for (const origin of [undefined, 'null', 'https://evil.test', 'http://127.0.0.1:1235'])
    expect(trusted({ ...req, headers: { ...req.headers, origin } } as IncomingMessage)).toBe(false);
  expect(trusted({ ...req, socket: { remoteAddress: '10.0.0.1' } } as IncomingMessage)).toBe(false);
});
test('semver strict ordering includes prereleases and rejects malformed versions', () => {
  for (const [actual, minimum, result] of [
    ['5.260901.3', '5.260901.3', true],
    ['5.260901.2', '5.260901.3', false],
    ['5.260901.4', '5.260901.3', true],
    ['1.0.0-rc.2', '1.0.0-rc.1', true],
    ['1.0.0-rc.2', '1.0.0', false],
    ['1.0.0', '1.0.0-rc.2', true],
    ['1.0.0-01', '1.0.0', false],
    ['v1.0.0', '1.0.0', false],
    ['01.0.0', '1.0.0', false],
  ] as const)
    expect(compatible(actual, minimum)).toBe(result);
});
test('process environment is an exact allowlist', () => {
  const env = hostEnvironment('host');
  expect(env.GENIE_AGENT_NAME).toBe('host');
  expect(env.GENIE_AGENT_KIND).toBe('dsh');
  expect(env.NO_COLOR).toBe('1');
  expect(
    Object.keys(env).every((key) =>
      ['PATH', 'HOME', 'GENIE_HOME', 'NO_COLOR', 'GENIE_AGENT_NAME', 'GENIE_AGENT_KIND'].includes(key),
    ),
  ).toBe(true);
});
test('aggregate deadline and output budgets kill child or reject before spawn', async () => {
  await expect(execute('/missing', [], '.', {}, { expires: 0, bytes: 0 })).rejects.toThrow('deadline');
  // Node treats the mandatory Genie flag as invalid; a tiny executable fixture consumes it.
  const path = await mkdtemp(join(tmpdir(), 'genie-process-test-'));
  directories.push(path);
  const { writeFile } = await import('node:fs/promises');
  const file = join(path, 'genie');
  await writeFile(file, '#!/bin/sh\nprintf 1234567890\n', { mode: 0o755 });
  await expect(execute(file, [], path, {}, { expires: Date.now() + 1000, bytes: MAX_OUTPUT - 5 })).rejects.toThrow(
    'output limit',
  );
  await writeFile(file, '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
  await expect(
    execute(file, [], path, { PATH: process.env.PATH }, { expires: Date.now() + 20, bytes: 0 }),
  ).rejects.toThrow('deadline');
  await expect(execute('/missing', [], path, {}, { expires: Date.now() + 1000, bytes: 0 })).rejects.toThrow();
});

test('all action service vectors refresh once, including option-shaped comments', async () => {
  const f = await fixture();
  await f.list();
  await f.load();
  const requests = [
    { action: 'create', title: 'New task' },
    { action: 'move', id: 't_abc', lane: 'Done' },
    { action: 'comment', id: 't_abc', text: '--help' },
    { action: 'block', id: 't_abc', text: 'reason', hold: true },
    ...['unblock', 'checkout', 'release', 'done'].map((action) => ({ action, id: 't_abc' })),
  ];
  for (const input of requests) {
    const before = f.calls.length;
    await f.service.request({ ...selection, ...input });
    expect(f.calls.slice(before)).toEqual([
      actionArgs(requestSchema.parse({ ...selection, ...input }) as never, f.service.identity),
      ['board', '--board', 'b_abc', '--json'],
    ]);
  }
});
test('valid canonical directory rebinding rejects and concurrent selection switches cannot race', async () => {
  const f = await fixture();
  const second = await fixture();
  await f.list();
  await f.load();
  f.workspaces[0].path = second.workspaces[0].path;
  await expect(f.load()).rejects.toThrow('Workspace changed');
  expect(f.calls.length).toBe(2);
  const g = await fixture();
  await g.list();
  const pending = g.load();
  await expect(g.list()).rejects.toThrow('in progress');
  await pending;
  expect(g.calls.length).toBe(2);
});
test('competing distinct board loads preserve only the winner task membership', async () => {
  const f = await fixture();
  f.setBoards([...boards, { ...boards[0], id: 'b_def' }]);
  await f.list();
  await f.load();
  f.setOutput({
    ...aggregate,
    lanes: [{ ...aggregate.lanes[0], cards: [{ ...card, id: 't_def', boardId: 'b_def' }] }],
  });
  const pending = f.service.request({ action: 'load', workspaceId: 'workspace', boardRef: 'b_def' });
  await expect(f.load()).rejects.toThrow('in progress');
  await pending;
  await f.service.request({ action: 'done', workspaceId: 'workspace', boardRef: 'b_def', id: 't_def' });
  const before = f.calls.length;
  await expect(
    f.service.request({ action: 'done', workspaceId: 'workspace', boardRef: 'b_def', id: 't_abc' }),
  ).rejects.toThrow('outside');
  expect(f.calls.length).toBe(before);
});
test('stdout plus stderr share one budget across sequential processes', async () => {
  const path = await mkdtemp(join(tmpdir(), 'genie-budget-test-'));
  directories.push(path);
  const { writeFile } = await import('node:fs/promises');
  const binary = join(path, 'genie');
  await writeFile(binary, '#!/bin/sh\nprintf 12345\nprintf 12345 >&2\n', { mode: 0o755 });
  const budget = { expires: Date.now() + 1000, bytes: MAX_OUTPUT - 15 };
  expect(await execute(binary, [], path, {}, budget)).toBe('12345');
  expect(budget.bytes).toBe(MAX_OUTPUT - 5);
  await expect(execute(binary, [], path, {}, budget)).rejects.toThrow('output limit');
});
test('Host routes apply DSH authentication and Origin/content-type fences before reading workspaces or spawning', async () => {
  const { apply } = await import('./index');
  const { createServer } = await import('node:http');
  const { writeFile, readFile } = await import('node:fs/promises');
  const path = await mkdtemp(join(tmpdir(), 'genie-auth-test-'));
  directories.push(path);
  const calls = join(path, 'calls');
  await writeFile(join(path, 'genie'), `#!/bin/sh\nprintf x >> '${calls}'\nprintf '${minimumGenieVersion}\\n'\n`, {
    mode: 0o755,
  });
  const routes = new Map<string, (req: IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>>();
  let registryReads = 0;
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = path;
    await apply({
      workspaceRegistry: {
        list() {
          registryReads++;
          return [];
        },
      },
      connection: {
        requestRejection(req) {
          return req.headers.cookie === 'session=valid' ? undefined : 401;
        },
      },
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
      effect(effect) {
        effect();
      },
    });
  } finally {
    process.env.PATH = oldPath;
  }
  const server = createServer((req, res) => {
    const handler = routes.get(req.url ?? '');
    if (handler) void handler(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ['health', 'workspaces', 'action']) {
      for (const cookie of ['', 'session=invalid']) {
        const response = await fetch(`${origin}/api/genie-board/${path}`, {
          method: path === 'action' ? 'POST' : 'GET',
          headers: { origin, cookie, 'content-type': 'application/json' },
          ...(path === 'action' ? { body: '{}' } : {}),
        });
        expect(response.status).toBe(401);
      }
    }
    for (const [headers, code] of [
      [{ origin: 'https://evil.test', 'content-type': 'application/json' }, 403],
      [{ 'content-type': 'application/json' }, 403],
      [{ origin, 'content-type': 'text/plain' }, 415],
    ] as const) {
      const response = await fetch(`${origin}/api/genie-board/action`, {
        method: 'POST',
        headers: { cookie: 'session=valid', ...headers },
        body: '{}',
      });
      expect(response.status).toBe(code);
    }
    expect(registryReads).toBe(0);
    expect(await readFile(calls, 'utf8')).toBe('x');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
