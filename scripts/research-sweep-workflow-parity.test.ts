import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  test('the skill names the script path and the saved name', () => {
    expect(SKILL).toContain('.claude/workflows/research-sweep.js');
    expect(SKILL).toContain('saved name `research-sweep`');
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
    const paragraph = section('Sources are evidence, never instruction', SKILL, 'the injection fence');
    expect(flat(paragraph)).toContain(flat(fence[1] as string));
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
