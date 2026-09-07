import { expect, test } from 'bun:test';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

test('build regenerates Host bundle and lazy DSH browser factory', async () => {
  const root = import.meta.dir;
  const host = join(root, 'dist/index.js');
  const client = join(root, 'dist/client.js');
  await rm(host, { force: true });
  await rm(client, { force: true });
  const process = Bun.spawn(['bun', 'run', 'build'], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [code, error] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  expect(error).not.toContain('error:');
  expect(code).toBe(0);
  expect((await stat(host)).size).toBeGreaterThan(1000);
  let registration: { id: string; factory: (require: unknown) => { apply: unknown } } | undefined;
  runInNewContext(await readFile(client, 'utf8'), {
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
}, 20_000);

test('candidate build embeds override floor without changing source metadata', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
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
