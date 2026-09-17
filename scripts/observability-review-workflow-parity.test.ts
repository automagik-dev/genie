import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANNOTATION_NAMES, ANNOTATOR_ID } from './observability/annotate.js';

// Single-source guard: the annotation roster and identifier live in scripts/observability/annotate.ts,
// and .claude/workflows/observability-review.js reads exactly those annotations back from the cc-*
// projects scripts/observability/backfill.ts writes. The workflow is proposal-only and takes its
// endpoint, rules path and project prefix from args.

const ROOT = join(import.meta.dir, '..');
const JS = readFileSync(join(ROOT, '.claude', 'workflows', 'observability-review.js'), 'utf8');
const README = readFileSync(join(ROOT, '.claude', 'workflows', 'README.md'), 'utf8');
const STAGES = ['Measure', 'Diagnose', 'Propose'];

function capture(block: RegExp, token: RegExp, what: string): string[] {
  const found = block.exec(JS);
  if (!found) throw new Error(`observability-review.js: ${what} not found`);
  return [...(found[1] as string).matchAll(token)].map((m) => m[1] as string);
}

describe('observability-review workflow', () => {
  test('meta.phases and the phase() calls are one roster', () => {
    expect(capture(/phases: \[([\s\S]*?)\n {2}\],/, /title: '([A-Za-z]+)'/g, 'meta.phases')).toEqual(STAGES);
    expect([...new Set([...JS.matchAll(/\bphase\('([A-Za-z]+)'\)/g)].map((m) => m[1] as string))]).toEqual(STAGES);
  });

  test('the annotation roster and identifier are annotate.ts', () => {
    expect(capture(/const ANNOTATIONS = \[([\s\S]*?)\]/, /'([a-z_]+)'/g, 'ANNOTATIONS')).toEqual([...ANNOTATION_NAMES]);
    expect(JS).toContain(`const ANNOTATOR = '${ANNOTATOR_ID}'`);
  });

  test('queries cc-* projects only, never the backfill-* selector', () => {
    expect(JS).toContain("const PROJECT_PREFIX = 'cc-'");
    expect(JS).not.toContain('backfill-');
    expect(JS).toMatch(/projectPrefix\.indexOf\(PROJECT_PREFIX\) !== 0/);
  });

  test('endpoint, rules path and project prefix arrive through args', () => {
    expect(JS).toContain('text(job.phoenix)');
    expect(JS).toContain('text(job.rulesPath)');
    expect(JS).toContain('text(job.projectPrefix)');
    expect(JS).not.toMatch(/https?:\/\/(?:127\.0\.0\.1|localhost)/);
  });

  test('stamps no home-relative or absolute path and pins no model', () => {
    expect(JS).not.toContain('~/');
    expect(JS).not.toMatch(/\$\{?HOME\b/);
    expect(JS).not.toMatch(/\/(?:Users|home|opt|var|tmp)\//);
    expect(JS).not.toContain('DEFAULT_MODEL');
    expect(JS).not.toMatch(/\bmodel\s*:/);
  });

  test('every agent prompt is proposal-only and demands evidence ids', () => {
    expect(JS).toContain('Proposal only. You never edit, create, move or delete any file');
    expect(JS).toContain('Every claim cites evidence ids');
    const prompts = [...JS.matchAll(/await agent\(\n\s*`([\s\S]*?)`,\n/g)].map((m) => m[1] as string);
    expect(prompts.length).toBe(STAGES.length);
    for (const prompt of prompts) expect(prompt.startsWith('${PROPOSAL_ONLY}')).toBe(true);
    expect(JS).toContain('you never edit files');
    expect(JS).not.toMatch(/\b(?:writeFile|appendFile|Write|Edit)\s*\(/);
  });

  test('the catalog README carries the entry and its args', () => {
    const row = README.split('\n').find((line) => line.startsWith('| `observability-review` |'));
    expect(row).toBeDefined();
    expect(row).toContain('`{phoenix, rulesPath, projectPrefix?, since?, timestamp?}`');
    expect(row).toContain('cc-*');
  });
});
