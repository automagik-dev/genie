import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENGINE_OFF_PATCH,
  NO_MODEL_MARKER,
  PLUGIN_BUNDLES,
  PROFILE,
  TOOL_NAME,
  activationFailure,
  buildLoaderDist,
  probeModule,
  probePatch,
  sandboxDirectories,
  sandboxEnvironment,
  smokeEnvironment,
} from './dsh-workflow-loader-smoke';

const roots: string[] = [];

/**
 * A writable scratch root. `os.tmpdir()` is the convention and works in CI; a
 * sandbox that mounts its temp area read-only falls back to one beside the
 * script, which `afterEach` removes.
 */
function temporary(): string {
  let root: string;
  try {
    root = mkdtempSync(join(tmpdir(), 'loader-smoke-test-'));
  } catch {
    const base = join(import.meta.dir, '.loader-smoke-tmp');
    mkdirSync(base, { recursive: true });
    root = mkdtempSync(join(base, 'run-'));
  }
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the loader smoke', () => {
  test('isolates every writable location a child may touch', () => {
    const root = temporary();
    const env = sandboxEnvironment(root, { PATH: '/usr/bin', HOME: '/home/someone' } as NodeJS.ProcessEnv);
    expect(env.DSH_HOME).toBe(join(root, 'dsh'));
    expect(env.GENIE_HOME).toBe(join(root, 'genie-home'));
    expect(env.HOME).toBe(join(root, 'home'));
    expect(env.TMPDIR).toBe(join(root, 'tmp'));
    expect(env.TMP).toBe(join(root, 'tmp'));
    expect(env.TEMP).toBe(join(root, 'tmp'));
    // A child must not resolve anything out of the operator's home, and the
    // sandbox's own bin has to come first so a stub can stand in for `dsh`.
    expect(env.HOME).not.toBe('/home/someone');
    expect(env.PATH.startsWith(join(root, 'bin'))).toBe(true);
  });

  test('promises the directories it hands to a child', () => {
    const root = temporary();
    expect(sandboxDirectories(root)).toEqual([
      join(root, 'repo'),
      join(root, 'bin'),
      join(root, 'home'),
      join(root, 'tmp'),
    ]);
  });

  test('refuses to smoke a stale dist when the build produces nothing', async () => {
    const root = temporary();
    const dist = join(root, 'plugins/dsh-workflow-loader/dist');
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.js'), '// a bundle from some earlier build\n');
    await expect(buildLoaderDist(root, async () => '')).rejects.toThrow(/produced no index\.js/);
    // The stale bundle is gone before the failing build, so the next run cannot
    // pass against it either.
    expect(await Bun.file(join(dist, 'index.js')).exists()).toBe(false);
  });

  test('reports a failed build as a refusal, not as a stale success', async () => {
    const root = temporary();
    await expect(
      buildLoaderDist(root, async () => {
        throw new Error('esbuild: boom');
      }),
    ).rejects.toThrow(/refusing to smoke a stale dist: esbuild: boom/);
  });

  test('accepts the bundle the build actually produces', async () => {
    const root = temporary();
    const built = await buildLoaderDist(root, async (_binary, _args, cwd) => {
      mkdirSync(join(cwd!, 'dist'), { recursive: true });
      writeFileSync(join(cwd!, 'dist/index.js'), 'export const name = "genie-dsh-workflow-loader";\n');
      return '';
    });
    expect(built).toEqual([join(root, 'plugins/dsh-workflow-loader/dist/index.js')]);
    expect(PLUGIN_BUNDLES).toEqual(['index.js']);
  });

  test('finds an activation failure in a Host transcript', () => {
    // The transcript both DSH 0.1.7-rc.2 and 0.2.0-rc.1 print for this row on a
    // profile with no Host-root workflowEngine.
    const transcript = [
      'dsh: warning: 1 entry did not activate',
      'genie-dsh-workflow-loader (@automagik/genie-dsh-workflow-loader): pending (waiting for service: workflowEngine)',
    ].join('\n');
    expect(activationFailure(transcript)).toBe('dsh: warning: 1 entry did not activate');
    expect(activationFailure('dsh: listening on http://127.0.0.1:9/')).toBeUndefined();
  });
});

/**
 * The row injects `workflowEngine`, and only a profile that mounts
 * `workflow-ptc` at the Host root provides one there. `web` keeps it inside the
 * `standard`/`ptc` web presets' isolated `delegation` group, which is why the smoke used to fail on every Host version with
 * `pending (waiting for service: workflowEngine)`.
 */
describe('where the smoke exercises the row', () => {
  test('boots headless, the profile whose Host root carries workflowEngine', () => {
    expect(PROFILE).toBe('headless');
    const index = readFileSync(join(import.meta.dir, '../plugins/dsh-workflow-loader/src/index.ts'), 'utf8');
    expect(index).toContain("export const inject = ['tools', 'workflowEngine', 'systemPrompt'];");
  });

  test('its control turns off the same Host-root row web turns off', () => {
    expect(ENGINE_OFF_PATCH).toBe('- id: workflow-ptc\n  disabled: true\n');
    const source = readFileSync(join(import.meta.dir, 'dsh-workflow-loader-smoke.ts'), 'utf8');
    // The control must require the pending line naming this row and the engine.
    expect(source).toContain("line.includes(ROW_ID) && line.includes('workflowEngine')");
  });

  test('never reaches a model: no API key rides along, and a boot must stop at the missing credential', () => {
    const root = temporary();
    const env = smokeEnvironment(root, {
      PATH: '/usr/bin',
      DEEPSEEK_API_KEY: 'sk-real',
      OPENAI_API_KEY: 'sk-other',
      KEEP_ME: 'yes',
    } as NodeJS.ProcessEnv);
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.KEEP_ME).toBe('yes');
    expect(env.DSH_HOME).toBe(join(root, 'dsh'));
    expect(NO_MODEL_MARKER).toBe('MISSING_CREDENTIAL');
    const source = readFileSync(join(import.meta.dir, 'dsh-workflow-loader-smoke.ts'), 'utf8');
    expect(source).toContain('if (!output.includes(NO_MODEL_MARKER))');
  });

  test('the probe row mounts beside the installed row and reports what the registry holds', async () => {
    const root = temporary();
    const module = join(root, 'probe.mjs');
    const out = join(root, 'probe.json');
    writeFileSync(module, probeModule());
    expect(probePatch(module, out)).toBe(
      [
        '- insert:',
        '    - id: genie-loader-smoke-probe',
        `      name: ${JSON.stringify(module)}`,
        '      config:',
        `        toolName: ${TOOL_NAME}`,
        `        out: ${JSON.stringify(out)}`,
        '',
      ].join('\n'),
    );
    const probe = await import(module);
    expect(probe.inject).toEqual(['tools']);
    type Probe = { registered?: boolean; disposed?: boolean; error?: string; tool?: string };
    const answer = (): Probe => JSON.parse(readFileSync(out, 'utf8'));
    /** A context stand-in whose dispose hooks the test fires by hand. */
    const context = (get: (name: string) => unknown) => {
      const disposers: (() => void)[] = [];
      return {
        ctx: { tools: { get }, on: (event: string, hook: () => void) => event === 'dispose' && disposers.push(hook) },
        dispose: () => {
          for (const hook of disposers) hook();
        },
      };
    };

    const present = context((name) => (name === TOOL_NAME ? {} : undefined));
    probe.apply(present.ctx, { toolName: TOOL_NAME, out });
    expect(answer()).toMatchObject({ tool: TOOL_NAME, registered: true });
    // One answer only: a later dispose does not overwrite it.
    present.dispose();
    expect(answer()).toMatchObject({ registered: true });

    // An inactive context throws on read; that is an answer, not a crash.
    rmSync(out);
    probe.apply(
      context(() => {
        throw new Error('inactive context');
      }).ctx,
      { toolName: TOOL_NAME, out },
    );
    expect(answer()).toMatchObject({ registered: false, error: 'Error: inactive context' });

    // The control boot's case: the Host disposes the context while the probe is
    // still polling, so the file must exist and say "absent", never be missing.
    rmSync(out);
    const absent = context(() => undefined);
    probe.apply(absent.ctx, { toolName: TOOL_NAME, out });
    absent.dispose();
    expect(answer()).toMatchObject({ registered: false, disposed: true });
  });
});
