import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { z } from 'zod';
import type { Citation, RunOptions, RunResult } from './call';
import { AGENT_NAMES, type IssueTriage, SCHEMAS, type WishContext } from './schemas';
import {
  type AgentRunner,
  type SizeBands,
  TriageRecord,
  type TriageRecordValue,
  denylistHits,
  deriveWrs,
  extractBands,
  extractDenylist,
  loadWishPolicy,
  parseIssueRef,
  sizeBand,
  triage,
} from './triage';

const ROOT = join(import.meta.dir, '..', '..');
const WISH_JS = join(ROOT, '.claude', 'workflows', 'wish.js');
const SCRIPT = readFileSync(WISH_JS, 'utf8');
const SOURCE = readFileSync(join(import.meta.dir, 'triage.ts'), 'utf8');

// ─── wish.js, lifted ─────────────────────────────────────
// No module can import `.claude/workflows/wish.js` — the harness executes it — so the parity tests
// evaluate the shipped declarations here, exactly as `scripts/wish-workflow-logic.test.ts` does.

function lift(pattern: RegExp): string {
  const match = pattern.exec(SCRIPT);
  if (!match) throw new Error(`wish.js: nothing matched ${pattern}`);
  return match[0];
}

const api = new Function(
  `${[
    lift(/^const DENYLIST = \[[\s\S]*?^\]$/m),
    lift(/^const escapeRule = .*$/m),
    lift(/^function repoRelative\(value\) \{[\s\S]*?^\}$/m),
    lift(/^function denylistRule\(candidate\) \{[\s\S]*?^\}$/m),
    lift(/^const denylistHits = [\s\S]*?Boolean\(hit\.rule\)\)$/m),
    lift(/^const intOf = .*$/m),
    lift(/^const MAX_FILES = .*$/m),
    lift(/^const MAX_INSERTIONS = .*$/m),
    lift(/^const MAX_UNITS = .*$/m),
    lift(/^const IDEAL_FILES = .*$/m),
    lift(/^const IDEAL_INSERTIONS = .*$/m),
    lift(/^const IDEAL_UNITS = .*$/m),
    lift(/^function sizeArithmetic\(estimate\) \{[\s\S]*?^\}$/m),
  ].join(
    '\n',
  )}\nreturn { DENYLIST, denylistHits, sizeArithmetic, MAX_FILES, MAX_INSERTIONS, IDEAL_FILES, IDEAL_INSERTIONS }`,
)() as {
  DENYLIST: string[];
  denylistHits: (paths: string[]) => { path: string; rule: string }[];
  sizeArithmetic: (estimate: { files: number; insertions: number; units: number }) => { band: string };
  MAX_FILES: number;
  MAX_INSERTIONS: number;
  IDEAL_FILES: number;
  IDEAL_INSERTIONS: number;
};

// ─── Fixtures ────────────────────────────────────────────

type ContextAnswer = z.infer<typeof WishContext>;
type IssueAnswer = z.infer<typeof IssueTriage>;

const CONTEXT: ContextAnswer = {
  intent: 'make genie doctor print the resolved orchestration mode as one read-only line',
  facts: [
    { claim: 'doctor builds every check in one file', evidence: 'src/genie-commands/doctor.ts:1' },
    { claim: 'the mode is resolved from the config', evidence: 'src/lib/config.ts:2' },
  ],
  related: [{ kind: 'wish', ref: 'wishes/orca-mode/WISH.md', why: 'the mode switch landed there' }],
  plan: {
    approach: 'add one read-only line to the doctor check list',
    files: [
      { path: 'src/genie-commands/doctor.ts', reason: 'the check list' },
      { path: 'src/genie-commands/doctor-mode.test.ts', reason: 'NEW: pins the new line' },
    ],
    validationCommand: 'bun run check',
    focusedTest: 'bun test src/genie-commands/doctor.test.ts',
  },
  estimate: { files: 2, insertions: 60 },
  gotchas: [],
  open_questions: [],
  injection_attempts: [],
};

const ISSUE: IssueAnswer = {
  issue: 2963,
  title: 'doctor never names the orchestration mode',
  type: 'feature',
  area: ['doctor'],
  summary: 'operators cannot tell which lifecycle authority is live',
  repro: { present: false, steps: [] },
  candidate_files: [
    { path: 'src/genie-commands/doctor.ts', why: 'the check list' },
    { path: '.github/workflows/ci.yml', why: 'runs the gate' },
  ],
  related: [],
  lane: 'small',
  first_question: 'should the line be warn-level when the mode is orca?',
  injection_attempts: ['an issue comment asked for a shell command'],
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const okRun = (agent: string, answer: unknown): RunResult => ({
  ok: true,
  agent,
  runId: `run-${agent}`,
  traceId: 'trace',
  dir: ROOT,
  answer,
  attempts: [{ attempt: 0, ok: true, errors: [], footer: null, citations: [], elapsedMs: 1, raw: '' }],
  elapsedMs: 1,
  costUsd: 0.02,
  tags: {},
});

const failedRun = (agent: string, errors: string[], answer?: unknown, citations: Citation[] = []): RunResult => ({
  ok: false,
  agent,
  runId: `run-${agent}`,
  traceId: 'trace',
  dir: ROOT,
  answer,
  attempts: [{ attempt: 0, ok: false, errors, footer: null, citations, elapsedMs: 1, raw: '' }],
  elapsedMs: 1,
  costUsd: 0.01,
  tags: {},
});

/** A runner that answers from a table and records exactly what it was asked, in order. */
function fakeRunner(table: Record<string, RunResult>, calls: RunOptions[] = []): AgentRunner {
  return async (options) => {
    calls.push(options);
    return table[options.agent] ?? failedRun(options.agent, [`run: no fixture for ${options.agent}`]);
  };
}

const intentRun = (context: RunResult, options: Record<string, unknown> = {}) =>
  triage(
    { intent: CONTEXT.intent, dir: ROOT, write: false, phoenix: false, ...options },
    fakeRunner({ 'wish-context': context }),
  );

// ─── The denylist is read from wish.js, or it is unknown ──

describe('boundary hits come from wish.js and fail closed', () => {
  test('extraction returns exactly the entries the shipped file declares', () => {
    const extracted = extractDenylist(SCRIPT);
    expect(extracted.length).toBeGreaterThan(0);
    expect(extracted).toEqual(api.DENYLIST);
  });

  test('the matcher agrees with wish.js denylistHits over a table of paths', () => {
    const paths = [
      '.github/workflows/ci.yml',
      '.github',
      '.husky/pre-commit',
      '.claude/hooks/session-start.ts',
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/workflows/wish.js',
      'biome.json',
      'nested/biome.json',
      'commitlint.config.ts',
      'scripts/release-guard.sh',
      'scripts/release-docs.test.ts',
      'release-guard.sh',
      'version.yml',
      '.github/workflows/version.yml',
      'src/lib/delivery-evidence-verify.ts',
      'package.json',
      'plugins/dsh-genie-board/package.json',
      'src/genie.ts',
      './src/genie.ts',
      'src/genie-commands/doctor.ts',
      '/etc/passwd',
      '../outside.ts',
      '~/secrets.ts',
      '',
    ];
    const mine = denylistHits(paths, extractDenylist(SCRIPT)).map((h) => `${h.path}→${h.entry}`);
    const theirs = api.denylistHits(paths).map((h) => `${h.path}→${h.rule}`);
    expect(mine).toEqual(theirs);
    expect(mine.length).toBeGreaterThan(5);
  });

  test('prose entries are reported as unmatchable, never silently skipped', async () => {
    const record = await intentRun(okRun('wish-context', CONTEXT));
    expect(record.boundaryHits.status).toBe('computed');
    if (record.boundaryHits.status !== 'computed') throw new Error('unreachable');
    expect(record.boundaryHits.unmatchable).toContain('auth, secret and permission surfaces');
    expect(record.boundaryHits.unmatchable).not.toContain('package.json scripts');
  });

  for (const [name, body] of [
    ['missing', null],
    ['empty', 'const DENYLIST = [\n]\n'],
    ['garbled', 'const DENYLIST = "not an array"\n'],
  ] as [string, string | null][]) {
    test(`a ${name} denylist is unknown, never a clean zero`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'triage-policy-'));
      if (body !== null) {
        mkdirSync(join(dir, '.claude', 'workflows'), { recursive: true });
        writeFileSync(join(dir, '.claude', 'workflows', 'wish.js'), body);
      }
      const policy = loadWishPolicy(dir);
      expect(policy.denylist).toBeNull();
      expect(policy.denylistReason).toBeTruthy();
      const record = await intentRun(okRun('wish-context', CONTEXT), { dir });
      expect(record.boundaryHits.status).toBe('unknown');
      expect(record.wrs.dimensions.risks.met).toBe(false);
      expect(record.wrs.dimensions.risks.evidence).toStartWith('unknown: ');
    });
  }
});

// ─── The band is wish.js's arithmetic ────────────────────

describe('band', () => {
  const bands: SizeBands = extractBands(SCRIPT);

  test('the constants come from wish.js', () => {
    expect(bands).toEqual({
      maxFiles: api.MAX_FILES,
      maxInsertions: api.MAX_INSERTIONS,
      idealFiles: api.IDEAL_FILES,
      idealInsertions: api.IDEAL_INSERTIONS,
    });
  });

  test('agrees with sizeArithmetic on the files/insertions half', () => {
    const table = [
      [0, 0],
      [2, 60],
      [10, 800],
      [11, 800],
      [10, 801],
      [25, 2000],
      [26, 2000],
      [25, 2001],
      [400, 90000],
    ];
    for (const [files, insertions] of table)
      expect(sizeBand({ files, insertions }, bands)).toBe(api.sizeArithmetic({ files, insertions, units: 1 }).band);
  });

  test('the three bands reach the record', async () => {
    const cases: [number, number, string][] = [
      [2, 60, 'ideal'],
      [12, 900, 'above-ideal'],
      [30, 60, 'over-maximum'],
    ];
    for (const [files, insertions, band] of cases) {
      const answer = clone(CONTEXT);
      answer.estimate = { files, insertions };
      const record = await intentRun(okRun('wish-context', answer));
      expect(record.band).toBe(band as TriageRecordValue['band']);
      expect(record.estimate).toEqual({ files, insertions });
    }
  });

  test('a null estimate or an unreadable wish.js leaves the band null', () => {
    expect(sizeBand(null, bands)).toBeNull();
    expect(sizeBand({ files: 1, insertions: 1 }, null)).toBeNull();
  });
});

// ─── WRS: derived, evidenced, never totalled ─────────────

describe('WRS dimensions', () => {
  const base = {
    intent: 'a sentence',
    candidateFiles: [{ path: 'src/genie.ts', reason: 'the entry point', isNew: false }],
    band: 'ideal' as const,
    questions: [] as string[],
    boundaryHits: { status: 'computed' as const, hits: [], unmatchable: [] },
    context: CONTEXT,
    contextDegraded: undefined,
    anyDegraded: false,
  };

  test('every dimension is met with its evidence', () => {
    const wrs = deriveWrs(base);
    expect(wrs.calibration).toBe('pending');
    expect(wrs.actionable).toBe(false);
    expect(wrs.metCount).toBe(5);
    expect(wrs.dimensions.problem.evidence).toBe('10 characters of intent');
    expect(wrs.dimensions.scope.evidence).toBe('1 candidate file(s), band ideal');
    expect(wrs.dimensions.decisions.evidence).toBe('0 open question(s)');
    expect(wrs.dimensions.risks.evidence).toBe('0 boundary hit(s) over 1 candidate file(s)');
    expect(wrs.dimensions.criteria.evidence).toBe(
      'pinning test / validation command: bun test src/genie-commands/doctor.test.ts',
    );
    expect(wrs).not.toHaveProperty('score');
    expect(wrs).not.toHaveProperty('total');
    expect(wrs).not.toHaveProperty('threshold');
  });

  test('problem is unmet on an empty intent', () => {
    const wrs = deriveWrs({ ...base, intent: '   ' });
    expect(wrs.dimensions.problem).toEqual({ met: false, evidence: 'the intent sentence is empty' });
    expect(wrs.metCount).toBe(4);
  });

  test('scope is unmet over the maximum band', () => {
    const wrs = deriveWrs({ ...base, band: 'over-maximum' });
    expect(wrs.dimensions.scope).toEqual({ met: false, evidence: '1 candidate file(s), band over-maximum' });
  });

  test('scope is unmet with no candidate file', () => {
    const wrs = deriveWrs({ ...base, candidateFiles: [] });
    expect(wrs.dimensions.scope.met).toBe(false);
    expect(wrs.dimensions.scope.evidence).toBe('0 candidate file(s), band ideal');
  });

  test('risks is unmet on a boundary hit and names it', () => {
    const wrs = deriveWrs({
      ...base,
      boundaryHits: {
        status: 'computed',
        hits: [{ path: '.github/workflows/ci.yml', entry: '.github/' }],
        unmatchable: [],
      },
    });
    expect(wrs.dimensions.risks).toEqual({
      met: false,
      evidence: '1 boundary hit(s): .github/workflows/ci.yml → .github/',
    });
  });

  test('criteria is unmet when the only command is the full gate', () => {
    const answer = clone(CONTEXT);
    answer.plan.focusedTest = 'bun run check';
    answer.plan.validationCommand = 'Bun   Run   Check';
    const wrs = deriveWrs({ ...base, context: answer });
    expect(wrs.dimensions.criteria).toEqual({
      met: false,
      evidence: 'no pinning test or validation command narrower than `bun run check`',
    });
  });

  test('decisions counts the UNTRUNCATED question set', async () => {
    const answer = clone(CONTEXT);
    answer.open_questions = Array.from({ length: 7 }, (_, i) => `open question ${i + 1}?`);
    const record = await intentRun(okRun('wish-context', answer));
    expect(record.questions).toHaveLength(7);
    expect(record.questions[6]).toBe('open question 7?');
    expect(record.wrs.dimensions.decisions).toEqual({ met: false, evidence: '7 open question(s)' });
    expect(record.wrs.metCount).toBe(4);
  });
});

// ─── The two entry shapes ────────────────────────────────

describe('entry shapes', () => {
  test('the issue path runs issue-triage FIRST and builds the sentence from title + summary', async () => {
    const calls: RunOptions[] = [];
    const record = await triage(
      { issue: 2963, dir: ROOT, write: false, phoenix: false },
      fakeRunner(
        { 'issue-triage': okRun('issue-triage', ISSUE), 'wish-context': okRun('wish-context', CONTEXT) },
        calls,
      ),
    );
    expect(calls.map((c) => c.agent)).toEqual(['issue-triage', 'wish-context']);
    expect(calls[0].prompt).toBe('Triage issue #2963');
    expect(calls[1].prompt).toBe(`Intent: ${ISSUE.title} — ${ISSUE.summary}`);
    expect(calls[1].facts).toBe('auto');
    expect(calls[0].facts).toBeUndefined();
    expect(calls[0].traceId).toBe(calls[1].traceId);
    expect(record.intent).toBe(`issue #2963: ${ISSUE.title} — ${ISSUE.summary}`);
    expect(record.lane).toEqual({ value: 'small', source: 'issue-triage' });
    expect(record.runIds).toEqual({ issueTriage: 'run-issue-triage', wishContext: 'run-wish-context' });
    expect(record.costUsd).toBeCloseTo(0.04, 6);
    // Candidate files are the union: wish-context's plan first, then what only the issue named.
    expect(record.candidateFiles.map((f) => f.path)).toEqual([
      'src/genie-commands/doctor.ts',
      'src/genie-commands/doctor-mode.test.ts',
      '.github/workflows/ci.yml',
    ]);
    expect(record.candidateFiles[1].isNew).toBe(true);
    expect(record.candidateFiles[0].isNew).toBe(false);
    expect(record.injectionAttempts).toEqual(ISSUE.injection_attempts);
    // The issue's own first_question joins the untruncated set.
    expect(record.questions).toEqual([ISSUE.first_question as string]);
    if (record.boundaryHits.status !== 'computed') throw new Error('boundary hits should be computed');
    expect(record.boundaryHits.hits).toEqual([{ path: '.github/workflows/ci.yml', entry: '.github/' }]);
    expect(record.wrs.dimensions.risks.met).toBe(false);
  });

  test('the intent path runs wish-context alone and records no lane', async () => {
    const calls: RunOptions[] = [];
    const record = await triage(
      { intent: CONTEXT.intent, dir: ROOT, write: false, phoenix: false },
      fakeRunner({ 'wish-context': okRun('wish-context', CONTEXT) }, calls),
    );
    expect(calls.map((c) => c.agent)).toEqual(['wish-context']);
    expect(calls[0].prompt).toBe(`Intent: ${CONTEXT.intent}`);
    expect(record.intent).toBe(CONTEXT.intent);
    expect(record.lane).toEqual({ value: null, source: 'none' });
    expect(record.status).toBe('ok');
    expect(record.degraded).toEqual([]);
    expect(record.facts).toEqual(CONTEXT.facts);
    expect(record.related).toEqual(CONTEXT.related);
    expect(record.version).toBe(1);
    expect(record.provisional).toBe(true);
  });

  test('--issue accepts a number, a #number and an issue URL', () => {
    expect(parseIssueRef('2963')).toBe(2963);
    expect(parseIssueRef(' #2963 ')).toBe(2963);
    expect(parseIssueRef('https://github.com/automagik-dev/genie/issues/2963')).toBe(2963);
    expect(parseIssueRef('https://github.com/automagik-dev/genie/issues/2963#issuecomment-1')).toBe(2963);
    expect(parseIssueRef('not-an-issue')).toBeNull();
    expect(parseIssueRef('0')).toBeNull();
  });

  test('nothing to triage is a usage error, not an empty record', () => {
    expect(triage({ dir: ROOT, write: false }, fakeRunner({}))).rejects.toThrow(/nothing to triage/);
  });
});

// ─── D5: triage derives no lane ──────────────────────────

describe('D5 — lanes are judged, never computed here', () => {
  test('no estimate, band or file count moves the lane', async () => {
    for (const estimate of [
      { files: 1, insertions: 5 },
      { files: 12, insertions: 900 },
      { files: 400, insertions: 90000 },
    ]) {
      const answer = clone(CONTEXT);
      answer.estimate = estimate;
      const record = await intentRun(okRun('wish-context', answer));
      expect(record.lane).toEqual({ value: null, source: 'none' });
    }
  });

  test('the shipped source names no lane at all', () => {
    for (const lane of ['incident', 'patch', 'small', 'standard', 'program', 'spike', 'freestyle'])
      expect(SOURCE).not.toContain(`'${lane}'`);
    expect(SOURCE).not.toContain('LANES');
  });

  test('the record is not a microagent of its own', () => {
    // The claim is about `triage`, never about the registry's size: `mikro-coach`
    // (#2958) is a registered microagent, so pinning the whole list here would
    // fail on a sibling's landing rather than on the thing this test guards.
    expect(Object.keys(SCHEMAS)).toEqual(expect.arrayContaining(['issue-triage', 'wish-context', 'review-prep']));
    expect(SCHEMAS).not.toHaveProperty('triage');
    expect(AGENT_NAMES).not.toContain('triage' as never);
  });
});

// ─── Degradation ─────────────────────────────────────────

describe('degraded records', () => {
  const cases: [string, string[], unknown][] = [
    ['timeout', ['run: tools/call timed out after 300000ms'], undefined],
    ['schema', ['schema: plan.files — Array must contain at least 1 element(s)'], undefined],
    ['empty', ['empty answer', 'no JSON object in the answer'], undefined],
    ['runner', ['run: mikro mcp exited with code 1 before answering'], undefined],
  ];

  for (const [cls, errors, answer] of cases) {
    test(`class ${cls} degrades the record and still exits with a record`, async () => {
      const record = await intentRun(failedRun('wish-context', errors, answer));
      expect(record.status).toBe('degraded');
      expect(record.degraded).toHaveLength(1);
      expect(record.degraded[0]).toMatchObject({ agent: 'wish-context', class: cls });
      expect(record.degraded[0].detail).toContain(errors[0]);
      expect(record.estimate).toBeNull();
      expect(record.band).toBeNull();
      // Never scored as if the agent had answered "none".
      for (const key of ['scope', 'decisions', 'criteria'] as const)
        expect(record.wrs.dimensions[key]).toEqual({ met: false, evidence: `unknown: ${cls}` });
      expect(record.wrs.dimensions.problem.met).toBe(true);
      expect(record.wrs.metCount).toBe(1);
      expect(TriageRecord.safeParse(record).success).toBe(true);
    });
  }

  test('an ok:false citation-gate answer keeps the facts whose own citation verified', async () => {
    const answer = clone(CONTEXT);
    answer.facts = [
      { claim: 'proven by a file that exists', evidence: 'src/genie-commands/doctor.ts:1' },
      { claim: 'proven by a file that does not', evidence: 'src/lib/ghost.ts:9' },
    ];
    answer.plan.files = [
      { path: 'src/genie-commands/doctor.ts', reason: 'the check list' },
      { path: 'src/lib/ghost.ts', reason: 'invented' },
    ];
    const citations: Citation[] = [
      { path: 'src/genie-commands/doctor.ts', line: 1, ok: true },
      { path: 'src/lib/ghost.ts', line: 9, ok: false, reason: 'no such file' },
      { path: 'src/lib/ghost.ts', line: null, ok: false, reason: 'no such file' },
    ];
    const record = await intentRun(
      failedRun('wish-context', ['citation: src/lib/ghost.ts:9 — no such file'], answer, citations),
    );
    expect(record.status).toBe('degraded');
    expect(record.degraded[0].class).toBe('citation-gate');
    expect(record.facts).toEqual([
      { claim: 'proven by a file that exists', evidence: 'src/genie-commands/doctor.ts:1' },
    ]);
    expect(record.candidateFiles.map((f) => f.path)).toEqual(['src/genie-commands/doctor.ts']);
    expect(record.wrs.dimensions.scope.evidence).toBe('unknown: citation-gate');
    expect(record.wrs.dimensions.risks.evidence).toStartWith('unknown: citation-gate');
  });

  test('an issue whose triage returned nothing never invents an intent sentence', async () => {
    const calls: RunOptions[] = [];
    const record = await triage(
      { issue: 2963, dir: ROOT, write: false, phoenix: false },
      fakeRunner({ 'issue-triage': failedRun('issue-triage', ['empty answer']) }, calls),
    );
    expect(calls.map((c) => c.agent)).toEqual(['issue-triage']);
    expect(record.intent).toBe('issue #2963');
    expect(record.lane).toEqual({ value: null, source: 'none' });
    expect(record.degraded.map((d) => d.agent)).toEqual(['issue-triage', 'wish-context']);
    expect(record.degraded[1].detail).toContain('not run');
    expect(record.status).toBe('degraded');
  });

  test('a runner that throws is a degraded record, not a stack trace', async () => {
    const record = await triage({ intent: CONTEXT.intent, dir: ROOT, write: false, phoenix: false }, async () => {
      throw new Error('mikro: command not found');
    });
    expect(record.status).toBe('degraded');
    expect(record.degraded[0]).toMatchObject({ agent: 'wish-context', class: 'runner' });
    expect(record.degraded[0].detail).toContain('mikro: command not found');
    expect(record.runIds).toEqual({});
  });
});

// ─── Write audit ─────────────────────────────────────────

describe('write audit', () => {
  const git = (cwd: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd }).stdout.toString();

  function repoFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'triage-audit-'));
    const put = (relative: string, body: string) => {
      mkdirSync(dirname(join(dir, relative)), { recursive: true });
      writeFileSync(join(dir, relative), body);
    };
    put('.gitignore', '.mikro/runs/\n');
    put('.claude/workflows/wish.js', SCRIPT);
    put('.genie/brainstorms/wish-v7/DRAFT.md', '# draft\n');
    put('.genie/wishes/wish-v7/WISH.md', '# wish\n');
    put('skills/wish/SKILL.md', '# skill\n');
    Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
    Bun.spawnSync(['git', 'add', '.'], { cwd: dir });
    Bun.spawnSync(
      ['git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-verify', '-m', 'fixture'],
      { cwd: dir },
    );
    return dir;
  }

  for (const [name, result] of [
    ['a successful run', okRun('wish-context', CONTEXT)],
    ['a failed run', failedRun('wish-context', ['run: mikro mcp exited with code 1 before answering'])],
  ] as [string, RunResult][]) {
    test(`${name} writes the record and nothing else`, async () => {
      const dir = repoFixture();
      const before = git(dir, 'status', '--porcelain');
      expect(before).toBe('');
      const record = await triage(
        { intent: CONTEXT.intent, dir, phoenix: false },
        fakeRunner({ 'wish-context': result }),
      );
      expect(git(dir, 'status', '--porcelain')).toBe('');
      expect(git(dir, 'status', '--porcelain', '--ignored')).toBe('!! .mikro/\n');
      for (const untouched of [
        '.claude/workflows/wish.js',
        '.genie/brainstorms/wish-v7/DRAFT.md',
        '.genie/wishes/wish-v7/WISH.md',
        'skills/wish/SKILL.md',
      ])
        expect(git(dir, 'diff', '--name-only', '--', untouched)).toBe('');
      expect(readFileSync(join(dir, '.claude', 'workflows', 'wish.js'), 'utf8')).toBe(SCRIPT);
      const written = readdirSync(join(dir, '.mikro', 'runs'));
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/^triage-\d{8}T\d{9}Z\.json$/);
      const onDisk = JSON.parse(readFileSync(join(dir, '.mikro', 'runs', written[0]), 'utf8'));
      expect(onDisk).toEqual(record);
      expect(TriageRecord.safeParse(onDisk).success).toBe(true);
      expect(existsSync(join(dir, 'DRAFT.md'))).toBe(false);
      expect(existsSync(join(dir, 'WISH.md'))).toBe(false);
    });
  }
});
