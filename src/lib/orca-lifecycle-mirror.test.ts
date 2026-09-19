import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as mirrorModule from './orca-lifecycle-mirror.js';
import {
  GENIE_TRANSITIONS,
  MAX_EVIDENCE_BYTES,
  MirrorInputError,
  ORCA_WORKSPACE_STATUSES,
  REVIEW_VERDICTS,
  mirrorTransition,
} from './orca-lifecycle-mirror.js';

const TODAY = '2026-09-19';

/** The reason of the MirrorInputError `call` throws, or `null` when it does not throw. */
function reasonOf(call: () => unknown): string | null {
  try {
    call();
    return null;
  } catch (error) {
    if (error instanceof MirrorInputError) return error.reason;
    throw error;
  }
}

describe('the transition map', () => {
  test('is exactly the five rows the design fixes', () => {
    const rows = GENIE_TRANSITIONS.map((to) => [
      to,
      mirrorTransition({
        to,
        verdict: to === 'REVIEW' ? 'SHIP' : undefined,
        evidence: 'e',
        today: TODAY,
      }).workspaceStatus,
    ]);
    expect(rows).toEqual([
      ['APPROVED', 'todo'],
      ['IN_PROGRESS', 'in-progress'],
      ['REVIEW', 'in-review'],
      ['SHIPPED', 'completed'],
      ['BLOCKED', 'in-progress'],
    ]);
  });

  test('never produces a status outside Orca’s four board columns', () => {
    for (const [, status] of GENIE_TRANSITIONS.map((to) => [
      to,
      mirrorTransition({ to, verdict: to === 'REVIEW' ? 'SHIP' : undefined, evidence: 'e', today: TODAY })
        .workspaceStatus,
    ])) {
      expect(ORCA_WORKSPACE_STATUSES).toContain(status as (typeof ORCA_WORKSPACE_STATUSES)[number]);
    }
  });

  test('BLOCKED is the waiting-on-a-human transition, not a board column of its own', () => {
    expect(mirrorTransition({ to: 'BLOCKED', evidence: 'x', today: TODAY }).workspaceStatus).toBe('in-progress');
    expect(ORCA_WORKSPACE_STATUSES as readonly string[]).not.toContain('blocked');
  });
});

describe('the comment format', () => {
  test('the design’s review example, verbatim', () => {
    expect(
      mirrorTransition({
        to: 'REVIEW',
        verdict: 'FIX-FIRST',
        evidence: 'group 2, head 0ef761c, 3 gaps',
        today: '2026-09-19',
      }),
    ).toEqual({
      workspaceStatus: 'in-review',
      comment: '2026-09-19 genie review: FIX-FIRST — group 2, head 0ef761c, 3 gaps',
    });
  });

  test('the design’s blocked example, verbatim', () => {
    expect(
      mirrorTransition({
        to: 'BLOCKED',
        evidence: 'gate gate_7f3a: Merge PR #3005 into dev?',
        today: '2026-09-19',
      }),
    ).toEqual({
      workspaceStatus: 'in-progress',
      comment: '2026-09-19 genie blocked — gate gate_7f3a: Merge PR #3005 into dev?',
    });
  });

  test('uses the lowercase transition word, with `in progress` spelled as two words', () => {
    const comments = GENIE_TRANSITIONS.map(
      (to) =>
        mirrorTransition({ to, verdict: to === 'REVIEW' ? 'SHIP' : undefined, evidence: 'e', today: TODAY }).comment,
    );
    expect(comments).toEqual([
      '2026-09-19 genie approved — e',
      '2026-09-19 genie in progress — e',
      '2026-09-19 genie review: SHIP — e',
      '2026-09-19 genie shipped — e',
      '2026-09-19 genie blocked — e',
    ]);
  });

  test('every verdict rides the REVIEW comment after a colon', () => {
    for (const verdict of REVIEW_VERDICTS) {
      expect(mirrorTransition({ to: 'REVIEW', verdict, evidence: 'e', today: TODAY }).comment).toBe(
        `2026-09-19 genie review: ${verdict} — e`,
      );
    }
  });

  test('carries the `<date> genie ` prefix the notification channel recognizes', () => {
    expect(mirrorTransition({ to: 'SHIPPED', evidence: 'merged 98104af', today: TODAY }).comment).toStartWith(
      '2026-09-19 genie ',
    );
  });

  test('normalizes evidence to NFC so the adapter’s comment domain accepts it', () => {
    const decomposed = 'revisório'; // "o" + combining acute
    const { comment } = mirrorTransition({ to: 'IN_PROGRESS', evidence: decomposed, today: TODAY });
    expect(comment).toBe(comment.normalize('NFC'));
    expect(comment).toEndWith('revisório');
  });

  test('the widest legal comment still fits the adapter’s one-line 512-byte domain', () => {
    const evidence = 'é'.repeat(MAX_EVIDENCE_BYTES / 2);
    const { comment } = mirrorTransition({ to: 'REVIEW', verdict: 'FIX-FIRST', evidence, today: TODAY });
    expect(Buffer.byteLength(evidence, 'utf8')).toBe(MAX_EVIDENCE_BYTES);
    expect(Buffer.byteLength(comment, 'utf8')).toBeLessThanOrEqual(512);
    expect(comment).not.toInclude('\n');
  });
});

describe('typed input refusals', () => {
  test('REVIEW without a verdict is refused', () => {
    expect(reasonOf(() => mirrorTransition({ to: 'REVIEW', evidence: 'e', today: TODAY }))).toBe('verdict_required');
  });

  test('a verdict on any other transition is refused', () => {
    for (const to of ['APPROVED', 'IN_PROGRESS', 'SHIPPED', 'BLOCKED']) {
      expect(reasonOf(() => mirrorTransition({ to, verdict: 'SHIP', evidence: 'e', today: TODAY }))).toBe(
        'verdict_not_allowed',
      );
    }
  });

  test('an unknown transition or verdict is refused', () => {
    expect(reasonOf(() => mirrorTransition({ to: 'DONE', evidence: 'e', today: TODAY }))).toBe('unknown_transition');
    expect(reasonOf(() => mirrorTransition({ to: 'review', evidence: 'e', today: TODAY }))).toBe('unknown_transition');
    expect(reasonOf(() => mirrorTransition({ to: 'REVIEW', verdict: 'ship', evidence: 'e', today: TODAY }))).toBe(
      'unknown_verdict',
    );
  });

  test('an Orca workspace status is not a genie transition', () => {
    for (const status of ORCA_WORKSPACE_STATUSES) {
      expect(reasonOf(() => mirrorTransition({ to: status, evidence: 'e', today: TODAY }))).toBe('unknown_transition');
    }
  });

  test('empty, blank, multi-line and oversized evidence are refused', () => {
    expect(reasonOf(() => mirrorTransition({ to: 'SHIPPED', evidence: '', today: TODAY }))).toBe('evidence_empty');
    expect(reasonOf(() => mirrorTransition({ to: 'SHIPPED', evidence: '   ', today: TODAY }))).toBe('evidence_empty');
    expect(reasonOf(() => mirrorTransition({ to: 'SHIPPED', evidence: 'a\nb', today: TODAY }))).toBe(
      'evidence_not_one_line',
    );
    expect(reasonOf(() => mirrorTransition({ to: 'SHIPPED', evidence: 'a\tb', today: TODAY }))).toBe(
      'evidence_not_one_line',
    );
    expect(reasonOf(() => mirrorTransition({ to: 'SHIPPED', evidence: 'a\u007fb', today: TODAY }))).toBe(
      'evidence_not_one_line',
    );
    expect(reasonOf(() => mirrorTransition({ to: 'SHIPPED', evidence: 'a'.repeat(301), today: TODAY }))).toBe(
      'evidence_too_long',
    );
    // 300 characters is not 300 bytes: the budget is the card's, measured in UTF-8.
    expect(reasonOf(() => mirrorTransition({ to: 'SHIPPED', evidence: 'é'.repeat(151), today: TODAY }))).toBe(
      'evidence_too_long',
    );
    expect(reasonOf(() => mirrorTransition({ to: 'SHIPPED', evidence: 'a'.repeat(300), today: TODAY }))).toBeNull();
  });

  test('a today that is not a calendar YYYY-MM-DD is refused', () => {
    for (const today of ['2026-9-19', '19-09-2026', '2026-09-19T00:00:00Z', '2026-13-01', '2026-02-30', '']) {
      expect(reasonOf(() => mirrorTransition({ to: 'SHIPPED', evidence: 'e', today }))).toBe('invalid_today');
    }
  });

  test('the error names its reason and carries no Orca vocabulary in the type', () => {
    try {
      mirrorTransition({ to: 'REVIEW', evidence: 'e', today: TODAY });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(MirrorInputError);
      expect((error as MirrorInputError).name).toBe('MirrorInputError');
      expect((error as MirrorInputError).message).toContain('--verdict');
    }
  });
});

describe('the module surface', () => {
  test('exports exactly the mirror vocabulary and one function', () => {
    expect(Object.keys(mirrorModule).sort()).toEqual([
      'GENIE_TRANSITIONS',
      'MAX_EVIDENCE_BYTES',
      'MirrorInputError',
      'ORCA_WORKSPACE_STATUSES',
      'REVIEW_VERDICTS',
      'mirrorTransition',
    ]);
  });

  test('the one function takes one genie-shaped argument: no export accepts an Orca status', () => {
    expect(typeof mirrorTransition).toBe('function');
    expect(mirrorTransition.length).toBe(1);
    // The map is one-way by construction: `mirrorTransition` is the only
    // callable, its single parameter is `{to, verdict?, evidence, today}`, and
    // `to` is validated against GENIE_TRANSITIONS — an Orca status coming back
    // in has no entry point at all.
    expect(GENIE_TRANSITIONS.some((to) => (ORCA_WORKSPACE_STATUSES as readonly string[]).includes(to))).toBe(false);
  });

  test('the module imports nothing: no adapter, no I/O, no clock — one-way by construction', () => {
    const source = readFileSync(new URL('./orca-lifecycle-mirror.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toContain('orca-orchestration-adapter');
    expect(source).not.toContain('node:');
    // `new Date(<given>)` parses the caller's `today`; a clock read would be `new Date()` / `Date.now()`.
    expect(source).not.toMatch(/new Date\(\s*\)/);
    expect(source).not.toContain('Date.now(');
  });

  test('the vocabularies are the frozen ones the wish pins', () => {
    expect([...GENIE_TRANSITIONS]).toEqual(['APPROVED', 'IN_PROGRESS', 'REVIEW', 'SHIPPED', 'BLOCKED']);
    expect([...REVIEW_VERDICTS]).toEqual(['SHIP', 'FIX-FIRST', 'BLOCKED']);
    expect([...ORCA_WORKSPACE_STATUSES]).toEqual(['todo', 'in-progress', 'in-review', 'completed']);
    expect(MAX_EVIDENCE_BYTES).toBe(300);
  });
});
