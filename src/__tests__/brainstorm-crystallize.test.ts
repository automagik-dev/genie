import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, test } from 'bun:test';
import { brainstormCrystallizeCommand } from '../genie-commands/brainstorm/crystallize.js';

async function mkRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'genie-cli-crystallize-'));
  // minimal git config not required; getSourceRepo may read package.json or git.
  // Provide package.json to satisfy source_repo discovery in most cases.
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'tmp-repo' }, null, 2));
  return dir;
}

describe('genie brainstorm crystallize', () => {
  test('writes design.md and upserts beads issue with default depends_on', async () => {
    const repo = await mkRepo();
    const slug = 'my-idea';
    const draftPath = join(repo, '.genie', 'brainstorms', slug, 'draft.md');
    await mkdir(join(repo, '.genie', 'brainstorms', slug), { recursive: true });
    await writeFile(draftPath, '# Draft\n\nHello');

    // should not throw
    await brainstormCrystallizeCommand({ slug, repo });

    const designPath = join(repo, '.genie', 'brainstorms', slug, 'design.md');
    const design = await readFile(designPath, 'utf-8');
    expect(design).toContain('Hello');

    const issuesPath = join(repo, '.beads', 'issues.jsonl');
    const jsonl = await readFile(issuesPath, 'utf-8');
    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const rec = JSON.parse(lines[lines.length - 1]);
    expect(rec.id).toBe(slug);
    expect(rec.depends_on).toEqual(['hq-roadmap']);
  });
});
