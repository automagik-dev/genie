import { expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * A control character written literally into source makes git classify the file
 * as binary: `git diff` stops producing line diffs and review tooling shows
 * "Binary files differ" (m12). Control characters belong in source as escapes.
 */
const sources = resolve(import.meta.dir);
const repository = resolve(import.meta.dir, '../../..');

test('no plugin source carries a literal NUL, so git keeps diffing it as text', async () => {
  const files = (await readdir(sources)).filter((name) => name.endsWith('.ts'));
  expect(files).toContain('service.ts');
  for (const name of files) {
    const bytes = await readFile(join(sources, name));
    expect({ name, nul: bytes.includes(0) }).toEqual({ name, nul: false });
  }
  // The claim-map separator is still a NUL at runtime — written as an escape.
  const service = await readFile(join(sources, 'service.ts'), 'utf8');
  expect(service).toContain('${workspaceId}\\u0000${card.id}');
});

test('git classifies every plugin source as text', async () => {
  const child = Bun.spawn(['git', 'ls-files', '--eol', '--', 'plugins/dsh-genie-board/src'], {
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  const binary = stdout
    .split('\n')
    .filter((line) => line.includes('-text'))
    .map((line) => line.trim());
  expect(binary).toEqual([]);
});
