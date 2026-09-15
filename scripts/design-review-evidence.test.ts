import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  DesignEvidenceError,
  designReviewDigest,
  designReviewViolations,
  parseDesignReviewEvidence,
  readDesign,
  stampDesignReview,
  writeDesign,
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

/**
 * r2 #16: the helper surfaced raw libuv text — `ENOENT: no such file or
 * directory, open '<path>'`, and an `EISDIR: illegal operation on a directory,
 * read` that named no path at all. A design gate speaks skill vocabulary: one
 * line naming the path and what was expected, exit 1 (a refusal), with exit 2
 * left for a helper that could not run at all (usage/internal).
 */
describe('file-access failures are skill-level diagnostics', () => {
  function run(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
    const result = Bun.spawnSync(['node', EVIDENCE_SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  function onlyLine(stderr: string): string {
    const lines = stderr.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    return lines[0];
  }

  test('an absent DESIGN.md names the path for every verb, never libuv text', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'genie-design-review-')), 'DESIGN.md');
    try {
      for (const args of [
        ['verify', missing],
        ['digest', missing],
        ['stamp', missing, '--verdict', 'SHIP', '--reviewer', 'reviewer/thread-42'],
      ]) {
        const result = run(args);
        const line = onlyLine(result.stderr);
        expect(line).toContain('DESIGN.md not found at');
        expect(line).toContain(missing);
        expect(line).not.toContain('ENOENT');
        expect(line).not.toContain('no such file or directory');
        expect(result.stdout).toBe('');
        expect(result.exitCode).toBe(1);
      }
    } finally {
      rmSync(dirname(missing), { recursive: true, force: true });
    }
  });

  test('a directory passed as DESIGN.md is named, where libuv named nothing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'genie-design-review-'));
    try {
      const result = run(['verify', directory]);
      const line = onlyLine(result.stderr);
      expect(line).toContain('DESIGN.md path is a directory, not a file');
      expect(line).toContain(directory);
      expect(line).not.toContain('EISDIR');
      expect(line).not.toContain('illegal operation');
      expect(result.exitCode).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a usage error still exits 2: a refusal and an unrunnable helper stay distinguishable', () => {
    const result = run(['bogus', 'DESIGN.md']);
    expect(onlyLine(result.stderr)).toContain('usage: design-review-evidence.mjs');
    expect(result.exitCode).toBe(2);
  });

  test('the read/write helpers throw typed refusals rather than raw errors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'genie-design-review-'));
    try {
      expect(() => readDesign(directory)).toThrow(DesignEvidenceError);
      expect(() => readDesign(join(directory, 'DESIGN.md'))).toThrow(
        `DESIGN.md not found at ${join(directory, 'DESIGN.md')}`,
      );
      expect(() => writeDesign(directory, 'stamped')).toThrow(DesignEvidenceError);
      expect(() => writeDesign(directory, 'stamped')).toThrow('stamped DESIGN.md cannot be written');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/**
 * M9/m18: `skills/wish/references/design-review-evidence.mjs` used to be an
 * 18-line shim re-exporting `../../brainstorm/references/…`, and skills.sh
 * supports installing one skill (`--skill wish`). Without a sibling
 * `brainstorm/` the wish design gate died with ERR_MODULE_NOT_FOUND instead of
 * refusing cleanly — the gate could not run at all. The shim's own rationale
 * ("Product distributions always ship the complete 23-skill set") was stale on
 * a 14-workflow release, and it was that assumption that justified the import.
 */
describe('every shipped skill is self-contained', () => {
  const SKILLS_ROOT = join(import.meta.dir, '..', 'skills');
  const WISH_SCRIPT = join(SKILLS_ROOT, 'wish', 'references', 'design-review-evidence.mjs');
  // Deliberately wider than the escape sweep that missed M9, which matched only
  // `(md|ts)` behind a single `../`.
  const ESCAPE = /(\.\.\/)+[A-Za-z0-9/_.-]+\.(?:md|ts|mjs|js|cjs|sh|py|yaml|yml|json)/g;

  function skillFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) skillFiles(path, out);
      else if (entry.isFile()) out.push(path);
    }
    return out;
  }

  test('no shipped skill file names a path outside its own skill directory', () => {
    const escapes: string[] = [];
    for (const skill of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const skillRoot = join(SKILLS_ROOT, skill.name);
      for (const file of skillFiles(skillRoot)) {
        for (const match of readFileSync(file, 'utf8').matchAll(ESCAPE)) {
          const resolved = resolve(dirname(file), match[0]);
          if (resolved !== skillRoot && !resolved.startsWith(`${skillRoot}/`)) {
            escapes.push(`${relative(SKILLS_ROOT, file)} -> ${match[0]}`);
          }
        }
      }
    }
    expect(escapes).toEqual([]);
  });

  test('the wish and brainstorm copies of the evidence helper are byte-identical', () => {
    expect(readFileSync(WISH_SCRIPT)).toEqual(readFileSync(EVIDENCE_SCRIPT));
  });

  test('the wish copy runs with no sibling skill installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-subset-skill-'));
    try {
      // Exactly what `skills.sh --skill wish` lays down: one skill, no siblings.
      const references = join(root, 'skills', 'wish', 'references');
      mkdirSync(references, { recursive: true });
      const script = join(references, 'design-review-evidence.mjs');
      cpSync(WISH_SCRIPT, script);
      const design = join(root, 'DESIGN.md');
      writeFileSync(design, TEMPLATE, 'utf8');

      const digest = Bun.spawnSync(['node', script, 'digest', design], { stdout: 'pipe', stderr: 'pipe' });
      expect(digest.stderr.toString()).toBe('');
      expect(digest.exitCode).toBe(0);
      expect(digest.stdout.toString().trim()).toBe(REVIEWED_SHA256);
      // The gate itself still refuses an unstamped design — cleanly, exit 1.
      const verify = Bun.spawnSync(['node', script, 'verify', design], { stdout: 'pipe', stderr: 'pipe' });
      expect(verify.exitCode).toBe(1);
      expect(verify.stderr.toString()).not.toContain('ERR_MODULE_NOT_FOUND');
      expect(verify.stderr.toString()).toContain('design review verdict must be SHIP');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
