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
