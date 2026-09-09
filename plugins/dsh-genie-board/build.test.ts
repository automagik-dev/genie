import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

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
      const host = join(output, 'index.js');
      const client = join(output, 'client.js');
      expect((await stat(host)).size).toBeGreaterThan(1000);
      expect((await import(`${host}?attempt=${attempt}`)).minimumGenieVersion).toBe(version);
      const bytes = [await readFile(host, 'utf8'), await readFile(client, 'utf8')];
      if (previous) expect(bytes).toEqual(previous);
      previous = bytes;
      let registration: { id: string; factory: (require: unknown) => { apply: unknown } } | undefined;
      runInNewContext(bytes[1], {
        window: {
          __ModuleLoader__: {
            load(value: typeof registration) {
              registration = value;
            },
          },
        },
      });
      expect(registration?.id).toBe('@automagik/genie-dsh-board');
      // No DOM is needed until Cordis activates the factory's apply method.
      expect(
        typeof registration?.factory(() => {
          throw new Error('Unexpected browser dependency');
        }).apply,
      ).toBe('function');
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
