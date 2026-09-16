import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService, parseMetaLiteral, readSkills, readWorkflows } from './catalog';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'genie-catalog-'));
  roots.push(root);
  await mkdir(join(root, 'skills', 'council', 'references'), { recursive: true });
  await writeFile(
    join(root, 'skills', 'council', 'SKILL.md'),
    '---\nname: council\ndescription: "Pressure-test a decision through five lenses."\n---\n# Council\n',
  );
  await mkdir(join(root, 'skills', 'verify'), { recursive: true });
  await writeFile(
    join(root, 'skills', 'verify', 'SKILL.md'),
    '---\nname: verify\ndescription: Check a claim\ncategory: verification\nmutates: none\n---\n',
  );
  await mkdir(join(root, 'skills', 'wish'), { recursive: true });
  await writeFile(
    join(root, 'skills', 'wish', 'SKILL.md'),
    '---\nname: wish\ndescription: Pour a wish\ncategory: nonsense\nmutates: sometimes\n---\n',
  );
  await mkdir(join(root, 'skills', 'mismatch'), { recursive: true });
  await writeFile(join(root, 'skills', 'mismatch', 'SKILL.md'), '---\nname: other\ndescription: x\n---\n');
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
  test('skills: frontmatter name must match the directory; resources listed', async () => {
    const skills = await readSkills(await repo());
    expect(skills.map((skill) => skill.name)).toEqual(['council', 'verify', 'wish']);
    expect(skills[0]?.description).toBe('Pressure-test a decision through five lenses.');
    expect(skills[0]?.resources).toEqual(['references']);
    expect(skills[0]?.path).toBe('skills/council/SKILL.md');
  });

  test('category and mutates are optional, closed, and dropped when they are not recognised', async () => {
    const skills = await readSkills(await repo());
    const by = (name: string) => skills.find((skill) => skill.name === name);
    // Absent is legal and common.
    expect(by('council')?.category).toBeUndefined();
    expect(by('council')?.mutates).toBeUndefined();
    expect(by('verify')).toMatchObject({ category: 'verification', mutates: 'none' });
    // A typo must never invent a category header or a mutation claim.
    expect(by('wish')?.category).toBeUndefined();
    expect(by('wish')?.mutates).toBeUndefined();
  });

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
    expect((await service.skills('w1')).length).toBe(3);
    expect((await service.workflows('w1')).length).toBe(1);
    expect((await service.document('w1', 'skill', 'council')).startsWith('---')).toBe(true);
    await expect(service.document('w1', 'workflow', '../etc/passwd')).rejects.toThrow('Invalid name');
    await expect(service.document('w1', 'workflow', 'missing')).rejects.toThrow('Document not found');
    await expect(service.skills('nope')).rejects.toThrow('Unknown workspace');
  });
});
