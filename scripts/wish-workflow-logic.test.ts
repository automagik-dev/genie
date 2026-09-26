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
  // The Admit-side refusal of a validation command that would reach the remote or publish.
  lift(/^const UNSAFE_VALIDATION = \[[\s\S]*?^\]$/m),
  lift(/^function validationRefusal\(command\) \{[\s\S]*?^\}$/m),
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
  `${DECLARATIONS}\nreturn { DARWIN_TOLERATED, toleratedIndex, darwinTolerable, baseRefusal, validationRefusal, normalizeGate }`,
)() as {
  DARWIN_TOLERATED: KnownFailure[];
  toleratedIndex: (entry: string) => number;
  darwinTolerable: (failing: string[], reconfirmed: string[], failCount: number) => boolean;
  baseRefusal: (base: string) => string;
  validationRefusal: (command: string) => string;
  normalizeGate: (raw: unknown) => {
    pass: boolean;
    darwinTolerated: boolean;
    failCount: number;
    noHookSystem: boolean;
    hookEvidence: string[];
  };
};

/** The gate reports as many failures as it names unless a test says otherwise. */
const tolerable = (failing: string[], reconfirmed: string[], failCount = failing.length): boolean =>
  api.darwinTolerable(failing, reconfirmed, failCount);

const KNOWN = api.DARWIN_TOLERATED;
const ALL_NAMES = KNOWN.map((known) => known.test);
const DOCTOR = KNOWN.find((known) => known.file.endsWith('doctor.test.ts')) as KnownFailure;

describe('darwin tolerance is decided by test name, never by file', () => {
  test('the roster is the five live #2926 failures, each a file plus one exact test name', () => {
    expect(KNOWN).toHaveLength(5);
    for (const known of KNOWN) {
      expect(known.file).toMatch(/\.test\.ts$/);
      expect(known.test.length).toBeGreaterThan(0);
      // A file path in the `test` slot would re-introduce the file-level match.
      expect(known.test).not.toMatch(/\.test\.ts$/);
    }
    expect(new Set(ALL_NAMES).size).toBe(5);
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
    problems: ['five known darwin failures'],
    summaryLine: '2614 pass, 6 fail',
    pass: true,
    darwinTolerated: true,
    ...over,
  });

  test('the five known failures pass only while the gate itself claims the tolerance', () => {
    expect(api.normalizeGate(answer()).pass).toBe(true);
    // The gate did not claim it: the script never tolerates on its own initiative.
    expect(api.normalizeGate(answer({ darwinTolerated: false })).pass).toBe(false);
    expect(api.normalizeGate(answer({ darwinTolerated: undefined })).pass).toBe(false);
    expect(api.normalizeGate(answer({ darwinTolerated: false })).darwinTolerated).toBe(false);
  });

  test('a sixth failure, or one never re-confirmed at the base, is red', () => {
    const sixth = [...ALL_NAMES, 'some other suite > a new failure'];
    expect(api.normalizeGate(answer({ failingTests: sixth, failCount: sixth.length })).pass).toBe(false);
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

describe('a gate in a repository with no hook system', () => {
  const noHooks = {
    hookSystem: 'none',
    hooksLive: false,
    exitCode: 0,
    failCount: 0,
    failingTests: [],
    problems: [],
    summaryLine: 'ok',
    pass: true,
    hookEvidence: ['git ls-files: nothing tracked'],
  };

  test('never tolerates the five darwin names: they are genie tests, meaningless elsewhere', () => {
    const gate = api.normalizeGate({
      ...noHooks,
      exitCode: 1,
      failCount: ALL_NAMES.length,
      failingTests: ALL_NAMES,
      baseReconfirmed: ALL_NAMES,
      darwinTolerated: true,
    });
    expect({ pass: gate.pass, darwinTolerated: gate.darwinTolerated }).toEqual({ pass: false, darwinTolerated: false });
  });

  test('passes on exit 0 of the validation command and is red on a non-zero exit', () => {
    const green = api.normalizeGate(noHooks);
    expect({ pass: green.pass, noHookSystem: green.noHookSystem }).toEqual({ pass: true, noHookSystem: true });
    expect(green.hookEvidence).toEqual(['git ls-files: nothing tracked']);
    expect(api.normalizeGate({ ...noHooks, exitCode: 2, failCount: 1 }).pass).toBe(false);
  });

  test('only the exact value none opens the no-hook path: absent, husky, other or unknown do not', () => {
    for (const hookSystem of [undefined, 'husky', 'other', 'None', 'no']) {
      expect([hookSystem, api.normalizeGate({ ...noHooks, hookSystem }).noHookSystem]).toEqual([hookSystem, false]);
    }
  });

  test('a bare none with no hook evidence is a hook system, never the no-hook path', () => {
    for (const hookEvidence of [[], undefined, ['', '  ']]) {
      const gate = api.normalizeGate({ ...noHooks, hookEvidence });
      expect([hookEvidence, gate.noHookSystem]).toEqual([hookEvidence, false]);
    }
  });
});

describe('a validation command that would reach the remote is refused at admission', () => {
  test('each rule names what it caught, in every spelling the gate could be handed', () => {
    const refused: Array<[string, string]> = [
      ['git push origin HEAD:refs/heads/main', 'a git push'],
      ['git -C /tmp/elsewhere push', 'a git push'],
      ['bun test && git push --force', 'a git push'],
      ['gh pr merge 12 --merge', 'a gh verb that changes the remote'],
      ['gh -R owner/repo pr create --fill', 'a gh verb that changes the remote'],
      ['bun test | gh api repos/o/r/merges -f base=main', 'a gh verb that changes the remote'],
      ['gh release create v1', 'a gh verb that changes the remote'],
      ['npm publish', 'a package publish'],
      ['bun run build && bun publish --tag next', 'a package publish'],
      // A verb followed directly by a separator, a paren or a quote is still the verb.
      ['git push;', 'a git push'],
      ['git push&&true', 'a git push'],
      ['bun test $(git push)', 'a git push'],
      ["bash -c 'git push'", 'a git push'],
      ['git "push" origin', 'a git push'],
      ['bun test `git push`', 'a git push'],
      ['npm publish;', 'a package publish'],
      ['gh release create v1;', 'a gh verb that changes the remote'],
    ];
    for (const [command, rule] of refused) expect([command, api.validationRefusal(command)]).toEqual([command, rule]);
  });

  test('ordinary validation commands, including files named after the verbs, are not refused', () => {
    for (const command of [
      'bun test src/lib/fixture.test.ts --bail',
      'bun test publish.test.ts',
      'npm test -- push.spec.js',
      'git diff --check',
      'make check',
      'pytest tests/test_publish.py',
      'cargo test --package gh-push',
      '',
    ]) {
      expect([command, api.validationRefusal(command)]).toEqual([command, '']);
    }
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

// ─── Changed-path evidence: the run's own worktree is still the repository ───

const PATH_DECLARATIONS = [
  lift(/^const text = .*$/m),
  lift(/^const list = .*$/m),
  lift(/^const texts = .*$/m),
  lift(/^function repoRelative\(value\) \{[\s\S]*?^\}$/m),
  lift(/^function partitionRepoRelative\(values, root = ''\) \{[\s\S]*?^\}$/m),
].join('\n');

const partitionRepoRelative = new Function(`${PATH_DECLARATIONS}\nreturn partitionRepoRelative`)() as (
  values: unknown,
  root?: string,
) => { inside: string[]; outside: string[] };

describe('a path under the run worktree is inside the repository, however it is spelled', () => {
  const WORKTREE = '/home/op/repo/.claude/worktrees/wish-one-thing';

  // Run wf_dfee11f7-177 (2026-09-18): gate green, 4 declared files, and the reviewer returned
  // `diffFiles` as absolute worktree paths — every one became "path outside the repository" and
  // the run ended BLOCKED with nothing wrong in the commit.
  test('an absolute path under the worktree normalises to its repository-relative form', () => {
    const paths = partitionRepoRelative([`${WORKTREE}/scripts/a.ts`, 'scripts/b.ts', `${WORKTREE}/./c.ts`], WORKTREE);
    expect(paths).toEqual({ inside: ['scripts/a.ts', 'scripts/b.ts', 'c.ts'], outside: [] });
  });

  test('a trailing slash on the worktree changes nothing', () => {
    expect(partitionRepoRelative([`${WORKTREE}/a.ts`], `${WORKTREE}/`).inside).toEqual(['a.ts']);
  });

  test('every other absolute path is still a reject, and the reject keeps the spelling it arrived in', () => {
    const rejects = [
      '/etc/passwd',
      '~/.ssh/id_ed25519',
      `${WORKTREE}/../wish-other/a.ts`,
      `${WORKTREE}-sibling/a.ts`,
      WORKTREE,
    ];
    const paths = partitionRepoRelative(rejects, WORKTREE);
    expect(paths.inside).toEqual([]);
    expect(paths.outside).toEqual(rejects.map((raw) => `path outside the repository: ${raw}`));
  });

  test('no worktree, or a worktree that is not absolute, strips nothing', () => {
    expect(partitionRepoRelative([`${WORKTREE}/a.ts`]).inside).toEqual([]);
    expect(partitionRepoRelative(['repo/a.ts'], 'repo').inside).toEqual(['repo/a.ts']);
    expect(partitionRepoRelative(['/a.ts'], '/').inside).toEqual([]);
  });
});
