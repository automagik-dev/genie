import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Drift guard: the lens roster inlined in .claude/workflows/council.js must match the
// numbered lens list in skills/council/SKILL.md, so the two rosters cannot diverge.

const ROOT = join(import.meta.dir, '..');

function skillLenses(): string[] {
  const md = readFileSync(join(ROOT, 'skills', 'council', 'SKILL.md'), 'utf8');
  return [...md.matchAll(/^\d+\. \*\*([A-Za-z]+)\*\*/gm)].map((m) => m[1].toLowerCase());
}

function workflowLenses(): string[] {
  const js = readFileSync(join(ROOT, '.claude', 'workflows', 'council.js'), 'utf8');
  const block = /const LENSES = \[([\s\S]*?)\n\]/.exec(js);
  if (!block) throw new Error('council.js: LENSES block not found');
  return [...block[1].matchAll(/key: '([a-z]+)'/g)].map((m) => m[1]);
}

describe('council workflow mirrors the council skill', () => {
  test('lens rosters are identical and ordered the same', () => {
    expect(workflowLenses()).toEqual(skillLenses());
  });
});
