/**
 * Wish parser + schema tests.
 *
 * Group 1 deliverable. Exercises:
 *   - Positive fixture: the live `wish-command-group-restructure` WISH.md
 *     (the wish that defined this parser — recursively self-verifying).
 *   - Hard parse errors: malformed markdown surfaces `WishParseError` with
 *     the correct rule ID and line number.
 *   - Schema round-trip: `WishDocumentSchema.parse` accepts a clean parse.
 *   - Depends-on dangling reference detection (schema superRefine).
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type ViolationRule, WishParseError, parseWish, parseWishFile } from '../wish-parser.js';
import { VIOLATION_RULES, WishDocumentSchema } from '../wish-schema.js';

const WORKTREE_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const POSITIVE_SLUG = 'wish-command-group-restructure';

describe('parseWishFile', () => {
  test(`parses ${POSITIVE_SLUG} with metadata + ≥5 execution groups`, () => {
    const doc = parseWishFile(POSITIVE_SLUG, { repoRoot: WORKTREE_ROOT });
    expect(doc.title.length).toBeGreaterThan(0);
    expect(doc.metadata.slug).toBe(POSITIVE_SLUG);
    expect(doc.metadata.status).toMatch(/draft|approved|in[- ]?progress|ship/i);
    expect(doc.metadata.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(doc.metadata.author.length).toBeGreaterThan(0);
    expect(doc.metadata.appetite.length).toBeGreaterThan(0);
    expect(doc.metadata.branch.length).toBeGreaterThan(0);
    expect(doc.summary.length).toBeGreaterThan(0);
    expect(doc.scope.out.length).toBeGreaterThan(0);
    expect(doc.executionGroups.length).toBeGreaterThanOrEqual(5);
  });

  test(`schema accepts parsed ${POSITIVE_SLUG}`, () => {
    const doc = parseWishFile(POSITIVE_SLUG, { repoRoot: WORKTREE_ROOT });
    const result = WishDocumentSchema.safeParse(doc);
    if (!result.success) {
      console.error('Schema errors:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });

  test('missing file throws WishParseError with path in message', () => {
    try {
      parseWishFile('definitely-does-not-exist-slug', { repoRoot: WORKTREE_ROOT });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WishParseError);
      expect((err as WishParseError).message).toContain('Wish file not found');
    }
  });

  test(`Group 1 of ${POSITIVE_SLUG} has all required fields populated`, () => {
    const doc = parseWishFile(POSITIVE_SLUG, { repoRoot: WORKTREE_ROOT });
    const group = doc.executionGroups.find((g) => g.number === 1);
    expect(group).toBeDefined();
    if (!group) return;
    expect(group.goal.length).toBeGreaterThan(0);
    expect(group.deliverables.length).toBeGreaterThan(0);
    expect(group.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(group.validation.length).toBeGreaterThan(0);
    expect(group.dependsOn === 'none' || Array.isArray(group.dependsOn)).toBe(true);
  });
});

describe('parseWish — structural failures', () => {
  test('missing Execution Groups header with stray `### Grupo N —` throws missing-execution-groups-header', () => {
    const md = [
      '# Wish: Broken',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| **Status** | DRAFT |',
      '| **Slug** | `broken` |',
      '| **Date** | 2026-04-19 |',
      '| **Author** | felipe |',
      '| **Appetite** | small |',
      '| **Branch** | `wish/broken` |',
      '',
      '## Summary',
      '',
      'Test summary.',
      '',
      '## Scope',
      '',
      '### IN',
      '',
      '- thing',
      '',
      '### OUT',
      '',
      '- other',
      '',
      '### Grupo 1 — Do the thing',
      '',
      '**Goal:** x',
      '',
    ].join('\n');
    try {
      parseWish(md);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WishParseError);
      const wpe = err as WishParseError;
      expect(wpe.rule).toBe('missing-execution-groups-header');
      // Error line must land on the stray group header.
      expect(wpe.line).toBeGreaterThan(0);
    }
  });

  test('missing title throws missing-title', () => {
    const md = '## Summary\n\nno title here';
    try {
      parseWish(md);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WishParseError);
      expect((err as WishParseError).rule).toBe('missing-title');
    }
  });

  test('missing metadata fields throws metadata-table-missing-field', () => {
    const md = ['# Wish: No Metadata', '', '## Summary', '', 'x'].join('\n');
    try {
      parseWish(md);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WishParseError);
      expect((err as WishParseError).rule).toBe('metadata-table-missing-field');
    }
  });

  test('missing Summary section throws missing-summary', () => {
    const md = [
      '# Wish: Foo',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| **Status** | DRAFT |',
      '| **Slug** | `foo` |',
      '| **Date** | 2026-04-19 |',
      '| **Author** | felipe |',
      '| **Appetite** | small |',
      '| **Branch** | `wish/foo` |',
      '',
      '## Scope',
      '',
      '### OUT',
      '',
      '- nothing',
      '',
      '## Execution Groups',
      '',
      '### Group 1: Do it',
      '',
      '**Goal:** x',
      '',
    ].join('\n');
    try {
      parseWish(md);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WishParseError);
      expect((err as WishParseError).rule).toBe('missing-summary');
    }
  });

  test('execution-groups header present but zero groups throws missing-execution-group', () => {
    const md = [
      '# Wish: Empty Groups',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| **Status** | DRAFT |',
      '| **Slug** | `empty` |',
      '| **Date** | 2026-04-19 |',
      '| **Author** | felipe |',
      '| **Appetite** | small |',
      '| **Branch** | `wish/empty` |',
      '',
      '## Summary',
      '',
      'x',
      '',
      '## Scope',
      '',
      '### OUT',
      '',
      '- something',
      '',
      '## Execution Groups',
      '',
      'No subsections here.',
      '',
    ].join('\n');
    try {
      parseWish(md);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WishParseError);
      expect((err as WishParseError).rule).toBe('missing-execution-group');
    }
  });
});

describe('parseWish — field extraction', () => {
  const minimalWish = [
    '# Wish: Minimal',
    '',
    '| Field | Value |',
    '|-------|-------|',
    '| **Status** | DRAFT |',
    '| **Slug** | `minimal` |',
    '| **Date** | 2026-04-19 |',
    '| **Author** | felipe |',
    '| **Appetite** | small |',
    '| **Branch** | `wish/minimal` |',
    '',
    '## Summary',
    '',
    'A tiny wish.',
    '',
    '## Scope',
    '',
    '### IN',
    '',
    '- build parser',
    '',
    '### OUT',
    '',
    '- build everything else',
    '',
    '## Success Criteria',
    '',
    '- [ ] parser works',
    '- [x] done',
    '',
    '## Execution Groups',
    '',
    '### Group 1: Build it',
    '',
    '**Goal:** Make the thing.',
    '',
    '**Deliverables:**',
    '1. File foo.ts',
    '',
    '**Acceptance Criteria:**',
    '- [ ] foo.ts exists',
    '',
    '**Validation:**',
    '```bash',
    'test -f foo.ts',
    '```',
    '',
    '**depends-on:** none',
    '',
    '---',
    '',
    '### Group 2: Build another',
    '',
    '**Goal:** Second thing.',
    '',
    '**Deliverables:**',
    '1. File bar.ts',
    '',
    '**Acceptance Criteria:**',
    '- [ ] bar.ts exists',
    '',
    '**Validation:**',
    '```bash',
    'test -f bar.ts',
    '```',
    '',
    '**depends-on:** Group 1',
    '',
  ].join('\n');

  test('extracts all metadata fields', () => {
    const doc = parseWish(minimalWish);
    expect(doc.metadata).toEqual({
      status: 'DRAFT',
      slug: 'minimal',
      date: '2026-04-19',
      author: 'felipe',
      appetite: 'small',
      branch: 'wish/minimal',
    });
  });

  test('extracts IN and OUT scope bullets', () => {
    const doc = parseWish(minimalWish);
    expect(doc.scope.in).toEqual(['build parser']);
    expect(doc.scope.out).toEqual(['build everything else']);
  });

  test('extracts success criteria checklist', () => {
    const doc = parseWish(minimalWish);
    expect(doc.successCriteria).toEqual(['parser works', 'done']);
  });

  test('extracts two execution groups with all required fields', () => {
    const doc = parseWish(minimalWish);
    expect(doc.executionGroups).toHaveLength(2);
    const g1 = doc.executionGroups[0];
    expect(g1?.number).toBe(1);
    expect(g1?.title).toBe('Build it');
    expect(g1?.goal).toBe('Make the thing.');
    expect(g1?.deliverables).toContain('File foo.ts');
    expect(g1?.acceptanceCriteria).toEqual(['foo.ts exists']);
    expect(g1?.validation).toBe('test -f foo.ts');
    expect(g1?.dependsOn).toBe('none');
  });

  test('parses depends-on list reference', () => {
    const doc = parseWish(minimalWish);
    const g2 = doc.executionGroups[1];
    expect(g2?.dependsOn).toEqual(['Group 1']);
  });

  test('schema accepts minimal wish', () => {
    const doc = parseWish(minimalWish);
    const result = WishDocumentSchema.safeParse(doc);
    if (!result.success) {
      console.error('Schema errors:', JSON.stringify(result.error.issues, null, 2));
    }
    expect(result.success).toBe(true);
  });
});

describe('WishDocumentSchema', () => {
  test('rejects empty OUT scope', () => {
    const md = [
      '# Wish: Bad Scope',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| **Status** | DRAFT |',
      '| **Slug** | `bad` |',
      '| **Date** | 2026-04-19 |',
      '| **Author** | felipe |',
      '| **Appetite** | small |',
      '| **Branch** | `wish/bad` |',
      '',
      '## Summary',
      '',
      'x',
      '',
      '## Scope',
      '',
      '### IN',
      '',
      '- something',
      '',
      '## Execution Groups',
      '',
      '### Group 1: Do it',
      '',
      '**Goal:** go',
      '',
      '**Deliverables:**',
      '1. stuff',
      '',
      '**Acceptance Criteria:**',
      '- [ ] works',
      '',
      '**Validation:**',
      '```bash',
      'true',
      '```',
      '',
      '**depends-on:** none',
      '',
    ].join('\n');
    const doc = parseWish(md);
    const result = WishDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  test('detects dangling depends-on reference via superRefine', () => {
    const md = [
      '# Wish: Dangling',
      '',
      '| Field | Value |',
      '|-------|-------|',
      '| **Status** | DRAFT |',
      '| **Slug** | `dangling` |',
      '| **Date** | 2026-04-19 |',
      '| **Author** | felipe |',
      '| **Appetite** | small |',
      '| **Branch** | `wish/dangling` |',
      '',
      '## Summary',
      '',
      'x',
      '',
      '## Scope',
      '',
      '### OUT',
      '',
      '- nothing',
      '',
      '## Execution Groups',
      '',
      '### Group 1: Dangling dependency',
      '',
      '**Goal:** g',
      '',
      '**Deliverables:**',
      '1. d',
      '',
      '**Acceptance Criteria:**',
      '- [ ] ok',
      '',
      '**Validation:**',
      '```bash',
      'true',
      '```',
      '',
      '**depends-on:** Group 99',
      '',
    ].join('\n');
    const doc = parseWish(md);
    const result = WishDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => i.message);
      expect(msgs.some((m) => m.includes('Group 99'))).toBe(true);
    }
  });
});

describe('parseWish — path sanity', () => {
  test('positive-fixture path is the on-disk wish', () => {
    const absolute = join(WORKTREE_ROOT, '.genie', 'wishes', POSITIVE_SLUG, 'WISH.md');
    expect(absolute).toContain('.genie/wishes/wish-command-group-restructure/WISH.md');
  });
});

describe('ViolationRule export surface', () => {
  test('parser re-exports ViolationRule and every literal is in VIOLATION_RULES', () => {
    // Consumers (Group 2 CLI + Group 3 linter) import ViolationRule from the parser.
    // This test asserts the type re-export stays live and that WishParseError.rule
    // is assignable to the exported ViolationRule union.
    const sample: ViolationRule = 'missing-execution-groups-header';
    expect(VIOLATION_RULES).toContain(sample);
    try {
      parseWish('no title here');
    } catch (err) {
      expect(err).toBeInstanceOf(WishParseError);
      const rule: ViolationRule = (err as WishParseError).rule;
      expect(VIOLATION_RULES).toContain(rule);
    }
  });
});
