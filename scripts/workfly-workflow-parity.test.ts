import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectExplicitScriptPathRule } from './workflow-front-door-parity.js';

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
  test('the skill states the repair budget the script actually applies', () => {
    // The clamp's own behaviour — its bounds and its non-integer fallback — is already proven in
    // scripts/workflows-model-policy.test.ts. What nothing covered is the link from the script's
    // constants to the sentence this front door prints, and DEFAULT_MAX_REPAIRS by its name: the
    // model-policy test only ever sees that constant as an argument inside the clamp call.
    const constant = (name: string): number => {
      const match = new RegExp(`const ${name} = (\\d+)`).exec(JS);
      if (!match) throw new Error(`workfly.js: ${name} not found`);
      return Number(match[1]);
    };
    const floor = /clampInt\(input\.maxRepairs, (\d+), /.exec(JS);
    if (!floor) throw new Error('workfly.js: the maxRepairs clamp call was not found');
    expect(SKILL.replace(/\s+/g, ' ')).toContain(
      `${constant('DEFAULT_MAX_REPAIRS')} when unset or not an integer, otherwise clamped to ${floor[1]}-${constant('MAX_REPAIRS')}`,
    );
  });

  test('the skill states the explicit-script-path rule for both scopes', () => {
    expectExplicitScriptPathRule(SKILL, 'workfly');
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

  test('the shared refuter clause puts the three landing artifacts outside the script scope', () => {
    expect(JS).toContain(
      'the catalog README row, the fronting skill paragraph, and the parity test are landing artifacts the caller writes after this run',
    );
    expect(SKILL).toContain('always arrives as advisory');
  });
});
