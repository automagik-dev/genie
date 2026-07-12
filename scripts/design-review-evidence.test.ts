import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const REVIEWED_SHA256 = designReviewDigest(TEMPLATE);
const EVIDENCE_SCRIPT = join(import.meta.dir, '..', 'skills', 'brainstorm', 'references', 'design-review-evidence.mjs');

function runStamp(designPath: string, reviewedSha256?: string): ReturnType<typeof Bun.spawnSync> {
  const args = [
    'node',
    EVIDENCE_SCRIPT,
    'stamp',
    designPath,
    '--verdict',
    'SHIP',
    '--reviewer',
    'reviewer/thread-42',
    '--reviewed-at',
    REVIEWED_AT,
  ];
  if (reviewedSha256) args.push('--reviewed-sha256', reviewedSha256);
  return Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
}

describe('digest-bound design review evidence', () => {
  test('a SHIP stamp identifies the reviewer and exact reviewable bytes', () => {
    const stamped = stampDesignReview(TEMPLATE, {
      verdict: 'SHIP',
      reviewedSha256: REVIEWED_SHA256,
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
      reviewedSha256: REVIEWED_SHA256,
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
      reviewedSha256: REVIEWED_SHA256,
      reviewer: 'reviewer/thread-42',
      reviewedAt: REVIEWED_AT,
    });
    expect(designReviewViolations(fixFirst)).toContain('design review verdict must be SHIP');
    expect(designReviewViolations(TEMPLATE)).toContain('design review verdict must be SHIP');
    expect(designReviewViolations('# Design without evidence\n')[0]).toContain('exactly one bounded');
  });

  test('the API requires the digest returned by the reviewer', () => {
    expect(() =>
      stampDesignReview(TEMPLATE, {
        verdict: 'SHIP',
        reviewer: 'reviewer/thread-42',
        reviewedAt: REVIEWED_AT,
      }),
    ).toThrow('reviewed content SHA-256 must be 64 lowercase hex characters');
  });

  test('the API rejects an edit made after review and before stamping', () => {
    const changed = TEMPLATE.replace('## Problem', '## Problem\n\nChanged after review.');
    expect(() =>
      stampDesignReview(changed, {
        verdict: 'SHIP',
        reviewedSha256: REVIEWED_SHA256,
        reviewer: 'reviewer/thread-42',
        reviewedAt: REVIEWED_AT,
      }),
    ).toThrow('design changed after review; reviewed content SHA-256 no longer matches');
  });

  test('the CLI requires --reviewed-sha256 and does not write without it', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'genie-design-review-'));
    const designPath = join(fixtureDir, 'DESIGN.md');
    try {
      writeFileSync(designPath, TEMPLATE);
      const result = runStamp(designPath);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain('reviewed content SHA-256 must be 64 lowercase hex characters');
      expect(readFileSync(designPath, 'utf8')).toBe(TEMPLATE);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test('the CLI rejects edit-after-review-before-stamp without writing', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'genie-design-review-'));
    const designPath = join(fixtureDir, 'DESIGN.md');
    const changed = TEMPLATE.replace('## Problem', '## Problem\n\nChanged after review.');
    try {
      writeFileSync(designPath, changed);
      const result = runStamp(designPath, REVIEWED_SHA256);
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain(
        'design changed after review; reviewed content SHA-256 no longer matches',
      );
      expect(readFileSync(designPath, 'utf8')).toBe(changed);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
