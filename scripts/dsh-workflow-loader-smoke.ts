import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/** How the smoke runs a child process; injected so the build step is testable. */
export type Runner = (binary: string, args: string[], cwd?: string) => Promise<string>;

/**
 * The bundle `dsh plugin add link:` loads out of the plugin directory.
 *
 * `plugins/dsh-workflow-loader/dist` is gitignored build output, so without the
 * build below the smoke either failed at install on a clean checkout or — worse —
 * PASSed against whatever bundle a developer happened to have built earlier,
 * which is a green smoke for code that is not under test. The stale dist is
 * removed first so a failed build can never leave one behind for the next run.
 */
export const PLUGIN_BUNDLES = ['index.js'] as const;

/** The row id the composed profile must carry, and the package that provides it. */
export const ROW_ID = 'genie-dsh-workflow-loader';
export const PACKAGE_NAME = '@automagik/genie-dsh-workflow-loader';

/**
 * How long a Host must stay up before the smoke believes it.
 *
 * `dsh web` prints its authenticated URL BEFORE the loader audits the settled
 * plugin tree, so a URL is not a boot: the recorded regression exits ~1.3 s after
 * printing one, with `N entries did not activate` / `pending (waiting for
 * service: …)` in its output. This smoke owns exactly that risk for a row whose
 * only service is `tools`, so the window is the same one the board's smoke uses.
 */
export const BOOT_SETTLE_MS = 10_000;

/** The boot-audit failures that mean the row did not activate. */
export const ACTIVATION_FAILURES = ['did not activate', 'waiting for service'] as const;

/**
 * Every writable location a child may touch lives under the run's own temp tree,
 * which the `finally` block removes. Without `TMPDIR`, `dsh` spills a
 * `dsh-spill-*` directory into the host's `TMPDIR`, where nothing the smoke owns
 * can clean it up. `TMP`/`TEMP` ride along for portability.
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

/** Build the plugin the smoke is about to install, and refuse a stale dist. */
export async function buildLoaderDist(repoRoot: string, run: Runner): Promise<string[]> {
  const dist = join(repoRoot, 'plugins/dsh-workflow-loader/dist');
  await rm(dist, { recursive: true, force: true });
  try {
    await run('bun', ['run', 'build'], join(repoRoot, 'plugins/dsh-workflow-loader'));
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

/** True when a Host's output carries a boot-audit failure. */
export function activationFailure(output: string): string | undefined {
  for (const marker of ACTIVATION_FAILURES) {
    if (output.includes(marker)) {
      const line = output.split('\n').find((entry) => entry.includes(marker));
      return line?.trim() ?? marker;
    }
  }
  return undefined;
}

/** A catalog the loader can see, so a booted host has something to resolve. */
async function writeCatalog(repo: string): Promise<string> {
  const workflows = join(repo, '.claude', 'workflows');
  await mkdir(workflows, { recursive: true });
  await writeFile(
    join(workflows, 'smoke.js'),
    [
      "export const meta = { name: 'smoke', description: 'the smoke catalog entry' }",
      'const answer = await agent("say ok", { label: "smoke", effort: "high" })',
      'return { ok: true, answer }',
      '',
    ].join('\n'),
  );
  return workflows;
}

async function main(): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'genie-loader-smoke-'));
  const repoRoot = join(import.meta.dir, '..');
  const repo = join(temporary, 'repo');
  const env = sandboxEnvironment(temporary);
  let server: ChildProcess | undefined;
  let output = '';

  async function command(binary: string, args: string[], cwd = repoRoot): Promise<string> {
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

  async function stop(): Promise<void> {
    const child = server;
    server = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => {
        clearTimeout(timer);
        resolveStop();
      });
      child.kill('SIGTERM');
    });
  }

  function start(): Promise<string> {
    server = spawn('dsh', ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
      cwd: repo,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = server;
    return new Promise((resolveStart, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`DSH startup timeout\n${output}`));
      }, 45_000);
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
    await mkdir(join(temporary, 'dsh', 'profiles'), { recursive: true });
    console.log(`smoke root: ${temporary}`);
    await buildLoaderDist(repoRoot, command);
    await writeCatalog(repo);

    await command('dsh', [
      'plugin',
      '--profile',
      'web',
      'add',
      `link:${join(repoRoot, 'plugins/dsh-workflow-loader')}`,
    ]);
    const listed = await command('dsh', ['plugin', '--profile', 'web', 'list', '--depth', '0']);
    if (!listed.includes(PACKAGE_NAME)) throw new Error(`package not listed after install:\n${listed}`);

    // Composition proof, not just an install: the row must be in the tree the
    // Host will actually mount.
    const composed = await command('dsh', ['--profile', 'web', '--dump-config']);
    if (!composed.includes(ROW_ID)) throw new Error(`row ${ROW_ID} is missing from the composed profile tree`);
    if (!composed.includes(PACKAGE_NAME)) throw new Error(`package ${PACKAGE_NAME} is missing from the composed tree`);
    console.log(`composed profile carries ${ROW_ID}: OK`);

    const launchUrl = await start();
    const origin = new URL(launchUrl).origin;
    const exchange = await fetch(launchUrl, { redirect: 'manual' });
    const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('DSH token exchange did not set a cookie');

    // The Host is up when it answers with its auth wall; the point of the wait is
    // that it is STILL up after the boot audit would have killed it.
    let alive = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${origin}/`, { headers: { cookie } }).catch(() => undefined);
      if (response?.status === 401 || response?.ok) {
        alive = true;
        break;
      }
      await Bun.sleep(100);
    }
    if (!alive) throw new Error(`Host never answered at ${origin}\n${output}`);

    await Bun.sleep(BOOT_SETTLE_MS);
    const failure = activationFailure(output);
    if (failure) throw new Error(`the loader row did not activate: ${failure}\n${output}`);
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Host exited ${server.exitCode} after boot\n${output}`);
    }
    const after = await fetch(`${origin}/`, { headers: { cookie } }).catch(() => undefined);
    if (!after) throw new Error(`Host stopped answering after ${BOOT_SETTLE_MS} ms\n${output}`);
    console.log(`loader row activated and the Host stayed up for ${BOOT_SETTLE_MS} ms: OK`);
    console.log('dsh-workflow-loader smoke: PASS');
  } finally {
    await stop();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
