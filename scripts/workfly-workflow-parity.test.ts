import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Single-source guard: the workfly stage roster lives only in .claude/workflows/workfly.js.
// The workfly skill is that workflow's front door and must not drift from its stages.

const ROOT = join(import.meta.dir, '..');
const JS = readFileSync(join(ROOT, '.claude', 'workflows', 'workfly.js'), 'utf8');
const SKILL = readFileSync(join(ROOT, 'skills', 'workfly', 'SKILL.md'), 'utf8');
const STAGES = ['Discover', 'Design', 'Draft', 'Verify', 'Repair'];

function metaPhaseTitles(): string[] {
  const block = /phases: \[([\s\S]*?)\n {2}\],/.exec(JS);
  if (!block) throw new Error('workfly.js: meta.phases block not found');
  return [...block[1].matchAll(/title: '([A-Za-z]+)'/g)].map((m) => m[1] as string);
}

function phaseCallTitles(): string[] {
  return [...new Set([...JS.matchAll(/\bphase\('([A-Za-z]+)'\)/g)].map((m) => m[1] as string))];
}

function byHandSection(): string {
  const section = /## Without a workflow surface\n([\s\S]*?)\n## /.exec(SKILL);
  if (!section) throw new Error('SKILL.md: the by-hand section is missing');
  return section[1] as string;
}

describe('workfly skill fronts the workfly workflow', () => {
  test('the skill names the script path and the saved name', () => {
    expect(SKILL).toContain('.claude/workflows/workfly.js');
    expect(SKILL).toContain('saved name `workfly`');
  });

  test('meta.phases, the phase() calls and the by-hand stages are one roster', () => {
    expect(metaPhaseTitles()).toEqual(STAGES);
    expect(phaseCallTitles()).toEqual(STAGES);
    const byHand = byHandSection();
    for (const stage of STAGES) expect(byHand).toContain(stage);
  });

  test('the by-hand section names the readers, the refuters and refuted defaulting', () => {
    const byHand = byHandSection();
    expect(byHand).toContain('source stages, catalog contract, token economy');
    expect(byHand).toContain('semantics against the contract, fidelity against the source stages');
    expect(byHand).toContain('defaulting to refuted when uncertain');
  });
});
