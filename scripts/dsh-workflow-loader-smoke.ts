import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dshVersion, resolveDshBinary, sandboxEnvironment, withPinnedDsh } from './dsh-genie-board-smoke';

export { sandboxEnvironment };

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
/** The tool the row registers with its shipped configuration. */
export const TOOL_NAME = 'workflow_run';

/**
 * The profile the smoke installs the row into.
 *
 * The row injects `tools`, `workflowEngine` and `systemPrompt`, and it is a
 * HOST row: its bundle patch inserts it at the Host root. `headless` composes
 * `dsh-base` as it ships, whose Host root mounts `workflow-ptc` — the provider
 * of `workflowEngine`. `web` does not: the web app disables that Host-root row
 * and mounts `workflow-ptc` only inside each agent preset's isolated
 * `delegation` group, so on `web` this row stays `pending (waiting for service:
 * workflowEngine)` on every DSH version tried (0.1.7-rc.2 and 0.2.0-rc.1). The
 * live run the README records was a `headless` one for the same reason.
 */
export const PROFILE = 'headless';

/** The boot-audit failures that mean a row did not activate. */
export const ACTIVATION_FAILURES = ['did not activate', 'waiting for service'] as const;

/**
 * The line a credential-less `headless` run ends on. The smoke boots the whole
 * composition with a task and NO model credential, so the Host activates every
 * row, prints its activation audit, and stops before any model call. Seeing this
 * line is the proof that no model was reached; not seeing it fails the smoke.
 */
export const NO_MODEL_MARKER = 'MISSING_CREDENTIAL';

/**
 * Every writable location a child may touch lives under the run's own temp tree
 * (see `sandboxEnvironment`), and nothing that could reach a model rides along:
 * every `*_API_KEY` is dropped, so a credential in the operator's shell can never
 * turn the smoke into a paid run.
 */
export function smokeEnvironment(temporary: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env = sandboxEnvironment(temporary, base);
  for (const key of Object.keys(env)) if (/_API_KEY$/.test(key)) delete env[key];
  return env;
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

/**
 * A fixture Host row that asks the real `tools` registry whether the loader's
 * tool exists, and writes the answer to a file. An activation audit only says a
 * row is not pending; this says the row did the one thing it exists for.
 */
export function probeModule(): string {
  return [
    "import { writeFileSync } from 'node:fs';",
    "export const name = 'genie-loader-smoke-probe';",
    "export const inject = ['tools'];",
    'export function apply(ctx, config) {',
    '  const started = Date.now();',
    '  const report = (value) => writeFileSync(config.out, JSON.stringify({ tool: config.toolName, ...value }));',
    '  const check = () => {',
    '    let found;',
    '    try {',
    '      found = ctx.tools.get(config.toolName);',
    '    } catch (error) {',
    '      return report({ registered: false, error: String(error) });',
    '    }',
    '    if (found || Date.now() - started > 5000) return report({ registered: Boolean(found), ms: Date.now() - started });',
    '    setTimeout(check, 25);',
    '  };',
    '  check();',
    '}',
    '',
  ].join('\n');
}

/** The `--patch` overlay that mounts the probe beside the installed row. */
export function probePatch(modulePath: string, outPath: string): string {
  return [
    '- insert:',
    '    - id: genie-loader-smoke-probe',
    `      name: ${JSON.stringify(modulePath)}`,
    '      config:',
    `        toolName: ${TOOL_NAME}`,
    `        out: ${JSON.stringify(outPath)}`,
    '',
  ].join('\n');
}

/** The control overlay: the Host-root engine turned off, exactly as `web` does. */
export const ENGINE_OFF_PATCH = '- id: workflow-ptc\n  disabled: true\n';

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
  // Resolved before the temp tree exists, so a missing Host leaves nothing behind.
  const dsh = resolveDshBinary();
  let version: string;
  try {
    version = dshVersion(dsh, 'plugins/dsh-workflow-loader/README.md');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  console.log(`dsh: ${dsh} (version ${version})`);
  const temporary = await mkdtemp(join(tmpdir(), 'genie-loader-smoke-'));
  const repoRoot = join(import.meta.dir, '..');
  const repo = join(temporary, 'repo');
  const env = smokeEnvironment(temporary, withPinnedDsh(dsh));

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

  /** Boot the whole `headless` composition once; it ends at the missing credential. */
  async function boot(patches: string[]): Promise<string> {
    const args = ['--profile', PROFILE, ...patches.flatMap((patch) => ['--patch', patch]), 'say ok'];
    const proc = Bun.spawn([dsh, ...args], {
      cwd: repo,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const output = `${stdout}${stderr}`;
    if (!output.includes(NO_MODEL_MARKER)) {
      throw new Error(`the headless boot did not stop at ${NO_MODEL_MARKER}; refusing to trust it\n${output}`);
    }
    return output;
  }

  async function probe(out: string): Promise<{ registered?: boolean; ms?: number; error?: string } | undefined> {
    const text = await readFile(out, 'utf8').catch(() => undefined);
    return text === undefined ? undefined : JSON.parse(text);
  }

  try {
    for (const directory of sandboxDirectories(temporary)) await mkdir(directory, { recursive: true });
    await mkdir(join(temporary, 'dsh', 'profiles'), { recursive: true });
    console.log(`smoke root: ${temporary}`);
    await buildLoaderDist(repoRoot, command);
    await writeCatalog(repo);

    await command(dsh, [
      'plugin',
      '--profile',
      PROFILE,
      'add',
      `link:${join(repoRoot, 'plugins/dsh-workflow-loader')}`,
    ]);
    const listed = await command(dsh, ['plugin', '--profile', PROFILE, 'list', '--depth', '0']);
    if (!listed.includes(PACKAGE_NAME)) throw new Error(`package not listed after install:\n${listed}`);

    // Composition proof, not just an install: the row must be in the tree the
    // Host will actually mount.
    const composed = await command(dsh, ['--profile', PROFILE, '--dump-config']);
    if (!composed.includes(ROW_ID)) throw new Error(`row ${ROW_ID} is missing from the composed profile tree`);
    if (!composed.includes(PACKAGE_NAME)) throw new Error(`package ${PACKAGE_NAME} is missing from the composed tree`);
    console.log(`composed ${PROFILE} profile carries ${ROW_ID}: OK`);

    const probePath = join(temporary, 'probe.mjs');
    await writeFile(probePath, probeModule());
    const out = join(temporary, 'probe.json');
    await writeFile(join(temporary, 'probe.patch.yml'), probePatch(probePath, out));
    await writeFile(join(temporary, 'engine-off.patch.yml'), ENGINE_OFF_PATCH);

    // Phase one: the profile as it ships. Every row activates and the tool exists.
    const output = await boot([join(temporary, 'probe.patch.yml')]);
    const failure = activationFailure(output);
    if (failure) throw new Error(`the loader row did not activate: ${failure}\n${output}`);
    const registered = await probe(out);
    if (!registered?.registered) {
      throw new Error(`${TOOL_NAME} is not in the Host tools registry: ${JSON.stringify(registered)}\n${output}`);
    }
    console.log(`loader row activated and registered ${TOOL_NAME} in ${registered.ms} ms, no model reached: OK`);

    // Phase two, the control: the same boot with the Host-root engine off must
    // leave the row pending on `workflowEngine`. A smoke that cannot see this
    // difference is not measuring the row's dependency at all.
    await rm(out, { force: true });
    const control = await boot([join(temporary, 'probe.patch.yml'), join(temporary, 'engine-off.patch.yml')]);
    const pending = control.split('\n').find((line) => line.includes(ROW_ID) && line.includes('workflowEngine'));
    if (!pending) throw new Error(`with workflow-ptc off the row did not report waiting on workflowEngine\n${control}`);
    if ((await probe(out))?.registered) throw new Error(`${TOOL_NAME} registered with no workflowEngine to run it`);
    console.log(`control: with workflow-ptc off the row stays pending (${pending.trim()}): OK`);
    console.log(`dsh-workflow-loader smoke: PASS (dsh ${version}, profile ${PROFILE})`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
