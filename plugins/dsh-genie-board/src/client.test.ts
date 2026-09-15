import { afterEach, expect, test } from 'bun:test';
import { apply } from './client';

/**
 * The browser half has no DOM in `bun test`, so these tests mount it on a
 * deliberately small stand-in: only the handful of DOM features client.ts
 * actually uses. It is enough to drive the real code paths end to end —
 * launch, list, load, select a card, act on it — which is where the two
 * browser-side regressions live (a refused action must not wipe the board;
 * a laneless board must be labelled in the picker).
 */
class Node {
  textContent = '';
  className = '';
  private chosen: string | undefined;
  selected = false;
  disabled = false;
  required = false;
  placeholder = '';
  open = false;
  readonly attributes = new Map<string, string>();
  readonly children: Node[] = [];
  onclick: (() => void) | undefined;
  onchange: (() => void) | undefined;
  onsubmit: ((event: { preventDefault(): void }) => void) | undefined;
  constructor(readonly tag: string) {}
  /** A <select> answers with its chosen option, or its first one, like the real thing. */
  get value(): string {
    if (this.tag !== 'select') return this.chosen ?? '';
    const options = this.children.filter((child) => child.tag === 'option');
    if (this.chosen && options.some((option) => option.value === this.chosen)) return this.chosen;
    return options[0]?.value ?? '';
  }
  set value(value: string) {
    this.chosen = value;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  append(...nodes: Node[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Node[]) {
    this.children.splice(0, this.children.length, ...nodes);
  }
  remove() {
    /* Detached nodes are never inspected. */
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  querySelectorAll(selector: string): Node[] {
    const tags = selector.split(',');
    const found: Node[] = [];
    const walk = (node: Node) => {
      for (const child of node.children) {
        if (tags.includes(child.tag)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  /** Depth-first text search, the way a person picks a control by its label. */
  find(tag: string, text: string): Node {
    const match = this.querySelectorAll(tag).find((node) => node.textContent === text);
    if (!match) throw new Error(`no <${tag}> labelled ${JSON.stringify(text)}`);
    return match;
  }
  get text(): string[] {
    return this.querySelectorAll('h2,h3,p,li,button,option').map((node) => node.textContent);
  }
}
const card = {
  id: 't_abc',
  boardId: 'b_abc',
  title: 'Ship it',
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
  timeline: [{ id: 9, kind: 'created', note: null, authorKind: null, author: 'cli', createdAt: 1 }],
  eventCount: 41,
  eventsTruncated: true,
  comments: [{ id: 10, note: 'looks good', authorKind: null, author: 'cli', createdAt: 2 }],
  commentCount: 3,
};
const aggregate = {
  schemaVersion: 1,
  scope: 'Board',
  lanes: [
    { name: 'Ready', label: null, action: null, cards: [card] },
    { name: 'Done', label: null, action: null, cards: [] },
  ],
};
const boards = [
  { id: 'b_abc', name: 'Board', laneCount: 2, cardCount: 1 },
  { id: 'b_flat', name: 'Legacy', laneCount: 0, cardCount: 4 },
];
interface Mount {
  body: Node;
  status: Node;
  calls: { path: string; action?: string }[];
  answer(value: unknown, ok?: boolean): void;
  dispose(): void;
}
const originals = { document: globalThis.document, fetch: globalThis.fetch };
afterEach(() => {
  Object.assign(globalThis, originals);
});
function mount(): Mount {
  const body = new Node('body');
  const head = new Node('head');
  const calls: Mount['calls'] = [];
  let override: { value: unknown; ok: boolean } | undefined;
  (globalThis as { document: unknown }).document = {
    createElement: (tag: string) => new Node(tag),
    head,
    body,
    visibilityState: 'hidden',
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as { fetch: unknown }).fetch = async (path: string, init?: { body?: string }) => {
    const request = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, action: request?.action });
    if (override) {
      const { value, ok } = override;
      override = undefined;
      return { ok, json: async () => value };
    }
    const value = path.endsWith('health')
      ? { compatible: true, version: '1.0.0', error: '' }
      : path.endsWith('workspaces')
        ? [{ id: 'workspace', title: 'Workspace' }]
        : request?.action === 'list'
          ? boards
          : aggregate;
    return { ok: true, json: async () => value };
  };
  let dispose = () => {};
  apply({
    effect(effect) {
      dispose = effect();
    },
  });
  const dialog = body.children.find((node) => node.tag === 'dialog');
  if (!dialog) throw new Error('no dialog');
  return {
    body,
    status: dialog.querySelectorAll('div').find((node) => node.className === 'genie-status') as Node,
    calls,
    answer(value, ok = false) {
      override = { value, ok };
    },
    dispose,
  };
}
async function open(): Promise<Mount> {
  const view = mount();
  view.body.find('button', 'Genie board').onclick?.();
  await flush();
  return view;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a laneless board is named as such in the picker', async () => {
  const view = await open();
  const options = view.body.querySelectorAll('option').map((node) => node.textContent);
  expect(options).toContain('Board');
  expect(options).toContain('Legacy (no lanes)');
  view.dispose();
});
test('a refused action keeps the board and the open card, and shows the message', async () => {
  const view = await open();
  expect(view.body.find('button', 'Ship it')).toBeDefined();
  view.body.find('button', 'Ship it').onclick?.();
  expect(view.body.text).toContain('Claim');
  view.answer({ error: 'Error: Task t_abc is not claimable (already claimed or not ready)' });
  view.body.find('button', 'Claim').onclick?.();
  await flush();
  expect(view.status.textContent).toBe('Error: Task t_abc is not claimable (already claimed or not ready)');
  expect(view.status.attributes.get('role')).toBe('alert');
  // The board the message is about is still on screen, card detail included.
  expect(view.body.text).toContain('Ship it');
  expect(view.body.text).toContain('Claim');
  view.dispose();
});
test('a failed load clears the board, because its content is no longer known', async () => {
  const view = await open();
  view.answer({ error: 'Unknown board; list boards first' });
  view.body.find('button', 'Refresh').onclick?.();
  await flush();
  expect(view.status.textContent).toBe('Unknown board; list boards first');
  expect(view.body.text).not.toContain('Ship it');
  view.dispose();
});
test('truncated history and comments say which window is on screen', async () => {
  const view = await open();
  view.body.find('button', 'Ship it').onclick?.();
  expect(view.body.text).toContain('History — showing last 1 of 41');
  expect(view.body.text).toContain('Comments — showing last 1 of 3');
  view.dispose();
});
