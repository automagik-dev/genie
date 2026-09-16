import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Single-source guard: the skill-audit stage roster and verdict vocabulary live in
// .claude/workflows/skill-audit-sweep.js. The skill-audit skill is that workflow's front
// door and must not drift from its stages, its verdicts, or the two steps it still owns.

const ROOT = join(import.meta.dir, '..');
const JS = readFileSync(join(ROOT, '.claude', 'workflows', 'skill-audit-sweep.js'), 'utf8');
const SKILL = readFileSync(join(ROOT, 'skills', 'skill-audit', 'SKILL.md'), 'utf8');
const STAGES = ['Signals', 'Characterize', 'Verdicts', 'Render'];

function capture(source: string, block: RegExp, token: RegExp, what: string): string[] {
  const found = block.exec(source);
  if (!found) throw new Error(`skill-audit-sweep.js: ${what} not found`);
  return [...(found[1] as string).matchAll(token)].map((m) => m[1] as string);
}

function byHandSection(): string {
  const section = /## Without a workflow surface\n([\s\S]*?)\n## /.exec(SKILL);
  if (!section) throw new Error('SKILL.md: the by-hand section is missing');
  return section[1] as string;
}

describe('skill-audit skill fronts the skill-audit-sweep workflow', () => {
  test('the skill names the script path and the saved name', () => {
    expect(SKILL).toContain('.claude/workflows/skill-audit-sweep.js');
    expect(SKILL).toContain('saved name `skill-audit-sweep`');
  });

  test('meta.phases, the phase() calls and the by-hand stages are one roster', () => {
    expect(capture(JS, /phases: \[([\s\S]*?)\n {2}\],/, /title: '([A-Za-z]+)'/g, 'meta.phases')).toEqual(STAGES);
    expect([...new Set([...JS.matchAll(/\bphase\('([A-Za-z]+)'\)/g)].map((m) => m[1] as string))]).toEqual(STAGES);
    const byHand = byHandSection();
    for (const stage of STAGES) expect(byHand).toContain(`**${stage}**`);
  });

  test('the verdict vocabulary is one closed set', () => {
    // The skill spells the merge verdict in the catalogue's own words (`Merge into X`);
    // the script normalises that phrase back to the enum value before the enum test.
    const fromSkill = [...SKILL.matchAll(/^\| (Keep|Improve|Update|Merge into X|Retire) \|/gm)].map((m) =>
      (m[1] as string).replace(/^Merge into X$/, 'Merge'),
    );
    expect(fromSkill).toEqual(capture(JS, /const VERDICTS = \[([^\]]*)\]/, /'([A-Za-z]+)'/g, 'VERDICTS'));
  });

  test('the skill keeps the interview and the confirmation the workflow never performs', () => {
    expect(SKILL).toContain('A new skill is the last option, not the first.');
    expect(SKILL).toContain('Confirm every retirement and merge with the caller before any file moves.');
  });
});
