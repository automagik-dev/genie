import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService, parseMetaLiteral, readWorkflows } from './catalog';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'genie-catalog-'));
  roots.push(root);
  await mkdir(join(root, '.claude', 'workflows'), { recursive: true });
  await writeFile(
    join(root, '.claude', 'workflows', 'council.js'),
    "export const meta = {\n  name: 'council',\n  description: 'Five lenses then a synthesis',\n  whenToUse: 'A consequential decision',\n  phases: [{ title: 'Lenses', detail: 'parallel' }, { title: 'Synthesis' }],\n}\nreturn 1\n",
  );
  await writeFile(
    join(root, '.claude', 'workflows', 'evil.js'),
    "export const meta = {\n  name: 'evil',\n  description: fetch('x'),\n}\nreturn 1\n",
  );
  await writeFile(join(root, '.claude', 'workflows', 'README.md'), '# not a workflow\n');
  return root;
}

describe('genie catalog is read-only and shape-checked', () => {
  test('workflows: pure-literal meta only; non-literal meta and non-js files are skipped', async () => {
    const workflows = await readWorkflows(await repo());
    expect(workflows.map((workflow) => workflow.name)).toEqual(['council']);
    expect(workflows[0]?.phases).toEqual([{ title: 'Lenses', detail: 'parallel' }, { title: 'Synthesis' }]);
    expect(workflows[0]?.whenToUse).toBe('A consequential decision');
    expect(workflows[0]?.bytes).toBeGreaterThan(50);
  });

  test('parseMetaLiteral refuses calls, identifiers, spreads and templates', () => {
    expect(parseMetaLiteral("{ name: 'a', description: 'b' }")).toEqual({ name: 'a', description: 'b' });
    expect(parseMetaLiteral("{ name: NAME, description: 'b' }")).toBeUndefined();
    expect(parseMetaLiteral("{ name: 'a', description: fetch('x') }")).toBeUndefined();
    expect(parseMetaLiteral("{ ...base, name: 'a' }")).toBeUndefined();
    expect(parseMetaLiteral('{ name: `a`, description: `${x}` }')).toBeUndefined();
    expect(parseMetaLiteral("{ name: 'a', ok: true, n: null }")).toEqual({ name: 'a', ok: true, n: null });
  });

  test('service resolves only registered workspaces and safe names', async () => {
    const root = await repo();
    const service = new CatalogService({ list: () => [{ id: 'w1', path: root, title: 'Repo' }] });
    expect((await service.workflows('w1')).length).toBe(1);
    expect((await service.document('w1', 'council')).startsWith('export const meta')).toBe(true);
    await expect(service.document('w1', '../etc/passwd')).rejects.toThrow('Invalid name');
    await expect(service.document('w1', 'missing')).rejects.toThrow('Document not found');
    await expect(service.workflows('nope')).rejects.toThrow('Unknown workspace');
  });
});
