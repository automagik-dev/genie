import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const temporary = await mkdtemp(join(tmpdir(), 'genie-dsh-smoke-'));
const repo = join(temporary, 'repo');
const home = join(temporary, 'dsh');
const bin = join(temporary, 'bin');
const env = {
  ...process.env,
  DSH_HOME: home,
  GENIE_HOME: join(temporary, 'genie-home'),
  HOME: join(temporary, 'home'),
  PATH: `${bin}${delimiter}${process.env.PATH}`,
};
let server: ChildProcess | undefined;
let installed = false;
async function command(binary: string, args: string[], cwd = root): Promise<string> {
  const proc = Bun.spawn([binary, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code) throw new Error(`${binary} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`);
  console.log(`${binary} ${args.join(' ')}: OK`);
  return stdout;
}
async function stop() {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolveStop) => {
    child.once('close', () => {
      clearTimeout(timer);
      resolveStop();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
  });
}
async function start(): Promise<string> {
  server = spawn(
    'dsh',
    ['web', '--patch', join(temporary, 'fixture.patch.yml'), '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const child = server;
  return new Promise((resolveStart, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`DSH startup timeout\n${output}`)), 45000);
    const receive = (data: Buffer) => {
      output += data.toString();
      const url = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/.exec(output)?.[0];
      if (url) {
        clearTimeout(timer);
        resolveStart(url);
      }
    };
    child.stdout?.on('data', receive);
    child.stderr?.on('data', receive);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`DSH exited ${code}\n${output}`));
    });
  });
}
try {
  for (const directory of [repo, bin, env.HOME]) await mkdir(directory, { recursive: true });
  await command('git', ['init', '--quiet'], repo);
  await command('bun', ['run', 'build']);
  await writeFile(
    join(bin, 'genie'),
    `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${join(root, 'dist/genie.js').replaceAll("'", "'\\''")}' "$@"\n`,
    { mode: 0o755 },
  );
  await command('genie', ['--no-interactive', 'board', 'create', 'Smoke'], repo);
  // Fixture-only Host plugin calls the actual installed registry's public API.
  const fixture = join(temporary, 'fixture.mjs');
  await writeFile(
    fixture,
    `export const inject=['workspaceRegistry']; export async function apply(ctx){await ctx.workspaceRegistry.create(${JSON.stringify(repo)},'Smoke workspace');}`,
  );
  await writeFile(
    join(temporary, 'fixture.patch.yml'),
    `- insert:\n    - id: smoke-workspace\n      name: ${JSON.stringify(fixture)}\n`,
  );
  await command('dsh', ['plugin', '--profile', 'web', 'add', `link:${join(root, 'plugins/dsh-genie-board')}`]);
  installed = true;
  await start();
  console.log('First launch authenticated URL received');
  await stop();
  const listed = await command('dsh', ['plugin', '--profile', 'web', 'list', '--depth', '0']);
  if (!listed.includes('@automagik/genie-dsh-board')) throw new Error('Installed plugin missing from list');
  const launchUrl = await start();
  const origin = new URL(launchUrl).origin;
  const exchange = await fetch(launchUrl, { redirect: 'manual' });
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('DSH token exchange did not set cookie');
  for (const invalidCookie of ['', 'dsh_session=invalid']) {
    const denied = await fetch(`${origin}/api/genie-board/health`, {
      headers: { origin, cookie: invalidCookie, 'sec-fetch-site': 'same-origin' },
    });
    if (denied.status !== 401) throw new Error('Missing/invalid DSH cookie was accepted');
  }
  const request = async (path: string, data?: unknown) => {
    const response = await fetch(`${origin}/api/genie-board/${path}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { origin, cookie, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  };
  let health: { compatible?: boolean } = {};
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      health = await request('health');
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  if (!health.compatible) throw new Error(`Incompatible health: ${JSON.stringify(health)}`);
  const workspaces = await request('workspaces');
  const workspaceId = workspaces[0]?.id;
  const boards = await request('action', { action: 'list', workspaceId });
  const boardRef = boards[0]?.id;
  await request('action', { action: 'load', workspaceId, boardRef });
  const created = await request('action', { action: 'create', workspaceId, boardRef, title: 'DSH smoke task' });
  const id = created.lanes
    .flatMap((lane: { cards: { id: string; title: string }[] }) => lane.cards)
    .find((card: { title: string }) => card.title === 'DSH smoke task')?.id;
  if (!id) throw new Error('Create did not return complete task');
  const lane = created.lanes[1].name;
  const moved = await request('action', { action: 'move', workspaceId, boardRef, id, lane });
  if (
    !moved.lanes
      .find((entry: { name: string }) => entry.name === lane)
      .cards.some((card: { id: string }) => card.id === id)
  )
    throw new Error('Move not confirmed');
  const commented = await request('action', { action: 'comment', workspaceId, boardRef, id, text: '--help' });
  const commentCard = commented.lanes
    .flatMap((entry: { cards: { id: string; comments: { note: string }[] }[] }) => entry.cards)
    .find((entry: { id: string }) => entry.id === id);
  if (!commentCard?.comments.some((entry: { note: string }) => entry.note === '--help'))
    throw new Error('Option-shaped comment was not stored literally');
  console.log(
    JSON.stringify({
      dsh: await command('dsh', ['--version']),
      health,
      origin,
      workspaceId,
      boardRef,
      id,
      lane,
      result: 'PASS: install/list/restart/health/load/create/move',
    }),
  );
} finally {
  await stop();
  try {
    if (installed) await command('dsh', ['plugin', '--profile', 'web', 'remove', '@automagik/genie-dsh-board']);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    console.log('Temporary profile/repository removed');
  }
}
