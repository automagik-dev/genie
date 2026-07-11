import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  designReviewDigest,
  designReviewViolations,
  parseDesignReviewEvidence,
  stampDesignReview,
} from '../skills/brainstorm/references/design-review-evidence.mjs';

const TEMPLATE = readFileSync(
  join(import.meta.dir, '..', 'skills', 'brainstorm', 'references', 'design-template.md'),
  'utf8',
);
const REVIEWED_AT = '2026-07-11T12:00:00.000Z';

describe('digest-bound design review evidence', () => {
  test('a SHIP stamp identifies the reviewer and exact reviewable bytes', () => {
    const stamped = stampDesignReview(TEMPLATE, {
      verdict: 'SHIP',
      reviewer: 'reviewer/thread-42',
      reviewedAt: REVIEWED_AT,
    });
    expect(designReviewViolations(stamped)).toEqual([]);
    expect(parseDesignReviewEvidence(stamped)).toEqual({
      verdict: 'SHIP',
      digest: designReviewDigest(stamped),
      reviewer: 'reviewer/thread-42',
      reviewedAt: REVIEWED_AT,
    });
  });

  test('editing reviewed design content invalidates the evidence', () => {
    const stamped = stampDesignReview(TEMPLATE, {
      verdict: 'SHIP',
      reviewer: 'reviewer/thread-42',
      reviewedAt: REVIEWED_AT,
    });
    const changed = stamped.replace('## Problem', '## Problem\n\nNew requirement.');
    expect(designReviewViolations(changed)).toContain(
      'design changed after review; reviewed content SHA-256 no longer matches',
    );
  });

  test('non-SHIP, pending, and unbounded evidence cannot advance to wish', () => {
    const fixFirst = stampDesignReview(TEMPLATE, {
      verdict: 'FIX-FIRST',
      reviewer: 'reviewer/thread-42',
      reviewedAt: REVIEWED_AT,
    });
    expect(designReviewViolations(fixFirst)).toContain('design review verdict must be SHIP');
    expect(designReviewViolations(TEMPLATE)).toContain('design review verdict must be SHIP');
    expect(designReviewViolations('# Design without evidence\n')[0]).toContain('exactly one bounded');
  });
});
