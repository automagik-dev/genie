import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Single-source guard: the documentation-audit stage roster and surface roster live in
// .claude/workflows/docs-audit.js. The docs skill is that workflow's front door and must
// not drift from its stages, its surface keys, or the two halves it still owns.

const ROOT = join(import.meta.dir, '..');
const JS = readFileSync(join(ROOT, '.claude', 'workflows', 'docs-audit.js'), 'utf8');
const SKILL = readFileSync(join(ROOT, 'skills', 'docs', 'SKILL.md'), 'utf8');
const STAGES = ['Locate', 'Audit', 'Consolidate', 'Render'];
const SURFACES = ['readme', 'agent-instructions', 'docs-architecture', 'runtime-dx'];

function capture(block: RegExp, token: RegExp, what: string): string[] {
  const found = block.exec(JS);
  if (!found) throw new Error(`docs-audit.js: ${what} not found`);
  return [...(found[1] as string).matchAll(token)].map((m) => m[1] as string);
}

function byHandSection(): string {
  const section = /## Without a workflow surface\n([\s\S]*?)\n## /.exec(SKILL);
  if (!section) throw new Error('SKILL.md: the by-hand section is missing');
  return section[1] as string;
}

describe('docs skill fronts the docs-audit workflow', () => {
  test('the skill names the script path and the saved name', () => {
    expect(SKILL).toContain('.claude/workflows/docs-audit.js');
    expect(SKILL).toContain('saved name `docs-audit`');
  });

  test('meta.phases, the phase() calls and the by-hand stages are one roster', () => {
    expect(capture(/phases: \[([\s\S]*?)\n {2}\],/, /title: '([A-Za-z]+)'/g, 'meta.phases')).toEqual(STAGES);
    expect([...new Set([...JS.matchAll(/\bphase\('([A-Za-z]+)'\)/g)].map((m) => m[1] as string))]).toEqual(STAGES);
    const byHand = byHandSection();
    for (const stage of STAGES) expect(byHand).toContain(`**${stage}**`);
  });

  test('the surface roster is one closed set', () => {
    // The skill's Surfaces table carries the shard key in its own column; the script's
    // SURFACES rows are the roster the fan-out shards by.
    const fromSkill = [...SKILL.matchAll(/^\|[^|\n]+\| `([a-z-]+)` \|/gm)].map((m) => m[1] as string);
    expect(fromSkill).toEqual(SURFACES);
    expect(capture(/const SURFACES = \[([\s\S]*?)\n\]/, /^ {4}key: '([a-z-]+)',$/gm, 'SURFACES')).toEqual(SURFACES);
  });

  test('the skill keeps the contributor test and the write half the workflow never performs', () => {
    expect(SKILL).toContain('This stays here, with you, and never reaches the workflow.');
    expect(SKILL).toContain('Never document features that do not exist;');
  });
});
