import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cardSchema } from './schema';

const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives';
/** The three primitive icons the panels draw, by the stem both spellings share. */
const ICONS = ['Refresh', 'Plus', 'Search'] as const;
/**
 * The two spellings a Host's primitives table has carried: `IconXOutline16` up to
 * 0.1.6-alpha.2, `IconXOutlineRegular` (and `…Medium`) from 0.1.7-alpha.1, with no alias.
 */
type Spelling = 'OutlineRegular' | 'Outline16';

/** A stand-in for the Host's frozen primitives table, carrying one icon spelling or none. */
function primitivesTable(spelling: Spelling | undefined): Record<string, unknown> {
  const glyphs = spelling
    ? ICONS.map((stem) => `Icon${stem}${spelling}`).map((name) => [
        name,
        () => createElement('i', { 'data-icon': name }),
      ])
    : [];
  return Object.freeze({
    Button: ({ icon, children }: { icon?: unknown; children?: unknown }) =>
      createElement('button', { type: 'button' }, icon as never, children as never),
    Tag: ({ children }: { children?: unknown }) => createElement('span', { className: 'tag' }, children as never),
    StateDot: () => null,
    ...Object.fromEntries(glyphs),
  });
}

/**
 * The browser half, rendered on a DOM stand-in.
 *
 * DSH serves React and its own UI primitives from a frozen browser module table
 * that exists only inside the Host, so the primitives are stubbed to the plain
 * elements they wrap; React itself is real, and so is every component under
 * test. The stub carries the icon names the current Host serves and only those.
 */
mock.module(PRIMITIVES, () => primitivesTable('OutlineRegular'));

const { Audit, auditLabel, BoardPicker, boardOptionLabel, Conversation, showingLabel } = await import(
  './client/BoardPanel'
);

/** A card exactly as `genie board --board <id> --json` emits it, through the shipped schema. */
function seedCard(comments: number, otherEvents: number) {
  const events: { id: number; kind: string; note: string; authorKind: string; author: string; createdAt: number }[] =
    [];
  for (let index = 0; index < comments; index++)
    events.push({
      id: events.length + 1,
      kind: 'comment',
      note: `comment ${index + 1}`,
      authorKind: 'human',
      author: 'felipe',
      createdAt: 1_000 + events.length,
    });
  for (let index = 0; index < otherEvents; index++)
    events.push({
      id: events.length + 1,
      kind: index % 2 === 0 ? 'claim' : 'release',
      note: null as unknown as string,
      authorKind: 'agent',
      author: 'claude',
      createdAt: 1_000 + events.length,
    });
  // The emitter keeps the newest 25 of each stream independently and reports the
  // true totals; see BOARD_JSON_EVENT_LIMIT in src/lib/v5/task-state.ts.
  const limit = 25;
  const commentEvents = events.filter((event) => event.kind === 'comment');
  return cardSchema.parse({
    id: 't_seed',
    boardId: 'b_seed',
    title: 'Seeded card',
    status: 'in_progress',
    claimedBy: 'claude',
    claimedAt: 1_000,
    wish: null,
    group: null,
    assignedAgent: null,
    assignedReason: null,
    createdAt: 900,
    updatedAt: 2_000,
    lane: 'Work',
    enforcedBlock: null,
    agentKind: 'agent',
    heartbeatAt: null,
    blockedBy: null,
    blockedReason: null,
    liveness: 'idle',
    dependencies: [],
    timeline: events.slice(-limit),
    eventCount: events.length,
    eventsTruncated: events.length > limit,
    comments: commentEvents
      .slice(-limit)
      .map(({ id, note, authorKind, author, createdAt }) => ({ id, note, authorKind, author, createdAt })),
    commentCount: commentEvents.length,
  });
}

const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

test('the picker marks a board that carries no lanes, and only that board', () => {
  const boards = [
    { id: 'b_lanes', name: 'Roadmap', laneCount: 4, cardCount: 12 },
    { id: 'b_none', name: 'trulyNoLanes', laneCount: 0, cardCount: 1 },
  ];
  expect(boardOptionLabel(boards[0])).toBe('Roadmap · 12');
  expect(boardOptionLabel(boards[1])).toBe('trulyNoLanes · 1 (no lanes)');
  const html = render(
    createElement(BoardPicker, { boards, value: 'b_lanes', disabled: false, onSelect: () => undefined }),
  );
  expect(html).toContain('trulyNoLanes · 1 (no lanes)');
  // The lane board is not marked, so the mark means something.
  expect(html).toContain('>Roadmap · 12<');
  expect(html.match(/\(no lanes\)/g)?.length).toBe(1);
});

test('the Comments pane renders the comment window and says how much of it is showing', () => {
  const card = seedCard(30, 6);
  // The fixture is the aggregate's own shape: two independently capped windows.
  expect([card.comments.length, card.commentCount]).toEqual([25, 30]);
  expect([card.timeline.length, card.eventCount, card.eventsTruncated]).toEqual([25, 36, true]);
  const html = render(createElement(Conversation, { card, busy: false, onSend: () => undefined }));
  // Every rendered message is a comment from `comments`, never a filter over the
  // 25-event window (which holds only 19 of them).
  expect(html.match(/<article/g)?.length).toBe(25);
  expect(html).toContain('comment 6');
  expect(html).toContain('comment 30');
  expect(html).not.toContain('comment 5<');
  expect(html).toContain('showing last 25 of 30');
});

test('an untruncated card shows the pane without a window label', () => {
  const card = seedCard(3, 2);
  expect([card.comments.length, card.commentCount, card.eventsTruncated]).toEqual([3, 3, false]);
  const html = render(createElement(Conversation, { card, busy: false, onSend: () => undefined }));
  expect(html.match(/<article/g)?.length).toBe(3);
  expect(html).not.toContain('showing last');
  expect(showingLabel(3, 3)).toBeUndefined();
  expect(showingLabel(25, 30)).toBe('showing last 25 of 30');
});

test('a worker report is readable in History, body and all', () => {
  const body = 'done: 12 tests pass, migration applied';
  const card = seedCard(1, 0);
  const reported = cardSchema.parse({
    ...card,
    timeline: [
      ...card.timeline,
      { id: 99, kind: 'report', note: body, authorKind: 'agent', author: 'eng-A', createdAt: 1_500 },
    ],
    eventCount: card.eventCount + 1,
  });
  // The Comments pane is the `comments` window, which the emitter builds from
  // comment events only, so a report never appears there...
  const chat = render(createElement(Conversation, { card: reported, busy: false, onSend: () => undefined }));
  expect(chat).not.toContain(body);
  // ...which makes History the only surface that can carry the handoff text.
  const history = render(createElement(Audit, { card: reported, now: 2_000 }));
  expect(history).toContain(`Reported: ${body}`);
  expect(auditLabel({ id: 1, kind: 'report', note: body, author: null, authorKind: null, createdAt: 0 })).toBe(
    `Reported: ${body}`,
  );
  // A report with no note is still just the label, and the other kinds are unchanged.
  expect(auditLabel({ id: 2, kind: 'report', note: null, author: null, authorKind: null, createdAt: 0 })).toBe(
    'Reported',
  );
  expect(auditLabel({ id: 3, kind: 'comment', note: 'hi', author: null, authorKind: null, createdAt: 0 })).toBe(
    'Commented',
  );
  expect(auditLabel({ id: 4, kind: 'move', note: null, author: null, authorKind: null, createdAt: 0 })).toBe('move');
  expect(auditLabel({ id: 5, kind: 'move', note: 'to Work', author: null, authorKind: null, createdAt: 0 })).toBe(
    'Moved to Work',
  );
  expect(
    auditLabel({ id: 6, kind: 'claim', note: 'claimed by eng-A', author: null, authorKind: null, createdAt: 0 }),
  ).toBe('Claimed (eng-A)');
  expect(auditLabel({ id: 7, kind: 'nova', note: 'x', author: null, authorKind: null, createdAt: 0 })).toBe('nova: x');
});

/**
 * The shipped browser bundle, evaluated the way the Host evaluates it: `client.js`
 * registers a factory with `window.__ModuleLoader__`, and the factory's `require`
 * serves the frozen module table. A primitive the table does not carry is simply
 * `undefined` there, so a panel that renders a missing name fails exactly as it
 * does in DSH Web. Every table a Host in the declared range can serve must render.
 */
describe('the browser bundle on every primitives table the range admits', () => {
  const plugin = join(import.meta.dir, '..');
  const platform = createRequire(import.meta.url);
  let output = '';
  let bundle = '';
  let iconsBundle = '';
  /** The plugin folder's entries before the build: the suite must add none of its own. */
  let pluginEntries: string[] = [];

  beforeAll(async () => {
    pluginEntries = await readdir(plugin);
    output = await mkdtemp(join(tmpdir(), 'genie-client-tables-'));
    const version = JSON.parse(await readFile(join(plugin, '../../package.json'), 'utf8')).version;
    // The build gets a home of its own inside this test's temp tree. Inherited, HOME can be
    // the string "undefined" by the time this runs in the full suite (a test that restores an
    // unset variable through process.env writes that string), and bun then creates its
    // install cache at ./undefined/.bun/install/cache inside this package.
    const home = join(output, 'home');
    const env = { ...process.env, HOME: home, BUN_INSTALL_CACHE_DIR: join(home, '.bun', 'install', 'cache') };
    const dist = join(output, 'dist');
    const proc = Bun.spawn(['bun', 'run', 'build', version, dist], {
      cwd: plugin,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`plugin build failed: ${stderr}`);
    bundle = await readFile(join(dist, 'client.js'), 'utf8');
    // The search glyph sits in a filtered-empty state the first render never reaches,
    // so its resolution is checked on the icons module alone, bundled the same way.
    const built = await build({
      entryPoints: [join(plugin, 'src/client/icons.tsx')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'cjs',
      jsx: 'automatic',
      target: 'es2022',
      external: ['react', 'react/jsx-runtime', PRIMITIVES],
    });
    iconsBundle = built.outputFiles[0]?.text ?? '';
  }, 20_000);

  afterAll(async () => {
    await rm(output, { recursive: true, force: true });
  });

  /** `require` over the frozen table: real React, the given primitives, nothing else. */
  const tableRequire = (primitives: Record<string, unknown>) => (id: string) => {
    if (id === PRIMITIVES) return primitives;
    if (id === 'react' || id === 'react/jsx-runtime') return platform(id);
    throw new Error(`Unexpected browser dependency: ${id}`);
  };

  /** The panels `apply` registers in the `main` slot once health says both rows are mounted. */
  async function panelsOn(primitives: Record<string, unknown>): Promise<Map<string, () => unknown>> {
    let registration: { factory: (require: (id: string) => unknown) => { apply(ctx: unknown): void } } | undefined;
    runInNewContext(bundle, {
      window: {
        __ModuleLoader__: {
          load(value: typeof registration) {
            registration = value;
          },
        },
      },
      document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
      fetch: async () => ({ ok: true, json: async () => ({ mounted: { board: true, workflows: true } }) }),
      URLSearchParams,
      console,
    });
    const client = registration?.factory(tableRequire(primitives));
    const panels = new Map<string, () => unknown>();
    client?.apply({
      effect: (effect: () => unknown) => void effect(),
      slots: {
        inject: (_slot: string, register: () => unknown) => void register(),
        register: (options: { name: string; key?: string }, component: () => unknown) => {
          if (options.name === 'main' && options.key) panels.set(options.key, component);
          return () => {};
        },
      },
    });
    for (let tick = 0; tick < 100 && panels.size < 2; tick++) await new Promise((done) => setTimeout(done, 1));
    return panels;
  }

  /** The three icon components `icons.tsx` resolves against the given table. */
  function iconsOn(primitives: Record<string, unknown>): Record<string, unknown> {
    const module = { exports: {} as Record<string, unknown> };
    new Function('require', 'module', 'exports', iconsBundle)(tableRequire(primitives), module, module.exports);
    return module.exports;
  }

  const TABLES: [string, Spelling | undefined][] = [
    ['(a) the current names only (IconXOutlineRegular, primitives 0.1.7-alpha.1 on)', 'OutlineRegular'],
    ['(b) the earlier names only (IconXOutline16, primitives up to 0.1.6-alpha.2)', 'Outline16'],
    ['(c) neither spelling', undefined],
  ];

  for (const [label, spelling] of TABLES) {
    test(`${label}: both panels render, with each icon the table carries`, async () => {
      const panels = await panelsOn(primitivesTable(spelling));
      expect([...panels.keys()].sort()).toEqual(['genie-board', 'genie-workflows']);
      const board = renderToStaticMarkup(createElement(panels.get('genie-board') as () => null));
      const workflows = renderToStaticMarkup(createElement(panels.get('genie-workflows') as () => null));
      // The controls keep their text whatever the table carries, so neither is ever icon-only.
      for (const html of [board, workflows]) expect(html).toContain('Refresh</button>');
      expect(board).toContain('Add</button>');
      const glyph = (stem: string) => `data-icon="Icon${stem}${spelling}"`;
      if (spelling) {
        for (const html of [board, workflows]) expect(html).toContain(glyph('Refresh'));
        expect(board).toContain(glyph('Plus'));
      } else {
        expect(`${board}${workflows}`).not.toContain('data-icon');
      }
      const icons = iconsOn(primitivesTable(spelling));
      const search = renderToStaticMarkup(createElement(icons.IconSearch as () => null));
      expect(search).toBe(spelling ? `<i ${glyph('Search')}></i>` : '');
    });
  }

  // Whatever a spawned build or a cache writes, it writes inside this suite's temp tree:
  // a new entry here is a file the suite left in the source tree (it once was ./undefined).
  test('the suite leaves the plugin folder as it found it', async () => {
    const added = (await readdir(plugin)).filter((entry) => !pluginEntries.includes(entry));
    expect(added).toEqual([]);
  });
});
