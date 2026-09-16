import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

/** How the smoke runs a child process; injected so the build step is testable. */
export type Runner = (binary: string, args: string[], cwd?: string) => Promise<string>;

/**
 * The bundles `dsh plugin add link:` loads out of the plugin directory: one
 * host bundle per cordis row (manager, board, skills, workflows) plus the one
 * client bundle the whole suite shares.
 */
export const PLUGIN_BUNDLES = ['index.js', 'board.js', 'skills.js', 'workflows.js', 'client.js'] as const;

/**
 * Build the plugin the smoke is about to install.
 *
 * `plugins/dsh-genie-board/dist` is gitignored build output, so without this
 * the smoke either failed at install on a clean checkout or — worse — PASSed
 * against whatever bundle a developer happened to have built earlier, which
 * is a green smoke for code that is not under test. The stale dist is removed
 * first so a failed build can never leave one behind for the next run either.
 */
export async function buildPluginDist(repoRoot: string, run: Runner): Promise<string[]> {
  const dist = join(repoRoot, 'plugins/dsh-genie-board/dist');
  await rm(dist, { recursive: true, force: true });
  try {
    await run('bun', ['run', 'build:plugin'], repoRoot);
  } catch (error) {
    throw new Error(
      `plugin build failed — refusing to smoke a stale dist: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const built: string[] = [];
  for (const name of PLUGIN_BUNDLES) {
    const path = join(dist, name);
    const bundle = await stat(path).catch(() => undefined);
    if (!bundle?.isFile() || !bundle.size) throw new Error(`plugin build produced no ${name}: ${path}`);
    built.push(path);
  }
  return built;
}

/**
 * Every writable location a child of the smoke may touch lives under the run's
 * own temp tree, which the `finally` block removes — including the child temp
 * directory. Without `TMPDIR`, `dsh` spilled a `dsh-spill-*` directory straight
 * into the host's `TMPDIR`, where nothing the smoke owns could clean it up
 * (r2 c5). `TMP`/`TEMP` ride along for portability.
 */
export function sandboxEnvironment(temporary: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const temp = join(temporary, 'tmp');
  return {
    ...(base as Record<string, string>),
    DSH_HOME: join(temporary, 'dsh'),
    GENIE_HOME: join(temporary, 'genie-home'),
    HOME: join(temporary, 'home'),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    PATH: `${join(temporary, 'bin')}${delimiter}${base.PATH}`,
  };
}

/** The directories `sandboxEnvironment` promises exist before any child runs. */
export function sandboxDirectories(temporary: string): string[] {
  return [join(temporary, 'repo'), join(temporary, 'bin'), join(temporary, 'home'), join(temporary, 'tmp')];
}

/**
 * Every route the Genie suite can own, as a browser would ask for it. With the
 * manager row disabled not one of them may exist.
 */
export const GENIE_ROUTES = [
  'health',
  'workspaces',
  'action',
  'skills?workspaceId=x',
  'skills/document?workspaceId=x&name=wish',
  'workflows?workspaceId=x',
  'workflows/document?workspaceId=x&name=work',
] as const;

/**
 * How long a manager-disabled Host must stay up before the smoke believes it.
 *
 * `dsh web` prints its authenticated URL BEFORE the loader audits the settled
 * plugin tree, so a URL is not a boot. The regression this phase owns exited
 * ~1.3 s after printing one, with `3 entries did not activate / ...: pending
 * (waiting for service: genieRuntime)`; ten seconds is that gap with room.
 */
export const BOOT_SETTLE_MS = 10_000;

/**
 * Acceptance proof for disable-by-id, against the REAL four-row patch.
 *
 * The profile turns `genie-dsh-board-skills` off by its id; the row must then
 * register no route at all, and the manager's health must report it unmounted
 * — that flag is exactly what the browser gates its Skills panel on, so an
 * operator can never be left with a panel whose first request 404s.
 */
async function assertDisabledRow(launchUrl: string): Promise<Record<string, boolean>> {
  const origin = new URL(launchUrl).origin;
  const exchange = await fetch(launchUrl, { redirect: 'manual' });
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('DSH token exchange did not set a cookie on the disabled-row launch');
  const read = (path: string) =>
    fetch(`${origin}/api/genie-board/${path}`, {
      headers: { origin, cookie, 'sec-fetch-site': 'same-origin' },
    });
  let mounted: Record<string, boolean> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await read('health');
    if (response.ok) {
      mounted = ((await response.json()) as { mounted?: Record<string, boolean> }).mounted;
      break;
    }
    await Bun.sleep(100);
  }
  if (!mounted) throw new Error('Disabled-row launch never answered health');
  if (mounted.skills !== false) throw new Error(`Disabled row still reports mounted: ${JSON.stringify(mounted)}`);
  if (mounted.board !== true || mounted.workflows !== true)
    throw new Error(`Disabling one row unmounted another: ${JSON.stringify(mounted)}`);
  for (const path of ['skills?workspaceId=x', 'skills/document?workspaceId=x&name=wish']) {
    const response = await read(path);
    if (response.status !== 404) throw new Error(`Disabled row still serves /${path} (${response.status})`);
  }
  // The rows that stayed enabled still answer through the one fence.
  if ((await read('workspaces')).status !== 200) throw new Error('Disabling one row broke the board row');
  return mounted;
}

/**
 * Acceptance proof for V1: the MANAGER row disabled by its id.
 *
 * The three sub-rows used to declare `inject: ['genieRuntime']`, a HARD cordis
 * dependency, so turning the manager off parked all three loader entries in
 * PENDING and DSH's boot audit killed the Host — an operator could disable one
 * plugin row and lose their whole shell. DSH must instead boot with the Genie
 * suite simply absent: no health route, no board routes, no catalog routes.
 */
async function assertManagerDisabled(
  launchUrl: string,
  child: () => ChildProcess | undefined,
): Promise<Record<string, number>> {
  const origin = new URL(launchUrl).origin;
  const exchange = await fetch(launchUrl, { redirect: 'manual' });
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('DSH token exchange did not set a cookie on the manager-disabled launch');
  // Surviving the tree audit is the assertion; the printed URL is not.
  await Bun.sleep(BOOT_SETTLE_MS);
  const running = child();
  if (!running || running.exitCode !== null || running.signalCode !== null)
    throw new Error(
      `DSH did not survive boot with the manager row disabled (exit ${String(running?.exitCode)}/${String(running?.signalCode)})`,
    );
  const statuses: Record<string, number> = {};
  for (const path of GENIE_ROUTES) {
    const mutation = path === 'action';
    const response = await fetch(`${origin}/api/genie-board/${path}`, {
      method: mutation ? 'POST' : 'GET',
      headers: { origin, cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      ...(mutation ? { body: JSON.stringify({ action: 'list', workspaceId: 'x' }) } : {}),
    });
    if (response.status !== 404)
      throw new Error(`Manager-disabled Host still serves /api/genie-board/${path} (${response.status})`);
    statuses[path] = response.status;
  }
  return statuses;
}

const root = resolve(import.meta.dir, '..');
async function main(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'genie-dsh-smoke-'));
  const repo = join(temporary, 'repo');
  const bin = join(temporary, 'bin');
  const env = sandboxEnvironment(temporary);
  let server: ChildProcess | undefined;
  let installed = false;
  async function command(binary: string, args: string[], cwd = root): Promise<string> {
    const proc = Bun.spawn([binary, ...args], {
      cwd,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
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
  async function start(patch = 'fixture.patch.yml'): Promise<string> {
    server = spawn(
      'dsh',
      ['web', '--patch', join(temporary, patch), '--no-open', '--host', '127.0.0.1', '--port', '0'],
      {
        cwd: repo,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
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
    for (const directory of sandboxDirectories(temporary)) await mkdir(directory, { recursive: true });
    await command('git', ['init', '--quiet'], repo);
    await command('bun', ['run', 'build']);
    // Smoke the bundle this checkout produces, never one left over from before.
    await buildPluginDist(root, command);
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
    const workspaceRow = `- insert:\n    - id: smoke-workspace\n      name: ${JSON.stringify(fixture)}\n`;
    await writeFile(join(temporary, 'fixture.patch.yml'), workspaceRow);
    // The acceptance proof for disable-by-id: the same profile with one of the
    // four rows turned off by its id, exactly as an operator would write it.
    await writeFile(
      join(temporary, 'fixture-disabled.patch.yml'),
      `${workspaceRow}- id: genie-dsh-board-skills\n  disabled: true\n`,
    );
    // ... and the same profile with the MANAGER row off instead, which is the
    // one row every other row used to depend on to exist.
    await writeFile(
      join(temporary, 'fixture-manager-disabled.patch.yml'),
      `${workspaceRow}- id: genie-dsh-board\n  disabled: true\n`,
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
    // Phase two: the same four-row patch with one SUB-row disabled by its id.
    await stop();
    const mounted = await assertDisabledRow(await start('fixture-disabled.patch.yml'));
    // Phase three: the same patch with the MANAGER row disabled by its id.
    await stop();
    const managerOff = await assertManagerDisabled(await start('fixture-manager-disabled.patch.yml'), () => server);
    console.log(
      JSON.stringify({
        dsh: await command('dsh', ['--version']),
        health,
        origin,
        workspaceId,
        boardRef,
        id,
        lane,
        mountedWithSkillsDisabled: mounted,
        routesWithManagerDisabled: managerOff,
        result: 'PASS: install/list/restart/health/load/create/move/disable-by-id/disable-manager',
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
}

if (import.meta.main) await main();
