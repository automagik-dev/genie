import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOCKET_DEADLINE_MS, armSocketDeadline, minimumGenieVersion, trusted } from './index';
import {
  DEADLINE_MS,
  GenieCommandError,
  MAX_OUTPUT,
  compatible,
  execute,
  hostEnvironment,
  resolveExecutable,
} from './process';
import { LANELESS_MESSAGE, aggregateSchema, parseAggregate, parseRequest, requestSchema } from './schema';
import { BoardService, type Workspace, actionArgs } from './service';

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
  eventCount: 0,
  eventsTruncated: false,
  comments: [],
  commentCount: 0,
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
  let refusal: { verb: string; message: string } | undefined;
  const service = new BoardService({ list: () => workspaces }, '/fixed/genie', async (_binary, argv, cwd, env) => {
    expect(cwd).toBe(path);
    expect(env.GENIE_AGENT_KIND).toBe('dsh');
    calls.push(argv);
    if (failure) throw new Error('failure');
    if (refusal && argv[1] === refusal.verb) throw new GenieCommandError(refusal.message, 1);
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
    /** Make one `task <verb>` refuse the way the real CLI does: exit 1 + stderr. */
    refuse(verb: string, message: string) {
      refusal = { verb, message };
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
    // An id is whatever Genie emits, so only what argv cares about is refused:
    // a leading dash commander would read as an option, and control characters.
    for (const id of ['--help', '-x', '', 't_abc\0', 't_abc\n', 'x'.repeat(201)])
      expect(requestSchema.safeParse({ ...input, id }).success).toBe(false);
    for (const id of ['t_abc', 't_ABC-hand', 'task/1', 't_abc;evil', '../t_abc'])
      expect(requestSchema.safeParse({ ...input, id }).success).toBe(true);
    for (const hold of ['true', 1, null]) expect(requestSchema.safeParse({ ...input, hold }).success).toBe(false);
    for (const text of ['', '   ', 'x\0x', '\n', ' \t '])
      expect(requestSchema.safeParse({ ...input, text }).success).toBe(false);
  });
  test.each([
    ['NUL', '\u0000'],
    ['backspace', '\u0008'],
    ['vertical tab', '\u000b'],
    ['escape', '\u001b'],
    ['delete', '\u007f'],
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
        await expect(f.service.request(input)).rejects.toThrow('must not contain control characters');
        expect(f.calls.length).toBe(before);
      }
    }
  });
  // F12: the CLI stores these verbatim, so refusing them here silently ate the
  // user's typed text. Newlines and tabs inside the value survive; only the
  // surrounding whitespace is trimmed.
  test.each([
    ['newline', 'line one\nline two'],
    ['tab', 'before\tafter'],
    ['carriage return', 'before\r\nafter'],
    ['zero width joiner', 'Ship \u{1f468}\u200d\u{1f469}\u200d\u{1f467} onboarding'],
    ['soft hyphen', 'co\u00adoperate'],
    ['bidi isolate', 'name \u2066rtl\u2069 tail'],
  ])('accepts %s exactly as the CLI stores it', async (_name, value) => {
    const f = await fixture();
    await f.list();
    await f.load();
    const before = f.calls.length;
    await f.service.request({ action: 'comment', ...selection, id: 't_abc', text: `  ${value}\n` });
    expect(f.calls[before]).toEqual(['task', 'comment', '--', 't_abc', value]);
  });
  test('an invalid request reports one human sentence, never a Zod issues array', async () => {
    const f = await fixture();
    await f.list();
    await f.load();
    const failure = await f.service
      .request({ action: 'comment', ...selection, id: 't_abc', text: 'x\u0000x' })
      .catch((error: Error) => error.message);
    expect(failure).toBe('Invalid request: text must not contain control characters.');
    expect(() => parseRequest({ action: 'comment', ...selection, id: 't_abc' })).toThrow(
      'Invalid request: text Required.',
    );
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
test('the aggregate still requires every documented field of every card', () => {
  expect(aggregateSchema.safeParse(aggregate).success).toBe(true);
  for (const field of Object.keys(card)) {
    const changed = { ...card };
    delete changed[field as keyof typeof changed];
    expect(
      aggregateSchema.safeParse({ ...aggregate, lanes: [{ ...aggregate.lanes[0], cards: [changed] }] }).success,
    ).toBe(false);
  }
  for (const lanes of [[], 'nope', null])
    expect(aggregateSchema.safeParse({ ...aggregate, lanes }).success).toBe(false);
});
// F11: the emitter's contract is additive under schemaVersion 1. A plugin that
// refused an unknown key broke on the first genie release that added one.
test('additive keys anywhere in the aggregate are ignored, not fatal', () => {
  const extended = {
    ...aggregate,
    added: true,
    lanes: [
      {
        ...aggregate.lanes[0],
        added: 1,
        cards: [
          {
            ...card,
            priority: null,
            timeline: [{ id: 1, kind: 'created', note: null, authorKind: null, author: null, createdAt: 1, tag: 'x' }],
            comments: [{ id: 2, note: 'hi', authorKind: null, author: null, createdAt: 1, tag: 'x' }],
            dependencies: [{ id: 't_dep', title: 'Dep', status: 'done', tag: 'x' }],
          },
        ],
      },
      aggregate.lanes[1],
    ],
  };
  expect(aggregateSchema.safeParse(extended).success).toBe(true);
});
// F5: every one of these is something `genie board create --lanes A,A`,
// `task import` or `task comment -- <id> ''` can produce, and any one of them
// used to make the whole board unopenable.
test('the aggregate accepts everything the CLI itself can emit', () => {
  const emitted = {
    ...aggregate,
    lanes: [
      {
        name: 'A',
        label: null,
        action: null,
        cards: [
          {
            ...card,
            id: 't_ABC-hand',
            comments: [{ id: 3, note: '', authorKind: null, author: null, createdAt: 1 }],
            commentCount: 1,
          },
        ],
      },
      { name: 'A', label: null, action: null, cards: [] },
    ],
  };
  expect(aggregateSchema.safeParse(emitted).success).toBe(true);
});
test('a newer aggregate contract is named, and a laneless payload explains itself', () => {
  expect(() => parseAggregate(JSON.stringify({ ...aggregate, schemaVersion: 2 }))).toThrow(
    'Incompatible genie output (schemaVersion 2, expected 1). Update the Genie board plugin.',
  );
  expect(() => parseAggregate(JSON.stringify({ scope: 'board "x"', columns: { ready: [] } }))).toThrow(
    LANELESS_MESSAGE,
  );
  expect(() => parseAggregate('{')).toThrow('Genie returned output that is not JSON.');
  expect(() => parseAggregate(JSON.stringify({ ...aggregate, lanes: [{ ...aggregate.lanes[0], cards: 3 }] }))).toThrow(
    'Genie board output is unreadable: lanes.cards Expected array, received number.',
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
    // A claim also pulses the card it just took, so it renders fresh (F8).
    expect(f.calls.length - before).toBe(action === 'checkout' ? 3 : 2);
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
// P1: a same-origin `fetch` sends no Origin, and older Safari/Firefox and
// embedded WebViews send no Sec-Fetch-Site either; a read from one of those is
// what DSH's own fence accepts, so the plugin must not be stricter.
test('a header-less same-origin GET is trusted; every cross-origin signal still is not', () => {
  const req = { method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:1234' } };
  expect(trusted(req as IncomingMessage)).toBe(true);
  expect(trusted({ ...req, headers: { ...req.headers, 'sec-fetch-site': 'same-origin' } } as IncomingMessage)).toBe(
    true,
  );
  for (const headers of [
    { origin: 'https://evil.test' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'none' },
  ])
    expect(trusted({ ...req, headers: { ...req.headers, ...headers } } as IncomingMessage)).toBe(false);
  expect(trusted({ ...req, headers: {} } as IncomingMessage)).toBe(false);
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
  // Overrunning the budget names the cause a human can act on — the board is
  // bigger than one response — instead of an opaque 'output limit exceeded'.
  await expect(execute(file, [], path, {}, { expires: Date.now() + 1000, bytes: MAX_OUTPUT - 5 })).rejects.toThrow(
    'too large for one response',
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
      ...(input.action === 'checkout' ? [['task', 'heartbeat', 't_abc']] : []),
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
  await expect(execute(binary, [], path, {}, budget)).rejects.toThrow('too large for one response');
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

// ---------------------------------------------------------------------------
// Failure reporting: a refusal is a sentence, and it is not a state change.
// ---------------------------------------------------------------------------
test('a refused command reports its own Error: line, not the exit code', async () => {
  const path = await mkdtemp(join(tmpdir(), 'genie-stderr-test-'));
  directories.push(path);
  const { writeFile } = await import('node:fs/promises');
  const binary = join(path, 'genie');
  await writeFile(
    binary,
    '#!/bin/sh\nprintf "warming up\\n" >&2\nprintf "Error: Task t_abc is not claimable\\n" >&2\nexit 1\n',
    { mode: 0o755 },
  );
  const failure = await execute(binary, ['task', 'checkout'], path, {}, { expires: Date.now() + 2000, bytes: 0 }).catch(
    (error: Error) => error,
  );
  expect(failure).toBeInstanceOf(GenieCommandError);
  expect((failure as Error).message).toBe('Error: Task t_abc is not claimable');
  // Silence still falls back to the exit code, and a non-typed failure keeps its tail.
  await writeFile(binary, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  await expect(execute(binary, [], path, {}, { expires: Date.now() + 2000, bytes: 0 })).rejects.toThrow(
    'Genie exited with code 3',
  );
  await writeFile(binary, '#!/bin/sh\nprintf "usage: genie task\\n" >&2\nexit 2\n', { mode: 0o755 });
  await expect(execute(binary, [], path, {}, { expires: Date.now() + 2000, bytes: 0 })).rejects.toThrow(
    'usage: genie task',
  );
});
test('a refusal keeps the board selection; a killed child does not', async () => {
  const f = await fixture();
  await f.list();
  await f.load();
  f.refuse('checkout', 'Error: Task t_abc is not claimable (already claimed or not ready)');
  await expect(f.service.request({ action: 'checkout', ...selection, id: 't_abc' })).rejects.toThrow(
    'Error: Task t_abc is not claimable (already claimed or not ready)',
  );
  // The board is exactly as it was, so the next action needs no re-list.
  const before = f.calls.length;
  await f.load();
  expect(f.calls.length - before).toBe(1);
  // A failure that is NOT a clean refusal still invalidates: the board's state
  // after it is unknown, so the browser must list again before acting.
  f.setOutput({});
  await expect(f.service.request({ action: 'done', ...selection, id: 't_abc' })).rejects.toThrow('may have completed');
  await expect(f.load()).rejects.toThrow('Unknown board; list boards first');
});
test('a laneless board explains itself instead of failing schema validation', async () => {
  const f = await fixture();
  await f.list();
  await f.load();
  f.setOutput({ scope: 'board "Legacy"', columns: { blocked: [], ready: [], in_progress: [], done: [] } });
  await expect(f.load()).rejects.toThrow(LANELESS_MESSAGE);
});
test('a missing .genie is named without leaking the Host path', async () => {
  const path = await mkdtemp(join(tmpdir(), 'genie-secret-workspace-'));
  directories.push(path);
  const service = new BoardService({ list: () => [{ id: 'w', path, title: 'W' }] }, '/fixed/genie', async () => '[]');
  const failure = await service.request({ action: 'list', workspaceId: 'w' }).catch((error: Error) => error.message);
  expect(failure).toBe('Workspace has no .genie directory; run `genie init` in it first');
  const gone = new BoardService(
    { list: () => [{ id: 'w', path: join(path, 'missing'), title: 'W' }] },
    '/fixed/genie',
    async () => '[]',
  );
  const message = await gone.request({ action: 'list', workspaceId: 'w' }).catch((error: Error) => error.message);
  expect(message).toBe('Workspace path is unavailable');
  expect(message).not.toContain(path);
});
// ---------------------------------------------------------------------------
// Claim liveness (F8)
// ---------------------------------------------------------------------------
test('a claim made here heartbeats at once and stays alive while the plugin runs', async () => {
  const f = await fixture();
  await f.list();
  await f.load();
  const claimed = {
    ...aggregate,
    lanes: [
      { ...aggregate.lanes[0], cards: [{ ...card, status: 'in_progress', claimedBy: f.service.identity }] },
      aggregate.lanes[1],
    ],
  };
  f.setOutput(claimed);
  await f.service.request({ action: 'checkout', ...selection, id: 't_abc' });
  expect(f.calls.at(-2)).toEqual(['task', 'heartbeat', 't_abc']);
  const before = f.calls.length;
  await f.service.pulse();
  expect(f.calls.slice(before)).toEqual([['task', 'heartbeat', 't_abc']]);
  // Released cards stop pulsing: the refresh that shows them unclaimed drops them.
  f.setOutput(aggregate);
  await f.service.request({ action: 'release', ...selection, id: 't_abc' });
  const after = f.calls.length;
  await f.service.pulse();
  expect(f.calls.length).toBe(after);
  f.service.dispose();
});
test('a card claimed by someone else is never pulsed from here', async () => {
  const f = await fixture();
  f.setOutput({
    ...aggregate,
    lanes: [
      { ...aggregate.lanes[0], cards: [{ ...card, status: 'in_progress', claimedBy: 'codex:other@host' }] },
      aggregate.lanes[1],
    ],
  });
  await f.list();
  await f.load();
  const before = f.calls.length;
  await f.service.pulse();
  expect(f.calls.length).toBe(before);
  f.service.dispose();
});

// ---------------------------------------------------------------------------
// Host routes: every one answers, even when it throws (C1), and a read from a
// header-less same-origin browser is served (P1).
// ---------------------------------------------------------------------------
async function hostRoutes(
  list: () => Workspace[],
  script = (version: string) => `#!/bin/sh\nprintf '${version}\\n'\n`,
) {
  const { apply } = await import('./index');
  const { createServer } = await import('node:http');
  const { writeFile } = await import('node:fs/promises');
  const path = await mkdtemp(join(tmpdir(), 'genie-routes-test-'));
  directories.push(path);
  await writeFile(join(path, 'genie'), script(minimumGenieVersion), { mode: 0o755 });
  const routes = new Map<string, (req: IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>>();
  const previous = process.env.PATH;
  try {
    process.env.PATH = path;
    await apply({
      workspaceRegistry: { list },
      connection: { requestRejection: () => undefined },
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
    process.env.PATH = previous;
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
  return {
    origin: `http://127.0.0.1:${address.port}`,
    executable: join(path, 'genie'),
    closeAllConnections: () => server.closeAllConnections?.(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
test('a route that throws answers 500 JSON instead of leaving the browser hanging', async () => {
  const host = await hostRoutes(() => {
    throw new Error('registry exploded at /home/someone/secret');
  });
  try {
    const response = await fetch(`${host.origin}/api/genie-board/workspaces`);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'Genie board route failed' });
  } finally {
    await host.close();
  }
});
test('a header-less same-origin read is served and names the executable it resolved', async () => {
  const host = await hostRoutes(() => []);
  try {
    const response = await fetch(`${host.origin}/api/genie-board/health`);
    expect(response.status).toBe(200);
    const health = (await response.json()) as { compatible: boolean; executable: string };
    expect(health.compatible).toBe(true);
    expect(health.executable).toBe(host.executable);
    // The mutation fence is unchanged: a POST without an exact Origin is refused.
    const mutation = await fetch(`${host.origin}/api/genie-board/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(mutation.status).toBe(403);
  } finally {
    await host.close();
  }
});
// F6: the socket deadline must outlive the Genie budget, and its listener must
// answer before the socket goes away. Armed at or below the budget, the 400 the
// handler eventually writes lands on a destroyed socket.
test('the socket deadline outlives the Genie budget and answers before destroying', async () => {
  expect(SOCKET_DEADLINE_MS).toBeGreaterThan(DEADLINE_MS);
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    armSocketDeadline(req, res, 50);
    /* A handler that never answers on its own, like a hung Genie child. */
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/genie-board/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: 'Genie board request timed out' });
  } finally {
    // The timed-out connection is still open, so it is dropped before the
    // listener is closed; either step may already have finished the other.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
// P3: DSH launched from a desktop session can have a PATH that never saw the
// installer's directory; the documented install locations answer for it.
test('the executable resolves from GENIE_HOME/bin, ~/.genie/bin and ~/.local/bin', async () => {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'genie-resolve-test-'));
  directories.push(root);
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, GENIE_HOME: process.env.GENIE_HOME };
  try {
    process.env.PATH = join(root, 'empty');
    for (const [variable, directory] of [
      ['GENIE_HOME', join(root, 'genie-home', 'bin')],
      ['HOME', join(root, 'home', '.genie', 'bin')],
      ['HOME', join(root, 'home', '.local', 'bin')],
    ] as const) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'genie'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      process.env.GENIE_HOME = variable === 'GENIE_HOME' ? join(root, 'genie-home') : join(root, 'absent');
      process.env.HOME = join(root, 'home');
      expect(resolveExecutable()).toBe(join(directory, 'genie'));
      await rm(join(directory, 'genie'));
    }
    expect(() => resolveExecutable()).toThrow('Genie executable is unavailable');
  } finally {
    Object.assign(process.env, environment);
  }
});
// F6 end to end, with a genie that hangs: the browser must receive the deadline
// answer as JSON, inside the socket deadline. On Node — DSH's runtime — the old
// arming destroyed the socket at the same 10 s the Genie budget expires and this
// fetch failed outright; bun's node:http times sockets differently, so the
// armSocketDeadline test above is the invariant guard and this is the whole-path
// proof.
test('a hung Genie answers the browser with the deadline error, not a dead socket', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'genie-slow-workspace-'));
  directories.push(workspace);
  await mkdir(join(workspace, '.genie'));
  await mkdir(join(workspace, '.git'));
  // The Host's environment carries only its own PATH, so the hang runs an
  // absolute sleep rather than a command looked up in it.
  const sleep = Bun.which('sleep') ?? '/bin/sleep';
  const host = await hostRoutes(
    () => [{ id: 'w', path: workspace, title: 'W' }],
    (version) => `#!/bin/sh\ncase "$*" in *--version*) printf '${version}\\n';; *) exec ${sleep} 30;; esac\n`,
  );
  try {
    const started = Date.now();
    const response = await fetch(`${host.origin}/api/genie-board/action`, {
      method: 'POST',
      headers: { origin: host.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'list', workspaceId: 'w' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Genie deadline exceeded' });
    expect(Date.now() - started).toBeLessThan(SOCKET_DEADLINE_MS);
  } finally {
    host.closeAllConnections();
    await host.close();
  }
}, 30_000);
