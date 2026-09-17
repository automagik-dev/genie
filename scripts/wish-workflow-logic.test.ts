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
  // `withoutTiming` is a chained arrow across several lines: anchored at its declaration and closed
  // on the `.trim()` that ends it, so a reformat throws rather than lifting half a helper.
  lift(/^const withoutTiming = [\s\S]*?\.trim\(\)$/m),
  lift(/^function toleratedIndex\(entry\) \{[\s\S]*?^\}$/m),
  lift(/^function darwinTolerable\([^)]*\) \{[\s\S]*?^\}$/m),
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
  darwinTolerable: (failing: string[], reconfirmed: string[], failCount: number) => boolean;
  baseRefusal: (base: string) => string;
};

/** The gate reports as many failures as it names unless a test says otherwise. */
const tolerable = (failing: string[], reconfirmed: string[], failCount = failing.length): boolean =>
  api.darwinTolerable(failing, reconfirmed, failCount);

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
    expect(tolerable(ALL_NAMES, ALL_NAMES)).toBe(true);
    expect(tolerable(ALL_NAMES, [])).toBe(false);
    // Re-confirmed, but a different known test: the failing one still passed at the base.
    expect(tolerable([ALL_NAMES[0] as string], [ALL_NAMES[1] as string])).toBe(false);
    expect(tolerable([], ALL_NAMES)).toBe(false);
  });

  test('a NEW failure inside a known file is red, though that file always fails at the base', () => {
    const fresh = 'doctor: pre-record genie leftovers > warns with every leftover path and its kind';
    expect(api.toleratedIndex(fresh)).toBe(-1);
    expect(tolerable([DOCTOR.test, fresh], [DOCTOR.test, `${DOCTOR.file} > ${fresh}`])).toBe(false);
  });

  /**
   * A name that CONTAINS a known name is still a different test. This is the fixture that fails if
   * the exact comparisons are ever loosened back to `includes`.
   */
  test('a test whose name merely contains a known name is not that test', () => {
    const superset = `${DOCTOR.test} under a second describe`;
    expect(api.toleratedIndex(superset)).toBe(-1);
    expect(tolerable([superset], [superset])).toBe(false);
    const substring = DOCTOR.test.slice(0, 20);
    expect(api.toleratedIndex(substring)).toBe(-1);
  });

  /**
   * The count the runner printed is the run's own. A gate that names only the failures it
   * recognises, while counting honestly, would otherwise have its short list tolerated — and the
   * unnamed failure tolerated with it.
   */
  test('a failure count larger than the enumerated names is never tolerable', () => {
    expect(tolerable(ALL_NAMES, ALL_NAMES, ALL_NAMES.length + 1)).toBe(false);
    expect(tolerable(ALL_NAMES, ALL_NAMES, 99)).toBe(false);
    expect(tolerable(ALL_NAMES, ALL_NAMES, ALL_NAMES.length)).toBe(true);
  });

  test('a bare file path names no test and is tolerated by nothing', () => {
    for (const known of KNOWN) expect(api.toleratedIndex(known.file)).toBe(-1);
    expect(tolerable([DOCTOR.file], [DOCTOR.file])).toBe(false);
  });

  test('the spellings a gate copies out of a runner log resolve to the same known test', () => {
    const index = KNOWN.indexOf(DOCTOR);
    expect(api.toleratedIndex(DOCTOR.test)).toBe(index);
    expect(api.toleratedIndex(`${DOCTOR.file} > ${DOCTOR.test}`)).toBe(index);
    expect(api.toleratedIndex(`${DOCTOR.file}: ${DOCTOR.test}`)).toBe(index);
    expect(api.toleratedIndex(`${DOCTOR.file} ${DOCTOR.test}`)).toBe(index);
    // The runner wraps the name in a result marker and a duration; neither is part of the identity,
    // and a gate told to report the failing test copies the line it printed.
    expect(api.toleratedIndex(`(fail) ${DOCTOR.test} [11.06ms]`)).toBe(index);
    expect(api.toleratedIndex(`(FAIL) ${DOCTOR.test}`)).toBe(index);
    expect(api.toleratedIndex(`${DOCTOR.test} [11.06ms]`)).toBe(index);
    expect(api.toleratedIndex(`${DOCTOR.test} [3s]`)).toBe(index);
    expect(api.toleratedIndex(`${DOCTOR.test} [11ms]`)).toBe(index);
    expect(api.toleratedIndex(`(fail) ${DOCTOR.file} > ${DOCTOR.test} [0.66ms]`)).toBe(index);
    expect(api.toleratedIndex(`  ${DOCTOR.test}  `)).toBe(index);
    expect(api.toleratedIndex('')).toBe(-1);
    // The whole set, exactly as a runner line carries it, is still tolerable.
    const asPrinted = ALL_NAMES.map((name) => `(fail) ${name} [1.23ms]`);
    expect(tolerable(asPrinted, asPrinted)).toBe(true);
  });

  test('the gate prompt and the schema ask for names, and say the file is not the unit', () => {
    expect(SCRIPT).toContain('a bare file path names no test');
    expect(SCRIPT).toContain('the file is not the unit, the test is');
    expect(SCRIPT).toContain('spelled exactly as in failingTests');
    // The schema must not ask for a spelling the matcher cannot read back.
    expect(SCRIPT).not.toContain('exactly as the runner printed it');
    expect(SCRIPT).toContain('make failCount equal that list');
  });
});

describe('the base a run opens its PR against is refused before any agent runs', () => {
  test('an ordinary integration branch is accepted', () => {
    for (const base of ['dev', 'integration', 'release-5.2', 'team_a/next', 'wish/some-slug', 'v5.x', '_priv']) {
      expect([base, api.baseRefusal(base)]).toEqual([base, '']);
    }
  });

  test('main and master are refused in every spelling, not just the bare name', () => {
    for (const base of [
      'main',
      'master',
      'refs/heads/main',
      'refs/heads/master',
      'origin/main',
      'upstream/master',
      // `origin/HEAD` resolves to the default branch, so a base of HEAD cuts from main.
      'HEAD',
      'origin/HEAD',
      // The error promises "any spelling", and these are valid branch names.
      'MAIN',
      'Master',
    ]) {
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

  test('the refusal returns before the first agent is dispatched', () => {
    const refusalReturn = SCRIPT.indexOf('if (job.rejection) return { ok: false, error: job.rejection');
    expect(refusalReturn).toBeGreaterThan(-1);
    // Everything that reaches an agent, a phase or the transcript happens after it.
    expect(refusalReturn).toBeLessThan(SCRIPT.indexOf('await attempt('));
    expect(refusalReturn).toBeLessThan(SCRIPT.indexOf("phase('Admit')"));
    expect(refusalReturn).toBeLessThan(SCRIPT.indexOf('log(`wish on:'));
  });
});

describe('a run that stopped early never reports a budget it did not spend', () => {
  test('the spent-budget wording is chosen by the rounds actually used', () => {
    expect(SCRIPT).toContain('repairs >= job.repairBudget');
    expect(SCRIPT).toMatch(/The repair budget \(\$\{job\.repairBudget\}\) is spent/);
    expect(SCRIPT).toMatch(/The repair loop ended after \$\{repairs\} of \$\{job\.repairBudget\} round\(s\)/);
  });
});
