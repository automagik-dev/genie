import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Three script-side decisions of `.claude/workflows/wish.js` are tested here: the darwin tolerance
// (issue #2926), the base refusal, and what `normalizeInput` makes of the caller's args — including
// the per-stage model keys, where an unset key must keep inheriting. No module can import them — the
// runtime executes the script — so, as `scripts/workflows-model-policy.test.ts` already does with
// workfly's clamp, each declaration is lifted out of the shipped source and evaluated here. The
// behaviour under test is therefore the text that ships, never a copy of it.

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
  // `normalizeGate` is the decision itself: it is what turns a gate's answer into `pass`.
  lift(/^const list = .*$/m),
  lift(/^const objectOf = .*$/m),
  lift(/^const intOf = .*$/m),
  lift(/^const texts = .*$/m),
  lift(/^const measuredCount = .*$/m),
  lift(/^function normalizeGate\(raw\) \{[\s\S]*?^\}$/m),
].join('\n');

interface KnownFailure {
  file: string;
  test: string;
}

const api = new Function(
  `${DECLARATIONS}\nreturn { DARWIN_TOLERATED, toleratedIndex, darwinTolerable, baseRefusal, normalizeGate }`,
)() as {
  DARWIN_TOLERATED: KnownFailure[];
  toleratedIndex: (entry: string) => number;
  darwinTolerable: (failing: string[], reconfirmed: string[], failCount: number) => boolean;
  baseRefusal: (base: string) => string;
  normalizeGate: (raw: unknown) => { pass: boolean; darwinTolerated: boolean; failCount: number };
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

  /**
   * The count is matched against DISTINCT identities. A list that repeats one known test — in the
   * same spelling or another one — would otherwise pad itself until it equalled a larger count,
   * letting the failure that count refers to ride along unnamed.
   */
  test('a repeated known test cannot pad the list up to a larger count', () => {
    const padded = [...ALL_NAMES, ALL_NAMES[0] as string];
    expect(tolerable(padded, ALL_NAMES, padded.length)).toBe(false);
    const otherSpelling = `(fail) ${DOCTOR.file} > ${DOCTOR.test} [2ms]`;
    expect(tolerable([...ALL_NAMES, otherSpelling], ALL_NAMES, ALL_NAMES.length + 1)).toBe(false);
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

  test('the gate prompt bounds the check twice: inside the command and on the tool call itself', () => {
    // Run wf_7b62c69f-433 (2026-09-18): the gate ran the documented command but left the shell tool's
    // own timeout at its 120 s default, the harness moved the six-minute check to the background, and
    // the gate spent 51 calls polling the log (5-9 in every other run). The in-command `timeout 1500`
    // cannot prevent that; the tool-call timeout has to be asked for by name.
    expect(SCRIPT).toContain('in the FOREGROUND under a bounded timeout');
    expect(SCRIPT).toContain("also set the shell tool's OWN timeout parameter to its maximum");
    expect(SCRIPT).toContain('never as a background task, never through a monitor, wait or sleep loop');
  });
});

describe('the gate answer becomes a pass only where the script allows it', () => {
  const answer = (over: Record<string, unknown> = {}) => ({
    hooksLive: true,
    exitCode: 1,
    failCount: ALL_NAMES.length,
    failingTests: ALL_NAMES,
    baseReconfirmed: ALL_NAMES,
    problems: ['six known darwin failures'],
    summaryLine: '2614 pass, 6 fail',
    pass: true,
    darwinTolerated: true,
    ...over,
  });

  test('the six known failures pass only while the gate itself claims the tolerance', () => {
    expect(api.normalizeGate(answer()).pass).toBe(true);
    // The gate did not claim it: the script never tolerates on its own initiative.
    expect(api.normalizeGate(answer({ darwinTolerated: false })).pass).toBe(false);
    expect(api.normalizeGate(answer({ darwinTolerated: undefined })).pass).toBe(false);
    expect(api.normalizeGate(answer({ darwinTolerated: false })).darwinTolerated).toBe(false);
  });

  test('a seventh failure, or one never re-confirmed at the base, is red', () => {
    const seventh = [...ALL_NAMES, 'some other suite > a new failure'];
    expect(api.normalizeGate(answer({ failingTests: seventh, failCount: seventh.length })).pass).toBe(false);
    expect(api.normalizeGate(answer({ baseReconfirmed: [] })).pass).toBe(false);
  });

  test('a clean run passes on its own, and the gate can still call it red', () => {
    expect(
      api.normalizeGate(answer({ exitCode: 0, failCount: 0, failingTests: [], darwinTolerated: false })).pass,
    ).toBe(true);
    expect(
      api.normalizeGate(answer({ exitCode: 0, failCount: 0, failingTests: [], darwinTolerated: false, pass: false }))
        .pass,
    ).toBe(false);
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

// `normalizeInput` is the whole args contract: it decides what every later stage reads, and the
// per-stage model keys are resolved from what it returns. Lifted with its own helpers so a caller
// shape can be handed to the shipped function directly.
const INTAKE_DECLARATIONS = [
  lift(/^const DEFAULT_BASE = .*$/m),
  lift(/^const DEFAULT_REPAIR_BUDGET = .*$/m),
  lift(/^const MAX_REPAIR_BUDGET = .*$/m),
  lift(/^const SLUG_CAP = .*$/m),
  lift(/^const BASE_ERROR =\n {2}'.*'$/m),
  lift(/^const BASE_SHAPE_ERROR =\n {2}'.*'$/m),
  lift(/^const text = .*$/m),
  lift(/^const clampInt = [\s\S]*?: fallback$/m),
  lift(/^const BRANCH_NAME = .*$/m),
  lift(/^const PROTECTED_BASE = .*$/m),
  lift(/^function baseRefusal\(base\) \{[\s\S]*?^\}$/m),
  lift(/^function slugify\(value\) \{[\s\S]*?^\}$/m),
  lift(/^function normalizeInput\(raw\) \{[\s\S]*?^\}$/m),
].join('\n');

interface Job {
  objective: string;
  model: string;
  gateModel: string;
  publishModel: string;
  repairBudget: number;
}

const normalizeInput = new Function(`${INTAKE_DECLARATIONS}\nreturn normalizeInput`)() as (raw: unknown) => Job | null;

/** The stage models the script resolves from a normalized job, spelled exactly as wish.js does. */
const stageModels = (job: Job): { session: string; gate: string; publish: string } => ({
  session: job.model,
  gate: job.gateModel || job.model,
  publish: job.publishModel || job.model,
});

describe('per-stage models resolve from the caller args, and an unset key inherits', () => {
  test('no model key at all leaves every stage inheriting the session model', () => {
    const job = normalizeInput({ objective: 'do one thing' });
    if (!job) throw new Error('normalizeInput refused a valid objective');
    expect(job.model).toBe('');
    expect(job.gateModel).toBe('');
    expect(job.publishModel).toBe('');
    // Empty at every stage is what makes the conditional spread drop out, which is how an
    // unpinned run inherits the session model — the behaviour that must not change.
    expect(stageModels(job)).toEqual({ session: '', gate: '', publish: '' });
  });

  test('model alone still pins all three stages, so an existing caller sees no change', () => {
    const job = normalizeInput({ objective: 'do one thing', model: 'opus' });
    if (!job) throw new Error('normalizeInput refused a valid objective');
    expect(stageModels(job)).toEqual({ session: 'opus', gate: 'opus', publish: 'opus' });
  });

  test('gateModel and publishModel override only their own stages', () => {
    const job = normalizeInput({
      objective: 'do one thing',
      model: 'opus',
      gateModel: 'haiku',
      publishModel: 'sonnet',
    });
    if (!job) throw new Error('normalizeInput refused a valid objective');
    expect(stageModels(job)).toEqual({ session: 'opus', gate: 'haiku', publish: 'sonnet' });
  });

  test('one stage key without model pins that stage and leaves the rest inheriting', () => {
    const job = normalizeInput({ objective: 'do one thing', gateModel: 'haiku' });
    if (!job) throw new Error('normalizeInput refused a valid objective');
    expect(stageModels(job)).toEqual({ session: '', gate: 'haiku', publish: '' });
  });

  test('a whitespace or non-string stage key normalizes to unset rather than to a pinned blank', () => {
    const job = normalizeInput({ objective: 'do one thing', model: 'opus', gateModel: '   ', publishModel: 7 });
    if (!job) throw new Error('normalizeInput refused a valid objective');
    expect(job.gateModel).toBe('');
    expect(job.publishModel).toBe('');
    expect(stageModels(job)).toEqual({ session: 'opus', gate: 'opus', publish: 'opus' });
  });

  test('the stage keys change nothing else about intake', () => {
    const plain = normalizeInput({ objective: 'do one thing', repairBudget: 3 });
    const staged = normalizeInput({ objective: 'do one thing', repairBudget: 3, gateModel: 'haiku' });
    if (!plain || !staged) throw new Error('normalizeInput refused a valid objective');
    expect({ ...staged, gateModel: '' }).toEqual(plain);
  });
});
