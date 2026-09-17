import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Two script-side guards of `.claude/workflows/wish.js` decide whether a run publishes: the darwin
// tolerance (issue #2926) and the base refusal. No module can import them — the runtime executes the
// script — so, as `scripts/workflows-model-policy.test.ts` already does with workfly's clamp, each
// declaration is lifted out of the shipped source and evaluated here. The behaviour under test is
// therefore the text that ships, never a copy of it.

const ROOT = join(import.meta.dir, '..');
const SCRIPT = readFileSync(join(ROOT, '.claude', 'workflows', 'wish.js'), 'utf8');

function lift(pattern: RegExp): string {
  const match = pattern.exec(SCRIPT);
  if (!match) throw new Error(`wish.js: nothing matched ${pattern}`);
  return match[0];
}

const DECLARATIONS = [
  lift(/^const text = .*$/m),
  lift(/^const DARWIN_TOLERATED = \[[\s\S]*?^\]$/m),
  lift(/^const withoutTiming = .*$/m),
  lift(/^function toleratedIndex\(entry\) \{[\s\S]*?^\}$/m),
  lift(/^function darwinTolerable\(failingTests, baseReconfirmed\) \{[\s\S]*?^\}$/m),
  lift(/^const BRANCH_NAME = .*$/m),
  lift(/^const PROTECTED_BASE = .*$/m),
  lift(/^function baseRefusal\(base\) \{[\s\S]*?^\}$/m),
].join('\n');

interface KnownFailure {
  file: string;
  test: string;
}

const api = new Function(
  `${DECLARATIONS}\nreturn { DARWIN_TOLERATED, toleratedIndex, darwinTolerable, baseRefusal }`,
)() as {
  DARWIN_TOLERATED: KnownFailure[];
  toleratedIndex: (entry: string) => number;
  darwinTolerable: (failing: string[], reconfirmed: string[]) => boolean;
  baseRefusal: (base: string) => string;
};

const KNOWN = api.DARWIN_TOLERATED;
const ALL_NAMES = KNOWN.map((known) => known.test);
const DOCTOR = KNOWN.find((known) => known.file.endsWith('doctor.test.ts')) as KnownFailure;

describe('darwin tolerance is decided by test name, never by file', () => {
  test('the roster is six #2926 failures, each a file plus one exact test name', () => {
    expect(KNOWN).toHaveLength(6);
    for (const known of KNOWN) {
      expect(known.file).toMatch(/\.test\.ts$/);
      expect(known.test.length).toBeGreaterThan(0);
      // A file path in the `test` slot would re-introduce the file-level match.
      expect(known.test).not.toMatch(/\.test\.ts$/);
    }
    expect(new Set(ALL_NAMES).size).toBe(6);
  });

  test('a known test counts only when that same test was re-confirmed at the base', () => {
    expect(api.darwinTolerable(ALL_NAMES, ALL_NAMES)).toBe(true);
    expect(api.darwinTolerable(ALL_NAMES, [])).toBe(false);
    // Re-confirmed, but a different known test: the failing one still passed at the base.
    expect(api.darwinTolerable([ALL_NAMES[0] as string], [ALL_NAMES[1] as string])).toBe(false);
    expect(api.darwinTolerable([], ALL_NAMES)).toBe(false);
  });

  test('a NEW failure inside a known file is red, though that file always fails at the base', () => {
    const fresh = 'doctor: pre-record genie leftovers > warns with every leftover path and its kind';
    expect(api.toleratedIndex(fresh)).toBe(-1);
    expect(api.darwinTolerable([DOCTOR.test, fresh], [DOCTOR.test, `${DOCTOR.file} > ${fresh}`])).toBe(false);
  });

  test('a bare file path names no test and is tolerated by nothing', () => {
    for (const known of KNOWN) expect(api.toleratedIndex(known.file)).toBe(-1);
    expect(api.darwinTolerable([DOCTOR.file], [DOCTOR.file])).toBe(false);
  });

  test('the spellings a gate copies out of a runner log resolve to the same known test', () => {
    const index = KNOWN.indexOf(DOCTOR);
    expect(api.toleratedIndex(DOCTOR.test)).toBe(index);
    expect(api.toleratedIndex(`${DOCTOR.file} > ${DOCTOR.test}`)).toBe(index);
    expect(api.toleratedIndex(`${DOCTOR.file}: ${DOCTOR.test}`)).toBe(index);
    expect(api.toleratedIndex(`${DOCTOR.file} ${DOCTOR.test}`)).toBe(index);
    // Bun prints the duration after the name; it is not part of the identity.
    expect(api.toleratedIndex(`${DOCTOR.test} [11.06ms]`)).toBe(index);
    expect(api.toleratedIndex(`  ${DOCTOR.test}  `)).toBe(index);
    expect(api.toleratedIndex('')).toBe(-1);
  });

  test('the gate prompt and the schema ask for names, and say the file is not the unit', () => {
    expect(SCRIPT).toContain('never a bare file path');
    expect(SCRIPT).toContain('the file is not the unit, the test is');
    expect(SCRIPT).toContain('spelled exactly as in failingTests');
  });
});

describe('the base a run opens its PR against is refused before any agent runs', () => {
  test('an ordinary integration branch is accepted', () => {
    for (const base of ['dev', 'integration', 'release-5.2', 'team_a/next', 'wish/some-slug', 'v5.x']) {
      expect([base, api.baseRefusal(base)]).toEqual([base, '']);
    }
  });

  test('main and master are refused in every spelling, not just the bare name', () => {
    for (const base of ['main', 'master', 'refs/heads/main', 'refs/heads/master', 'origin/main', 'upstream/master']) {
      expect([base, api.baseRefusal(base)]).toEqual([base, 'protected']);
    }
  });

  test('anything that is not a plain branch name is refused before it reaches a command', () => {
    for (const base of [
      'dev; touch /tmp/pwned',
      'dev && echo hi',
      'dev | tee x',
      '$(id)',
      '`id`',
      'dev x',
      '-x',
      '../etc/passwd',
      'a..b',
      'a//b',
      'dev.lock',
      'dev\nmain',
      '',
    ]) {
      expect([base, api.baseRefusal(base)]).toEqual([base, 'shape']);
    }
  });

  test('each refusal reaches the caller with its own wording', () => {
    expect(SCRIPT).toMatch(/refusal === 'shape' \? BASE_SHAPE_ERROR : refusal === 'protected' \? BASE_ERROR : ''/);
    expect(SCRIPT).toContain('never main or master in ANY spelling');
    expect(SCRIPT).toContain('base must be a plain branch name');
  });
});
