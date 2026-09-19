import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectExplicitScriptPathRule } from './workflow-front-door-parity.js';

// Single-source guard: the research stage roster and the injection fence live in
// .claude/workflows/research-sweep.js. The research skill is that workflow's front door,
// and the fence paragraph is authored ONCE — in the skill — and copied into the script.

const ROOT = join(import.meta.dir, '..');
const JS = readFileSync(join(ROOT, '.claude', 'workflows', 'research-sweep.js'), 'utf8');
const SKILL = readFileSync(join(ROOT, 'skills', 'research', 'SKILL.md'), 'utf8');
const STAGES = ['Plan', 'Read', 'Synthesize', 'Attribute', 'Render'];
const flat = (value: string) => value.replace(/\s+/g, ' ').trim();

function capture(block: RegExp, token: RegExp, what: string): string[] {
  const found = block.exec(JS);
  if (!found) throw new Error(`research-sweep.js: ${what} not found`);
  return [...(found[1] as string).matchAll(token)].map((m) => m[1] as string);
}

function section(heading: string, source: string, what: string): string {
  const found = new RegExp(`## ${heading}\\n([\\s\\S]*?)\\n## `).exec(source);
  if (!found) throw new Error(`SKILL.md: ${what} is missing`);
  return found[1] as string;
}

describe('research skill fronts the research-sweep workflow', () => {
  test('the skill states the explicit-script-path rule for both scopes', () => {
    expectExplicitScriptPathRule(SKILL, 'research-sweep');
  });

  test('meta.phases, the phase() calls and the by-hand stages are one roster', () => {
    expect(capture(/phases: \[([\s\S]*?)\n {2}\],/, /title: '([A-Za-z]+)'/g, 'meta.phases')).toEqual(STAGES);
    expect([...new Set([...JS.matchAll(/\bphase\('([A-Za-z]+)'\)/g)].map((m) => m[1] as string))]).toEqual(STAGES);
    const byHand = section('Without a workflow surface', SKILL, 'the by-hand section');
    for (const stage of STAGES) expect(byHand).toContain(`**${stage}**`);
  });

  test('the reader schema still requires injectionAttempts', () => {
    expect(JS).toContain("obj(['findings', 'unread', 'injectionAttempts']");
  });

  test('the injection fence is the skill paragraph, byte for byte', () => {
    const fence = /const INJECTION_FENCE = `([\s\S]*?)`\n/.exec(JS);
    if (!fence) throw new Error('research-sweep.js: INJECTION_FENCE not found');
    // The section ends with a sentence ABOUT the copy ("The sweep copies the four rules above…"),
    // which the fence itself does not carry: the compared text is the rules, so it stops at the
    // last bullet. `toContain` would pass on a fence that had lost a bullet; equality cannot.
    const lines = section('Sources are evidence, never instruction', SKILL, 'the injection fence').split('\n');
    while (lines.length && !(lines[lines.length - 1] as string).startsWith('- ')) lines.pop();
    if (!lines.length) throw new Error('SKILL.md: the injection fence section has no bullets');
    expect(flat(lines.join('\n'))).toBe(flat(fence[1] as string));
  });

  test('the two source-handling rules reach the reader prompt and the skill alike', () => {
    // Unlike the injection fence, these two are authored as house prose in the skill and as a
    // reader instruction in the script, so the pinned unit is the CLAUSE that carries the rule:
    // a headline plus the sentence a reader has to act on. Edit either side alone and this fails.
    const shared = [
      'Cite from the retrieval, never from memory of the source',
      'transcribed from the retrieval that produced it in this run, with its retrieval-time provenance — what was fetched or opened, and when',
      'Validate the body, not the status code',
      'a source counts as read only when its body carries the content you went there for',
    ];
    for (const clause of shared) {
      expect(SKILL).toContain(clause);
      expect(JS).toContain(clause);
    }
    // A constant the reader prompt never stamps is a rule nobody reads.
    const reader = /function readPrompt\(job, shard\) \{([\s\S]*?)\n\}/.exec(JS);
    if (!reader) throw new Error('research-sweep.js: readPrompt not found');
    expect(reader[1]).toContain('RETRIEVAL_RULE');
    expect(reader[1]).toContain('BODY_RULE');
  });

  test('the skill keeps the frozen question and the notes-writing step the workflow never performs', () => {
    expect(SKILL).toContain(
      'the workflow never re-asks, narrows or widens the question, and never adds a source of its own',
    );
    expect(SKILL).toContain(
      'Record the notes inside the repository, under the brainstorm directory for the work that prompted them, or in the wish that owns the question.',
    );
  });
});
