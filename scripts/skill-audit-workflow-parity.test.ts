import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectExplicitScriptPathRule } from './workflow-front-door-parity.js';

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
  test('the skill states the explicit-script-path rule for both scopes', () => {
    expectExplicitScriptPathRule(SKILL, 'skill-audit-sweep');
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

// Issue #2919. The script exports only `meta`, so the roster logic cannot be imported
// and called; these are assertions over its source text, and each one fails against the
// pre-fix source.
describe('skill-audit-sweep never widens a supplied roster into a full sweep', () => {
  test('supplied-ness is carried out of the intake, not read off the kept-name count', () => {
    expect(JS).toContain('rosterSupplied: Array.isArray(input.skills) && input.skills.length > 0');
    expect(JS).toContain("const rosterSource = rosterSupplied ? 'args' : 'inventory'");
    expect(JS).toContain('const roster = [...new Set(rosterSupplied ? requestedNames : inventoryNames)].sort()');
    // The pre-fix predicates keyed on the kept-name count alone; none may survive.
    expect(JS).not.toMatch(/rosterSource = requestedNames\.length/);
    expect(JS).not.toMatch(/new Set\(requestedNames\.length \?/);
    expect(JS).not.toMatch(/if \(!requestedNames\.length && signals\)/);
  });

  test('a supplied list with no valid entry fails the run before any inventory roster', () => {
    const guard = JS.indexOf('if (rosterSupplied && !requestedNames.length) {');
    expect(guard).toBeGreaterThan(-1);
    const failure = /if \(rosterSupplied && !requestedNames\.length\) \{([\s\S]*?)\n\}/.exec(JS);
    if (!failure) throw new Error('skill-audit-sweep.js: the all-invalid roster guard has no body');
    // The same {ok: false, error} shape the rest of the file returns, naming the condition.
    expect(failure[1]).toContain('ok: false');
    expect(failure[1]).toContain('A skills list was supplied but no entry reduced to a skill directory name');
    expect(failure[1]).toContain("rosterSource: 'args'");
    // It returns before the inventory reading is ever collected or shared.
    expect(guard).toBeLessThan(JS.indexOf('const inventoryNames ='));
    expect(guard).toBeLessThan(JS.indexOf('const rosterSource ='));
  });

  test('the signals prompt runs the parity check read-only and never with --write', () => {
    expect(JS).toContain("const PARITY_CHECK = 'bun scripts/skills-inventory-parity.ts'");
    const bullet = /`Run: \$\{PARITY_CHECK\}([^`]*)`/.exec(JS);
    if (!bullet) throw new Error('skill-audit-sweep.js: the signals parity bullet is missing');
    expect(bullet[1]).toContain('--write');
    expect(bullet[1]).toContain('read-only');
    // The bare command stays: the CI --list-file form is not what the sweep runs.
    expect(JS).not.toContain('--list-file');
    expect(JS).not.toContain('npx');
  });
});
