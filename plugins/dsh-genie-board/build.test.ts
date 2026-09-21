import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

/** The three host row bundles plus the one client bundle. */
const HOST_BUNDLES = ['index.js', 'board.js', 'workflows.js'] as const;

test('valid repeated builds regenerate identical Host and lazy browser bundles', async () => {
  const root = import.meta.dir;
  const output = await mkdtemp(join(tmpdir(), 'genie-repeat-host-'));
  const version = JSON.parse(await readFile(join(root, '../../package.json'), 'utf8')).version;
  let previous: string[] | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const proc = Bun.spawn(['bun', 'run', 'build', version, output], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).toBe(0);
      expect(stderr).not.toContain('error:');
      const client = join(output, 'client.js');
      const bytes: string[] = [];
      for (const bundle of HOST_BUNDLES) {
        const host = join(output, bundle);
        expect((await stat(host)).size).toBeGreaterThan(1000);
        const module = (await import(`${host}?attempt=${attempt}`)) as {
          apply: unknown;
          inject: string[] | undefined;
          Config: unknown;
        };
        expect(typeof module.apply).toBe('function');
        // Only the manager declares an `inject`, of raw host services DSH always
        // provides. A sub-row must NOT: a row-level inject on the manager's own
        // service is a hard dependency, and DSH fails the whole boot on any
        // enabled loader entry still pending once the tree settles — so
        // disabling the manager row by id would take the Host down with it. The
        // sub-rows wait through deferred `ctx.inject` inside `apply` instead.
        expect(module.inject).toEqual(
          bundle === 'index.js' ? ['workspaceRegistry', 'webServer', 'connection'] : undefined,
        );
        expect(module.Config).toBeDefined();
        bytes.push(await readFile(host, 'utf8'));
      }
      expect((await import(`${join(output, 'index.js')}?attempt=${attempt}`)).minimumGenieVersion).toBe(version);
      bytes.push(await readFile(client, 'utf8'));
      if (previous) expect(bytes).toEqual(previous);
      previous = bytes;
      let registration: { id: string; factory: (require: unknown) => { apply: unknown } } | undefined;
      runInNewContext(bytes[bytes.length - 1], {
        window: {
          __ModuleLoader__: {
            load(value: typeof registration) {
              registration = value;
            },
          },
        },
      });
      expect(registration?.id).toBe('@automagik/genie-dsh-board');
      // The browser bundle resolves only DSH's frozen platform module table
      // (React and the UI primitives); anything else is a packaging error.
      const platform = new Set([
        'react',
        'react/jsx-runtime',
        'react-dom',
        'react-dom/client',
        '@deepseek-ai/dsh-client-ui-primitives',
      ]);
      const requested = new Set<string>();
      const stub = new Proxy({}, { get: () => stub });
      const exportsOf = registration?.factory((id: string) => {
        if (!platform.has(id)) throw new Error(`Unexpected browser dependency: ${id}`);
        requested.add(id);
        return stub;
      });
      expect(typeof exportsOf?.apply).toBe('function');
      expect([...requested].sort()).toEqual(['@deepseek-ai/dsh-client-ui-primitives', 'react', 'react/jsx-runtime']);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 20_000);

test('invalid build version exits with an error and writes no bundle', async () => {
  const output = await mkdtemp(join(tmpdir(), 'genie-invalid-host-'));
  try {
    const proc = Bun.spawn(['bun', 'run', 'build', 'invalid version', output], {
      cwd: import.meta.dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('invalid build version');
    expect(await readdir(output)).toEqual([]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 20_000);

test('candidate build embeds override floor without changing source metadata', async () => {
  const root = import.meta.dir;
  const output = await mkdtemp(join(tmpdir(), 'genie-candidate-host-'));
  const before = await readFile(join(root, 'package.json'), 'utf8');
  const sourceVersion = JSON.parse(await readFile(join(root, '../../package.json'), 'utf8')).version;
  const candidate = `${sourceVersion}-candidate-proof`;
  try {
    const process = Bun.spawn(['bun', 'run', 'build', candidate, output], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    expect(code).toBe(0);
    expect(stderr).not.toContain('error:');
    const host = await import(join(output, 'index.js'));
    expect(host.minimumGenieVersion).toBe(candidate);
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(before);
    const source = await import('./src/index');
    expect(source.minimumGenieVersion).toBe(sourceVersion);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 20_000);
