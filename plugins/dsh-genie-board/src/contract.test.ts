import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LANELESS_MESSAGE } from './schema';
import { BoardService } from './service';

/**
 * The producer/consumer contract, proved against the REAL CLI instead of a
 * hand-written fixture: every assertion below runs `bun <repo>/src/genie.ts`
 * through the plugin's own process layer and parses its stdout with the
 * plugin's own schemas. A pinned key list on each side could agree with itself
 * while disagreeing with genie; this cannot (F11).
 */
const repository = resolve(import.meta.dir, '../../..');
let workspace = '';
let binary = '';
let service: BoardService;
let board = '';
let task = '';
const environment = { GENIE_HOME: process.env.GENIE_HOME };

async function genie(...argv: string[]): Promise<string> {
  const child = Bun.spawn([binary, ...argv], {
    cwd: workspace,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`genie ${argv.join(' ')} exited ${code}: ${stderr}`);
  return stdout;
}
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'genie-contract-'));
  process.env.GENIE_HOME = join(workspace, 'home');
  await mkdir(join(workspace, '.genie'));
  binary = join(workspace, 'genie');
  await writeFile(binary, `#!/bin/sh\nexec bun ${join(repository, 'src/genie.ts')} "$@"\n`, { mode: 0o755 });
  await Bun.spawn(['git', 'init', '-q', '.'], { cwd: workspace }).exited;
  // Duplicate lane names are what `--lanes A,A` stores; the plugin must open it.
  await genie('board', 'create', 'Dup', '--lanes', 'A,A');
  board = (JSON.parse(await genie('board', 'list', '--json')) as { id: string }[])[0].id;
  await genie('task', 'create', '--title', 'Ship it', '--board', board);
  task = (JSON.parse(await genie('task', 'list', '--json')) as { id: string }[])[0].id;
  await genie('task', 'comment', '--', task, 'line one\nline two');
  service = new BoardService({ list: () => [{ id: 'w', path: workspace, title: 'Workspace' }] }, binary);
}, 120_000);
afterAll(async () => {
  service?.dispose();
  Object.assign(process.env, environment);
  if (workspace) await rm(workspace, { recursive: true, force: true });
});
const list = () => service.request({ action: 'list', workspaceId: 'w' });
const load = () => service.request({ action: 'load', workspaceId: 'w', boardRef: board });

test('the plugin schemas accept the real CLI output, duplicate lanes and typed newlines included', async () => {
  const boards = (await list()) as { id: string; name: string; laneCount: number; cardCount: number }[];
  expect(boards).toEqual([{ id: board, name: 'Dup', laneCount: 2, cardCount: 1 }]);
  const aggregate = (await load()) as {
    schemaVersion: number;
    lanes: { name: string; cards: Record<string, unknown>[] }[];
  };
  expect(aggregate.schemaVersion).toBe(1);
  expect(aggregate.lanes.map((lane) => lane.name)).toEqual(['A', 'A']);
  const card = aggregate.lanes[0].cards[0];
  expect(card.id).toBe(task);
  expect(card).toMatchObject({ eventCount: 1, eventsTruncated: false, commentCount: 1 });
  expect((card.comments as { note: string }[])[0].note).toBe('line one\nline two');
}, 120_000);
test('a card claimed through the plugin renders fresh, and claiming it twice reports the CLI refusal', async () => {
  await list();
  await load();
  const aggregate = (await service.request({ action: 'checkout', workspaceId: 'w', boardRef: board, id: task })) as {
    lanes: { cards: { id: string; liveness: string | null; heartbeatAt: number | null; claimedBy: string }[] }[];
  };
  const card = aggregate.lanes.flatMap((lane) => lane.cards).find((entry) => entry.id === task);
  expect(card?.claimedBy).toBe(service.identity);
  expect(card?.heartbeatAt).toBeNumber();
  expect(card?.liveness).toBe('running');
  const refusal = await service
    .request({ action: 'checkout', workspaceId: 'w', boardRef: board, id: task })
    .catch((error: Error) => error.message);
  expect(refusal).toStartWith('Error: ');
  expect(refusal).toContain(task);
  // The refusal changed nothing, so the board is still selected.
  await load();
}, 120_000);
test('the CLI refuses an empty comment note, so only imported data carries one', async () => {
  const child = Bun.spawn([binary, 'task', 'comment', '--', task, ''], {
    cwd: workspace,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).toBe(1);
  expect(stderr).toContain('a non-empty comment is required.');

  // The schema still has to accept an empty note, because an imported snapshot
  // can carry one and the aggregate emits it verbatim (m13).
  const file = join(workspace, '.genie', 'roadmap.json');
  await genie('task', 'export', '--write');
  const snapshot = JSON.parse(await readFile(file, 'utf8')) as {
    task_events: { kind: string; note: string | null }[];
  };
  const comment = snapshot.task_events.find((event) => event.kind === 'comment');
  expect(comment).toBeDefined();
  if (comment) comment.note = '';
  await writeFile(file, JSON.stringify(snapshot));
  await genie('task', 'import', '--replace');
  await list();
  const aggregate = (await load()) as { lanes: { cards: { comments: { note: string }[] }[] }[] };
  const card = aggregate.lanes.flatMap((lane) => lane.cards)[0];
  expect(card.comments.map((entry) => entry.note)).toEqual(['']);
}, 120_000);
test('a laneless board is listed with no lanes and explains itself on load', async () => {
  const file = join(workspace, '.genie', 'roadmap.json');
  await genie('task', 'export', '--write');
  const snapshot = JSON.parse(await readFile(file, 'utf8')) as { boards: { lanes: string | null }[] };
  for (const entry of snapshot.boards) entry.lanes = null;
  await writeFile(file, JSON.stringify(snapshot));
  await genie('task', 'import', '--replace');
  const boards = (await list()) as { laneCount: number }[];
  expect(boards[0].laneCount).toBe(0);
  await expect(load()).rejects.toThrow(LANELESS_MESSAGE);
}, 120_000);
