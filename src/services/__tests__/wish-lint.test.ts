/**
 * Wish linter tests.
 *
 * Every rule listed in `VIOLATION_RULES` (src/services/wish-schema.ts) gets:
 *   - A positive case (rule NOT emitted on a clean wish).
 *   - A negative case (rule emitted when deliberately broken).
 *   - For fixable rules: fix-and-revalidate asserts the rule is gone after
 *     `applyFixes`. Idempotency asserts that applying the same fix report
 *     twice yields the same output as once.
 *
 * The tests also assert the shape contract: `LintReport.summary` counts
 * match the violation list; `violations` is sorted by (line, column, rule).
 */

import { describe, expect, test } from 'bun:test';
import { applyFixes, formatLintReport, lintMarkdown, lintWish } from '../wish-lint.js';
import { WishParseError, parseWish, parseWishFile } from '../wish-parser.js';
import { VIOLATION_RULES } from '../wish-schema.js';

const WORKTREE_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const POSITIVE_SLUG = 'wish-command-group-restructure';

// ============================================================================
// Fixture builders
// ============================================================================

function cleanMinimalWish(): string {
  return [
    '# Wish: Clean Minimal',
    '',
    '| Field | Value |',
    '|-------|-------|',
    '| **Status** | DRAFT |',
    '| **Slug** | `clean-minimal` |',
    '| **Date** | 2026-04-19 |',
    '| **Author** | felipe |',
    '| **Appetite** | small |',
    '| **Branch** | `wish/clean-minimal` |',
    '',
    '## Summary',
    '',
    'A clean, structurally valid wish used as the positive baseline.',
    '',
    '## Scope',
    '',
    '### IN',
    '',
    '- the thing',
    '',
    '### OUT',
    '',
    '- everything else',
    '',
    '## Execution Groups',
    '',
    '### Group 1: Do the thing',
    '',
    '**Goal:** Make the widget.',
    '',
    '**Deliverables:**',
    '1. widget.ts',
    '',
    '**Acceptance Criteria:**',
    '- [ ] widget.ts exists',
    '',
    '**Validation:**',
    '```bash',
    'test -f widget.ts',
    '```',
    '',
    '**depends-on:** none',
    '',
  ].join('\n');
}

function cleanMultiGroupWish(): string {
  return [
    '# Wish: Multi Group',
    '',
    '| Field | Value |',
    '|-------|-------|',
    '| **Status** | DRAFT |',
    '| **Slug** | `multi` |',
    '| **Date** | 2026-04-19 |',
    '| **Author** | felipe |',
    '| **Appetite** | medium |',
    '| **Branch** | `wish/multi` |',
    '',
    '## Summary',
    '',
    'Multi-group wish.',
    '',
    '## Scope',
    '',
    '### IN',
    '',
    '- things',
    '',
    '### OUT',
    '',
    '- other things',
    '',
    '## Execution Groups',
    '',
    '### Group 1: First',
    '',
    '**Goal:** One.',
    '',
    '**Deliverables:**',
    '1. one.ts',
    '',
    '**Acceptance Criteria:**',
    '- [ ] one exists',
    '',
    '**Validation:**',
    '```bash',
    'true',
    '```',
    '',
    '**depends-on:** none',
    '',
    '---',
    '',
    '### Group 2: Second',
    '',
    '**Goal:** Two.',
    '',
    '**Deliverables:**',
    '1. two.ts',
    '',
    '**Acceptance Criteria:**',
    '- [ ] two exists',
    '',
    '**Validation:**',
    '```bash',
    'true',
    '```',
    '',
    '**depends-on:** Group 1',
    '',
  ].join('\n');
}

// Wraps a single-group wish template with customizable group body.
function wishWithGroupBody(groupBody: string[]): string {
  return [
    '# Wish: Custom',
    '',
    '| Field | Value |',
    '|-------|-------|',
    '| **Status** | DRAFT |',
    '| **Slug** | `custom` |',
    '| **Date** | 2026-04-19 |',
    '| **Author** | felipe |',
    '| **Appetite** | small |',
    '| **Branch** | `wish/custom` |',
    '',
    '## Summary',
    '',
    'x',
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
    '## Execution Groups',
    '',
    '### Group 1: Title',
    '',
    ...groupBody,
    '',
  ].join('\n');
}

// ============================================================================
// Shape / export contract
// ============================================================================

describe('lintWish — shape contract', () => {
  test('clean wish produces zero violations and summary=0', () => {
    const md = cleanMinimalWish();
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations).toEqual([]);
    expect(report.summary).toEqual({ total: 0, fixable: 0, unfixable: 0 });
    expect(report.wish).toBe('clean-minimal');
  });

  test('summary counts match violations list (fixable/unfixable split)', () => {
    const md = cleanMinimalWish().replace('### OUT\n\n- everything else', '### OUT\n\n');
    const doc = parseWish(md);
    // Schema rejects (OUT is empty), parser returns doc — lintWish sees the empty OUT via raw scan.
    const report = lintWish(doc, md);
    const fixable = report.violations.filter((v) => v.fixable).length;
    const unfixable = report.violations.filter((v) => !v.fixable).length;
    expect(report.summary.total).toBe(report.violations.length);
    expect(report.summary.fixable).toBe(fixable);
    expect(report.summary.unfixable).toBe(unfixable);
  });

  test('violations are sorted by line then column then rule', () => {
    // Introduce multiple distinct issues across the file so the sort path gets exercised.
    const md = cleanMultiGroupWish()
      .replace('### Group 2: Second', '### Grupo 2 — Second')
      .replace('**depends-on:** none', '**depends-on:** Groups 1 and 2');
    let report: ReturnType<typeof lintWish>;
    try {
      const parsed = parseWish(md);
      report = lintWish(parsed, md);
    } catch (err) {
      if (err instanceof WishParseError) report = lintWish(err, md);
      else throw err;
    }
    expect(report.violations.length).toBeGreaterThan(1);
    for (let i = 1; i < report.violations.length; i++) {
      const prev = report.violations[i - 1];
      const cur = report.violations[i];
      if (!prev || !cur) continue;
      if (prev.line === cur.line && prev.column === cur.column) {
        expect(prev.rule.localeCompare(cur.rule)).toBeLessThanOrEqual(0);
      } else if (prev.line === cur.line) {
        expect(prev.column).toBeLessThanOrEqual(cur.column);
      } else {
        expect(prev.line).toBeLessThanOrEqual(cur.line);
      }
    }
  });

  test('every VIOLATION_RULES literal is a string', () => {
    for (const rule of VIOLATION_RULES) {
      expect(typeof rule).toBe('string');
    }
  });
});

// ============================================================================
// Positive: live in-tree wish
// ============================================================================

describe('lintWish — positive fixture from disk', () => {
  test(`${POSITIVE_SLUG} parses and lints with zero errors (or only content warnings)`, () => {
    const doc = parseWishFile(POSITIVE_SLUG, { repoRoot: WORKTREE_ROOT });
    // Read the raw markdown for the same wish.
    const fs = require('node:fs') as typeof import('node:fs');
    const path = `${WORKTREE_ROOT}/.genie/wishes/${POSITIVE_SLUG}/WISH.md`;
    const md = fs.readFileSync(path, 'utf-8');
    const report = lintWish(doc, md);
    // The in-tree wish is allowed to carry non-fixable content nits (e.g., Portuguese in wave titles),
    // but must not contain any fixable structural errors — those are what Group 3 ships to auto-repair.
    const fixableErrors = report.violations.filter((v) => v.severity === 'error' && v.fixable);
    if (fixableErrors.length > 0) {
      console.error('Unexpected fixable errors in positive fixture:', fixableErrors);
    }
    expect(fixableErrors).toEqual([]);
  });
});

// ============================================================================
// Parse-error path
// ============================================================================

describe('lintWish — parse-error surfacing', () => {
  test('missing-execution-groups-header surfaces as a violation with a fix', () => {
    const md = cleanMinimalWish().replace('## Execution Groups\n\n### Group 1:', '### Grupo 1:');
    let report: ReturnType<typeof lintWish>;
    try {
      const doc = parseWish(md);
      report = lintWish(doc, md);
    } catch (err) {
      if (err instanceof WishParseError) report = lintWish(err, md);
      else throw err;
    }
    expect(report.violations.some((v) => v.rule === 'missing-execution-groups-header')).toBe(true);
    const missingHdr = report.violations.find((v) => v.rule === 'missing-execution-groups-header');
    expect(missingHdr?.fixable).toBe(true);
    expect(missingHdr?.fix).not.toBeNull();
  });

  test('missing-execution-groups-header emits group-header-format for each stray Portuguese header', () => {
    const md = cleanMultiGroupWish()
      .replace('## Execution Groups\n\n', '')
      .replace('### Group 1: First', '### Grupo 1 — First')
      .replace('### Group 2: Second', '### Grupo 2 — Second');
    const parse = (): WishParseError => {
      try {
        parseWish(md);
        throw new Error('expected parse to throw');
      } catch (err) {
        if (err instanceof WishParseError) return err;
        throw err;
      }
    };
    const err = parse();
    const report = lintWish(err, md);
    const strayCount = report.violations.filter((v) => v.rule === 'group-header-format').length;
    expect(strayCount).toBe(2);
  });

  test('missing-title parse error surfaces as violation', () => {
    const md = 'no title here';
    try {
      parseWish(md);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WishParseError);
      const report = lintWish(err as WishParseError, md);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0]?.rule).toBe('missing-title');
    }
  });
});

// ============================================================================
// Post-parse structural rules
// ============================================================================

describe('lintWish — post-parse rules', () => {
  test('group-header-format fires for `### Grupo N — Title` under Execution Groups', () => {
    // `## Execution Groups` is present but a non-canonical sibling appears.
    const md = [cleanMultiGroupWish().replace('### Group 2: Second', '### Grupo 2 — Second')].join('');
    // Parser silently ignores the non-canonical header — we can still parse Group 1.
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'group-header-format' && v.fixable)).toBe(true);
  });

  test('missing-goal-field fires when the **Goal:** label is absent', () => {
    const md = wishWithGroupBody([
      '**Deliverables:**',
      '1. foo.ts',
      '',
      '**Acceptance Criteria:**',
      '- [ ] foo.ts exists',
      '',
      '**Validation:**',
      '```bash',
      'true',
      '```',
      '',
      '**depends-on:** none',
    ]);
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    const v = report.violations.find((x) => x.rule === 'missing-goal-field');
    expect(v).toBeDefined();
    expect(v?.fixable).toBe(true);
  });

  test('missing-deliverables-field fires when the label is absent', () => {
    const md = wishWithGroupBody([
      '**Goal:** do it',
      '',
      '**Acceptance Criteria:**',
      '- [ ] ok',
      '',
      '**Validation:**',
      '```bash',
      'true',
      '```',
      '',
      '**depends-on:** none',
    ]);
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'missing-deliverables-field' && v.fixable)).toBe(true);
  });

  test('missing-acceptance-field fires when label absent', () => {
    const md = wishWithGroupBody([
      '**Goal:** do it',
      '',
      '**Deliverables:**',
      '1. foo',
      '',
      '**Validation:**',
      '```bash',
      'true',
      '```',
      '',
      '**depends-on:** none',
    ]);
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'missing-acceptance-field' && v.fixable)).toBe(true);
  });

  test('missing-validation-field fires when label absent', () => {
    const md = wishWithGroupBody([
      '**Goal:** do it',
      '',
      '**Deliverables:**',
      '1. foo',
      '',
      '**Acceptance Criteria:**',
      '- [ ] ok',
      '',
      '**depends-on:** none',
    ]);
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'missing-validation-field' && v.fixable)).toBe(true);
  });

  test('missing-depends-on-field fires when label absent', () => {
    const md = wishWithGroupBody([
      '**Goal:** do it',
      '',
      '**Deliverables:**',
      '1. foo',
      '',
      '**Acceptance Criteria:**',
      '- [ ] ok',
      '',
      '**Validation:**',
      '```bash',
      'true',
      '```',
    ]);
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'missing-depends-on-field' && v.fixable)).toBe(true);
  });

  test('validation-not-fenced-bash fires when content present but no fenced bash block', () => {
    const md = wishWithGroupBody([
      '**Goal:** do it',
      '',
      '**Deliverables:**',
      '1. foo',
      '',
      '**Acceptance Criteria:**',
      '- [ ] ok',
      '',
      '**Validation:**',
      'echo running tests',
      'true',
      '',
      '**depends-on:** none',
    ]);
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'validation-not-fenced-bash' && v.fixable)).toBe(true);
  });

  test('validation-not-fenced-bash also fires when fence tag is not `bash`', () => {
    const md = wishWithGroupBody([
      '**Goal:** do it',
      '',
      '**Deliverables:**',
      '1. foo',
      '',
      '**Acceptance Criteria:**',
      '- [ ] ok',
      '',
      '**Validation:**',
      '```sh',
      'true',
      '```',
      '',
      '**depends-on:** none',
    ]);
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'validation-not-fenced-bash' && v.fixable)).toBe(true);
  });

  test('missing-validation-command fires when fenced block is empty', () => {
    const md = wishWithGroupBody([
      '**Goal:** do it',
      '',
      '**Deliverables:**',
      '1. foo',
      '',
      '**Acceptance Criteria:**',
      '- [ ] ok',
      '',
      '**Validation:**',
      '```bash',
      '```',
      '',
      '**depends-on:** none',
    ]);
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    const v = report.violations.find((x) => x.rule === 'missing-validation-command');
    expect(v).toBeDefined();
    expect(v?.fixable).toBe(false);
  });

  test('empty-out-scope fires when OUT is present but has no bullets (not fixable)', () => {
    const md = cleanMinimalWish().replace('### OUT\n\n- everything else', '### OUT\n');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    const v = report.violations.find((x) => x.rule === 'empty-out-scope');
    expect(v).toBeDefined();
    expect(v?.fixable).toBe(false);
  });

  test('scope-section-missing fires when OUT is absent (fixable: insert OUT stub)', () => {
    const md = cleanMinimalWish().replace('### OUT\n\n- everything else\n\n', '');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    const v = report.violations.find((x) => x.rule === 'scope-section-missing');
    expect(v).toBeDefined();
    expect(v?.fixable).toBe(true);
  });

  test('depends-on-dangling fires when reference is not a real group', () => {
    const md = cleanMinimalWish().replace('**depends-on:** none', '**depends-on:** Group 99');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    const v = report.violations.find((x) => x.rule === 'depends-on-dangling');
    expect(v).toBeDefined();
    expect(v?.fixable).toBe(false);
  });

  test('depends-on-malformed fixable when refs resolve but format is wrong', () => {
    const md = cleanMultiGroupWish().replace('**depends-on:** Group 1', '**depends-on:** Groups 1 and 2');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    const v = report.violations.find((x) => x.rule === 'depends-on-malformed');
    expect(v).toBeDefined();
    expect(v?.fixable).toBe(true);
  });

  test('depends-on accepts canonical numeric form (regression)', () => {
    const md = cleanMultiGroupWish(); // Group 2 already declares `**depends-on:** Group 1`
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'depends-on-malformed')).toBe(false);
    expect(report.violations.some((v) => v.rule === 'depends-on-dangling')).toBe(false);
  });

  test('depends-on accepts descriptive in-wish names (Foundation, Migration)', () => {
    const md = cleanMultiGroupWish().replace('**depends-on:** Group 1', '**depends-on:** Foundation, Migration');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'depends-on-malformed')).toBe(false);
    expect(report.violations.some((v) => v.rule === 'depends-on-dangling')).toBe(false);
  });

  test('depends-on accepts same-wish slash form (slug/group-1, slug/foundation)', () => {
    const md = cleanMultiGroupWish().replace(
      '**depends-on:** Group 1',
      '**depends-on:** multi/group-1, multi/foundation',
    );
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'depends-on-malformed')).toBe(false);
    expect(report.violations.some((v) => v.rule === 'depends-on-dangling')).toBe(false);
  });

  test('depends-on accepts cross-wish bare slug', () => {
    const md = cleanMultiGroupWish().replace('**depends-on:** Group 1', '**depends-on:** other-wish');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'depends-on-malformed')).toBe(false);
    expect(report.violations.some((v) => v.rule === 'depends-on-dangling')).toBe(false);
  });

  test('depends-on accepts cross-wish repo/slug form', () => {
    const md = cleanMultiGroupWish().replace('**depends-on:** Group 1', '**depends-on:** automagik-dev/other-wish');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'depends-on-malformed')).toBe(false);
    expect(report.violations.some((v) => v.rule === 'depends-on-dangling')).toBe(false);
  });

  test('depends-on accepts fully qualified repo/slug/group-N form', () => {
    const md = cleanMultiGroupWish().replace(
      '**depends-on:** Group 1',
      '**depends-on:** automagik-dev/rlmx/rlmx-sdk-upgrade/group-2',
    );
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'depends-on-malformed')).toBe(false);
    expect(report.violations.some((v) => v.rule === 'depends-on-dangling')).toBe(false);
  });

  test('depends-on accepts mixed numeric, cross-wish, and descriptive refs', () => {
    const md = cleanMultiGroupWish().replace(
      '**depends-on:** Group 1',
      '**depends-on:** Group 1, other-wish/foundation, automagik-dev/genie/some-wish/group-5',
    );
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'depends-on-malformed')).toBe(false);
    expect(report.violations.some((v) => v.rule === 'depends-on-dangling')).toBe(false);
  });

  test('depends-on still rejects truly malformed punctuation', () => {
    const md = cleanMultiGroupWish().replace('**depends-on:** Group 1', '**depends-on:** !@#$');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    const v = report.violations.find((x) => x.rule === 'depends-on-malformed');
    expect(v).toBeDefined();
    expect(v?.fixable).toBe(false);
  });

  test('todo-placeholder-remaining fires on `<TODO>` markers, bypassed by allowTodoPlaceholders', () => {
    const md = cleanMinimalWish().replace('widget.ts exists', '<TODO: real criterion>');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'todo-placeholder-remaining')).toBe(true);

    const bypassed = lintWish(doc, md, { allowTodoPlaceholders: true });
    expect(bypassed.violations.some((v) => v.rule === 'todo-placeholder-remaining')).toBe(false);
  });
});

// ============================================================================
// Fix-and-revalidate + idempotency
// ============================================================================

describe('applyFixes — fix-and-revalidate cycles', () => {
  test('group-header-format: rewrite persists and rule no longer fires', () => {
    const md = cleanMultiGroupWish().replace('### Group 2: Second', '### Grupo 2 — Second');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    expect(report.violations.some((v) => v.rule === 'group-header-format')).toBe(true);
    const fixed = applyFixes(md, report);
    expect(fixed).toContain('### Group 2: Second');
    expect(fixed).not.toContain('### Grupo 2 —');
    // Re-lint should not re-fire the same rule.
    const doc2 = parseWish(fixed);
    const report2 = lintWish(doc2, fixed);
    expect(report2.violations.some((v) => v.rule === 'group-header-format')).toBe(false);
  });

  test('validation-not-fenced-bash: wraps prose in ```bash fence', () => {
    const md = wishWithGroupBody([
      '**Goal:** do it',
      '',
      '**Deliverables:**',
      '1. foo',
      '',
      '**Acceptance Criteria:**',
      '- [ ] ok',
      '',
      '**Validation:**',
      'true',
      '',
      '**depends-on:** none',
    ]);
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    const fixed = applyFixes(md, report);
    expect(fixed).toMatch(/\*\*Validation:\*\*\n```bash\ntrue\n```/);
    // Re-lint must not re-emit the rule.
    const report2 = lintWish(parseWish(fixed), fixed);
    expect(report2.violations.some((v) => v.rule === 'validation-not-fenced-bash')).toBe(false);
  });

  test('depends-on-malformed: fix rewrites to canonical form', () => {
    const md = cleanMultiGroupWish().replace('**depends-on:** Group 1', '**depends-on:** Groups 1 and 2');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    const fixed = applyFixes(md, report);
    expect(fixed).toContain('**depends-on:** Group 1, Group 2');
    const report2 = lintWish(parseWish(fixed), fixed);
    expect(report2.violations.some((v) => v.rule === 'depends-on-malformed')).toBe(false);
  });

  test('applyFixes is idempotent: applying twice === applying once', () => {
    const md = cleanMultiGroupWish().replace('### Group 2: Second', '### Grupo 2 — Second');
    const doc = parseWish(md);
    const report = lintWish(doc, md);
    const onceFixed = applyFixes(md, report);
    const report2 = lintWish(parseWish(onceFixed), onceFixed);
    const twiceFixed = applyFixes(onceFixed, report2);
    expect(twiceFixed).toBe(onceFixed);
  });

  test('missing-execution-groups-header + group-header-format batch fix', () => {
    const md = cleanMultiGroupWish()
      .replace('## Execution Groups\n\n', '')
      .replace('### Group 1: First', '### Grupo 1 — First')
      .replace('### Group 2: Second', '### Grupo 2 — Second');
    let report: ReturnType<typeof lintWish>;
    try {
      parseWish(md);
      throw new Error('expected parser to throw');
    } catch (err) {
      if (err instanceof WishParseError) {
        report = lintWish(err, md);
      } else {
        throw err;
      }
    }
    const fixed = applyFixes(md, report);
    expect(fixed).toContain('## Execution Groups');
    expect(fixed).toContain('### Group 1: First');
    expect(fixed).toContain('### Group 2: Second');
    // Re-parse should now succeed.
    const doc2 = parseWish(fixed);
    expect(doc2.executionGroups).toHaveLength(2);
  });
});

// ============================================================================
// lintMarkdown convenience + formatLintReport
// ============================================================================

describe('lintMarkdown + formatLintReport', () => {
  test('lintMarkdown wraps parse errors automatically', () => {
    const md = 'no title here';
    const report = lintMarkdown(md);
    expect(report.violations.some((v) => v.rule === 'missing-title')).toBe(true);
  });

  test('formatLintReport emits `file:line:col: severity [rule] — message` format', () => {
    const md = cleanMultiGroupWish().replace('### Group 2: Second', '### Grupo 2 — Second');
    const report = lintWish(parseWish(md), md);
    const formatted = formatLintReport(report, { path: '/tmp/fake/WISH.md' });
    expect(formatted).toContain('/tmp/fake/WISH.md:');
    expect(formatted).toContain('error');
    expect(formatted).toContain('[group-header-format]');
    expect(formatted).toContain(' — ');
  });

  test('formatLintReport on clean wish reports no violations', () => {
    const md = cleanMinimalWish();
    const report = lintWish(parseWish(md), md);
    const formatted = formatLintReport(report, { path: '/tmp/clean/WISH.md' });
    expect(formatted).toContain('no violations');
  });
});
