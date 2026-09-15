import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Single-source guard: the council lens roster lives only in .claude/workflows/council.js.
// The council skill is a front door that runs that workflow and must not carry its own roster.

const ROOT = join(import.meta.dir, '..');
const CANONICAL_LENSES = ['architecture', 'delivery', 'product', 'security', 'dissent'];

function workflowLenses(): string[] {
  const js = readFileSync(join(ROOT, '.claude', 'workflows', 'council.js'), 'utf8');
  const block = /const LENSES = \[([\s\S]*?)\n\]/.exec(js);
  if (!block) throw new Error('council.js: LENSES block not found');
  return [...block[1].matchAll(/key: '([a-z]+)'/g)].map((m) => m[1]);
}

describe('council skill fronts the council workflow', () => {
  const skill = readFileSync(join(ROOT, 'skills', 'council', 'SKILL.md'), 'utf8');

  test('the workflow carries the five canonical lenses in order', () => {
    expect(workflowLenses()).toEqual(CANONICAL_LENSES);
  });

  test('the skill points at the workflow and carries no roster of its own', () => {
    expect(skill).toContain('.claude/workflows/council.js');
    expect(skill).toContain('saved name `council`');
    expect(/^\d+\. \*\*[A-Za-z]+\*\*/m.test(skill)).toBe(false);
  });
});
