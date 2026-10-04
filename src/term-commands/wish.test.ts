/**
 * `genie wish lint` as a user invokes it from a repository that is not genie.
 *
 * Every case spawns the CLI rather than calling the handler: the exit code, the
 * stream the findings land on, and the fact that the v4 workspace gate never
 * fires are the whole contract here. The last describe runs the BUILT bundle,
 * because the defect this verb exists to avoid — a wishes root resolved from
 * `import.meta.url`, which lands under `/$bunfs` in a compiled binary — cannot
 * be reproduced from source at all.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const ENTRY = join(ROOT, 'src', 'genie.ts');
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function wishDoc(status: string): string {
  return `# Wish: Fixture

| Field | Value |
|-------|-------|
| **Status** | ${status} |
| **Date** | 2026-07-08 |

## Dependencies

**depends-on:** none
**blocks:** none

## Execution Strategy

No table required.
`;
}

/**
 * A git repository that is NOT genie: no `.genie/workspace.json`, no genie
 * install record, nothing but the wishes a team would actually carry.
 */
function foreignRepo(wishes: Record<string, string>): string {
  const repo = tmp('genie-wish-lint-repo-');
  Bun.spawnSync(['git', '-C', repo, 'init', '-q', '-b', 'main']);
  for (const [slug, contents] of Object.entries(wishes)) {
    const dir = join(repo, '.genie', 'wishes', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'WISH.md'), contents);
  }
  return repo;
}

/** Every file under `dir` with its sha256 — the proof a lint wrote nothing. */
function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function runCli(argv: string[], options: { cwd?: string } = {}) {
  const proc = Bun.spawnSync([process.execPath, ENTRY, ...argv], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env },
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe('genie wish lint', () => {
  test('--help names the flag and says which rules stay repository-gate concerns', () => {
    const { code, stdout } = runCli(['wish', 'lint', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--dir <repo>');
    expect(stdout).toContain('design-review evidence');
    expect(stdout).toContain('cross-wish graph');
    expect(stdout).toContain('REPOSITORY-GATE');
    expect(stdout).toContain('writes nothing');
    // The exit-code promise the help makes is one the command actually keeps —
    // see the mistyped-root case below.
    expect(stdout).toContain('2 the root was refused');
  });

  test('a foreign repository carrying one valid and one malformed wish exits 1 and names the malformed file', () => {
    const repo = foreignRepo({
      good: wishDoc('DRAFT'),
      broken: wishDoc('SUPERSEDED IN PART'),
    });
    const { code, stderr } = runCli(['wish', 'lint', '--dir', repo]);
    expect(code).toBe(1);
    expect(stderr).toContain('.genie/wishes/broken/WISH.md');
    expect(stderr).toContain('unsupported wish status "SUPERSEDED IN PART"');
    // The valid sibling is scanned and reported on by silence, never named.
    expect(stderr).not.toContain('.genie/wishes/good/WISH.md');
  });

  test('a foreign repository whose wishes are all valid exits 0 and writes nothing', () => {
    const repo = foreignRepo({ good: wishDoc('DRAFT'), other: wishDoc('SHIPPED') });
    const before = treeDigest(repo);
    const { code, stderr, stdout } = runCli(['wish', 'lint', '--dir', repo]);
    expect(code).toBe(0);
    expect(stderr).toContain('wishes-lint: OK (2 files scanned');
    expect(stdout).toBe('');
    expect(treeDigest(repo)).toEqual(before);
  });

  /**
   * The gate this verb would otherwise trip. `installWorkspaceCheck` refuses with
   * exit 2 and "No workspace found" on any non-TTY stdout — which a spawned
   * process always is — so this case fails the moment `'wish'` leaves
   * `WORKSPACE_EXEMPT`. `src/lib/interactivity.test.ts` pins the set directly;
   * this pins what the operator would actually see.
   */
  test('a directory that is not a genie workspace neither prompts for init nor exits 2', () => {
    const repo = foreignRepo({ broken: wishDoc('SUPERSEDED IN PART') });
    expect(existsSync(join(repo, '.genie', 'workspace.json'))).toBe(false);
    const { code, stderr } = runCli(['wish', 'lint'], { cwd: repo });
    expect(code).toBe(1);
    expect(stderr).not.toContain('No workspace found');
    expect(stderr).toContain('unsupported wish status');
  });

  /**
   * `--dir` is a DECLARED Commander option here, so an unknown flag is Commander's
   * own error through genie's global handler — exit 1, the same path
   * `genie mikro call` with no agent takes. The runtime's `--wishes-dir` usage
   * refusal (exit 2) belongs to `bun scripts/wishes-lint.ts`, which is the surface
   * that still parses argv itself.
   */
  test('a bad flag is refused by the parser and lints nothing', () => {
    const repo = foreignRepo({ good: wishDoc('DRAFT') });
    const { code, stderr } = runCli(['wish', 'lint', '--nope'], { cwd: repo });
    expect(code).toBe(1);
    expect(stderr).toContain("unknown option '--nope'");
    expect(stderr).not.toContain('wishes-lint: OK');
  });

  /**
   * The failure a linter must never have: a mistyped root that walks nothing and
   * reports a clean bill of health. Each of these used to exit 0 with
   * `OK (0 files scanned)`, and the empty value used to lint the cwd instead.
   */
  test('a mistyped --dir is refused with exit 2 and never reads as clean', () => {
    const repo = foreignRepo({ good: wishDoc('DRAFT') });
    const bare = tmp('genie-wish-bare-'); // a real directory with no .genie/wishes
    writeFileSync(join(bare, 'a-file.md'), 'not a directory\n');

    for (const [dir, message] of [
      [join(repo, 'nope'), '--dir is not a directory'],
      [join(bare, 'a-file.md'), '--dir is not a directory'],
      [bare, '--dir names no .genie/wishes'],
      // `genie wish lint --dir "$REPO"` with REPO unset: Commander hands over the
      // empty string, and a truthiness gate used to drop the flag and lint the cwd.
      ['', '--dir needs a path'],
    ] as Array<[string, string]>) {
      const { code, stderr } = runCli(['wish', 'lint', '--dir', dir], { cwd: repo });
      expect({ dir, code }).toEqual({ dir, code: 2 });
      expect(stderr).toContain(message);
      expect(stderr).toContain('usage: wishes-lint');
      expect(stderr).not.toContain('files scanned');
    }
  });

  test('a repository with no wishes yet is a clean 0, not a refusal', () => {
    const repo = foreignRepo({});
    mkdirSync(join(repo, '.genie', 'wishes'), { recursive: true });
    const { code, stderr } = runCli(['wish', 'lint', '--dir', repo]);
    expect(code).toBe(0);
    expect(stderr).toContain('wishes-lint: OK (0 files scanned');
  });
});

/**
 * `genie wish report` against a trimmed copy of a real run record
 * (`src/fixtures/wish-run-record.json`, taken from wf_7b62c69f-433 with the
 * prompt and result previews dropped). CLAUDE_CONFIG_DIR and GENIE_HOME both
 * point into a tmpdir, so the record lookup and the ledger never touch the host.
 */
describe('genie wish report', () => {
  const FIXTURE = JSON.parse(readFileSync(join(ROOT, 'src', 'fixtures', 'wish-run-record.json'), 'utf8'));
  const SESSION = '71f24094-7ad7-494f-9d32-a5c026c34eb9';

  function host(records: Array<Record<string, unknown>>) {
    const root = tmp('genie-wish-report-');
    const workflows = join(root, 'claude', 'projects', '-some-repo', SESSION, 'workflows');
    mkdirSync(workflows, { recursive: true });
    for (const record of records) writeFileSync(join(workflows, `${record.runId}.json`), JSON.stringify(record));
    const env = { CLAUDE_CONFIG_DIR: join(root, 'claude'), GENIE_HOME: join(root, 'genie') };
    const run = (argv: string[]) => {
      const proc = Bun.spawnSync([process.execPath, ENTRY, 'wish', 'report', ...argv], {
        cwd: root,
        env: { ...process.env, ...env },
      });
      return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    };
    const ledger = join(env.GENIE_HOME, 'metrics', 'wish-runs.jsonl');
    const rows = () =>
      existsSync(ledger)
        ? readFileSync(ledger, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
    return { root, workflows, run, rows };
  }

  test('the totals and stage rows equal the record fields', () => {
    const { run } = host([FIXTURE]);
    const { code, stdout } = run([FIXTURE.runId]);
    expect(code).toBe(0);
    expect(stdout).toContain(`wish wf_7b62c69f-433 (session ${SESSION}, variant unlabeled)`);
    expect(stdout).toContain('total: 24.1 min, 535630 tokens, 117 tool calls, 6 agents, state merge-ready');
    const stages = FIXTURE.workflowProgress.filter((entry: { type: string }) => entry.type === 'workflow_agent');
    expect(stages).toHaveLength(6);
    for (const stage of stages) {
      const seconds = Math.round(stage.durationMs / 1000);
      expect(stdout).toContain(`${stage.label}\t${stage.model}\t${stage.tokens}\t${stage.toolCalls}\t${seconds}\n`);
    }
    expect(stdout).not.toContain('Admit\t'); // phase entries are not stages
  });

  test('--record reads a record by path', () => {
    const { run, workflows } = host([FIXTURE]);
    const { code, stdout } = run(['--record', join(workflows, `${FIXTURE.runId}.json`)]);
    expect(code).toBe(0);
    expect(stdout).toContain('state merge-ready');
  });

  test('an unknown runId exits 2 and writes no ledger', () => {
    const { run, rows } = host([FIXTURE]);
    const { code, stderr } = run(['wf_unknown', '--append']);
    expect(code).toBe(2);
    expect(stderr).toContain('no run record wf_unknown');
    expect(rows()).toEqual([]);
  });

  test('a record missing any required field exits 2 and appends nothing', () => {
    for (const field of ['workflowName', 'durationMs', 'totalTokens', 'agentCount', 'workflowProgress']) {
      const record = { ...FIXTURE, runId: `wf_missing-${field}` };
      delete (record as Record<string, unknown>)[field];
      const { run, rows } = host([record]);
      const { code, stderr } = run([record.runId, '--append']);
      expect({ field, code }).toEqual({ field, code: 2 });
      expect(stderr).toContain(`has no ${field}`);
      expect(rows()).toEqual([]);
    }
  });

  test('a record that is not JSON, or not an object, exits 2 with one line and writes nothing', () => {
    const { run, rows, workflows } = host([]);
    for (const [name, body, reason] of [
      ['wf_torn', '{"runId": "wf_torn",', 'is not valid JSON'],
      ['wf_list', '[1, 2]', 'is not a JSON object'],
    ]) {
      const path = join(workflows, `${name}.json`);
      writeFileSync(path, body as string);
      const { code, stdout, stderr } = run(['--record', path, '--append']);
      expect({ name, code }).toEqual({ name, code: 2 });
      expect(stderr).toBe(`wish report: ${path} ${reason}; refused\n`);
      expect(stdout).toBe('');
    }
    expect(rows()).toEqual([]);
  });

  test('a non-array workflowProgress exits 2 and writes nothing', () => {
    const record = { ...FIXTURE, runId: 'wf_progress', workflowProgress: { type: 'workflow_agent' } };
    const { run, rows } = host([record]);
    const { code, stdout, stderr } = run(['wf_progress', '--append']);
    expect(code).toBe(2);
    expect(stderr).toContain('workflowProgress that is not an array; refused');
    expect(stdout).toBe('');
    expect(rows()).toEqual([]);
  });

  test('a replayed (cached) stage with no tokens or durationMs appends as null, never as 0', () => {
    const progress = FIXTURE.workflowProgress.map((entry: Record<string, unknown>) => ({ ...entry }));
    const index = progress.findIndex((entry: { type: string }) => entry.type === 'workflow_agent');
    const { tokens: _tokens, durationMs: _durationMs, ...stage } = progress[index];
    progress[index] = { ...stage, cached: true };
    const record = { ...FIXTURE, runId: 'wf_cached', workflowProgress: progress };
    const { run, rows } = host([record]);
    const { code, stdout } = run([record.runId, '--append']);
    expect(code).toBe(0);
    expect(stdout).toContain(`${stage.label}\t${stage.model}\t-\t`);
    const [row] = rows();
    expect(row.totalTokens).toBe(FIXTURE.totalTokens);
    expect(row.stages[0]).toMatchObject({ label: stage.label, tokens: null, durationMs: null });
  });

  test('a stage whose tokens is present but not a number exits 2 and writes nothing', () => {
    const progress = FIXTURE.workflowProgress.map((entry: Record<string, unknown>) => ({ ...entry }));
    const stage = progress.find((entry: { type: string }) => entry.type === 'workflow_agent');
    stage.tokens = '110220';
    const record = { ...FIXTURE, runId: 'wf_stage-string', workflowProgress: progress };
    const { run, rows } = host([record]);
    const { code, stdout, stderr } = run([record.runId, '--append']);
    expect(code).toBe(2);
    expect(stderr).toContain(`stage ${stage.label} with a non-numeric tokens; refused`);
    expect(stdout).toBe('');
    expect(rows()).toEqual([]);
  });

  test('a positional runId that differs from the --record runId exits 2 and writes nothing', () => {
    const { run, rows, workflows } = host([FIXTURE]);
    const path = join(workflows, `${FIXTURE.runId}.json`);
    const { code, stdout, stderr } = run(['wf_other', '--record', path, '--append']);
    expect(code).toBe(2);
    expect(stderr).toBe(`wish report: ${path} holds runId ${FIXTURE.runId}, not wf_other; refused\n`);
    expect(stdout).toBe('');
    expect(rows()).toEqual([]);
    expect(run([FIXTURE.runId, '--record', path]).code).toBe(0); // the matching pair still reads
  });

  test('a corrupt ledger line is skipped and named; --append and --summary still work', () => {
    const records = [
      { ...FIXTURE, runId: 'wf_a', totalTokens: 100, durationMs: 60000 },
      { ...FIXTURE, runId: 'wf_b', totalTokens: 300, durationMs: 180000 },
    ];
    const { run, root } = host(records);
    expect(run(['wf_a', '--append']).code).toBe(0);
    const ledger = join(root, 'genie', 'metrics', 'wish-runs.jsonl');
    appendFileSync(ledger, '{"runId": "wf_torn", "total\n');
    const append = run(['wf_b', '--append']);
    expect(append.code).toBe(0);
    expect(append.stderr).toBe(`wish report: skipped corrupt line 2 of ${ledger}\n`);
    const summary = run(['--summary']);
    expect(summary.code).toBe(0);
    expect(summary.stderr).toBe(`wish report: skipped corrupt line 2 of ${ledger}\n`);
    expect(summary.stdout).toContain('wish\tunlabeled\t2\t200\t2.0\t2/2\t-\t-\t0\n');
  });

  test('--append writes one D9 row, and a second --append of the same runId is refused', () => {
    const { run, rows } = host([FIXTURE]);
    expect(run([FIXTURE.runId, '--append']).code).toBe(0);
    const again = run([FIXTURE.runId, '--append', '--variant', 'routed']);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('already in');
    const ledger = rows();
    expect(ledger).toHaveLength(1);
    expect(Object.keys(ledger[0])).toEqual([
      'v',
      'runId',
      'sessionId',
      'repo',
      'workflowName',
      'variant',
      'state',
      'timestamp',
      'durationMs',
      'totalTokens',
      'totalToolCalls',
      'agentCount',
      'outcome',
      'partial',
      'stages',
    ]);
    expect(ledger[0]).toMatchObject({
      v: 2,
      partial: false,
      outcome: { verdict: null, roundVerdicts: [], repairs: null, gateExitCode: null, checks: null },
      runId: FIXTURE.runId,
      sessionId: SESSION,
      workflowName: 'wish',
      variant: 'unlabeled',
      state: 'merge-ready',
      durationMs: 1447595,
      totalTokens: 535630,
      totalToolCalls: 117,
      agentCount: 6,
    });
    expect(ledger[0].stages[0]).toEqual({
      label: 'admit:scout',
      model: 'claude-opus-5[1m]',
      tokens: 110220,
      toolCalls: 15,
      durationMs: 299296,
    });
  });

  test('a record with result null appends with state null', () => {
    const crashed = { ...FIXTURE, runId: 'wf_crashed', result: null };
    const { run, rows } = host([crashed]);
    const { code, stdout } = run(['wf_crashed', '--append', '--variant', 'routed']);
    expect(code).toBe(0);
    expect(stdout).toContain('state null');
    expect(rows()[0]).toMatchObject({ runId: 'wf_crashed', variant: 'routed', state: null });
  });

  test('--summary groups by workflow and variant; a null state is not merge-ready; non-wish rows carry no rate', () => {
    const records = [
      { ...FIXTURE, runId: 'wf_a', totalTokens: 100, durationMs: 60000 },
      { ...FIXTURE, runId: 'wf_b', totalTokens: 300, durationMs: 180000, result: null },
      { ...FIXTURE, runId: 'wf_c', totalTokens: 50, durationMs: 30000 },
      { ...FIXTURE, runId: 'wf_d', workflowName: 'research-sweep', totalTokens: 10, durationMs: 6000 },
    ];
    const { run } = host(records);
    for (const [runId, variant] of [
      ['wf_a', 'routed'],
      ['wf_b', 'routed'],
      ['wf_c', 'all-opus'],
      ['wf_d', 'routed'],
    ]) {
      expect(run([runId as string, '--append', '--variant', variant as string]).code).toBe(0);
    }
    const { code, stdout } = run(['--summary']);
    expect(code).toBe(0);
    expect(stdout).toContain('workflow\tvariant\tn\tmeanTokens\tmeanMinutes\tmergeReady\tship\tmeanRepairs\tpartial\n');
    expect(stdout).toContain('wish\trouted\t2\t200\t2.0\t1/2\t-\t-\t0\n');
    expect(stdout).toContain('wish\tall-opus\t1\t50\t0.5\t1/1\t-\t-\t0\n');
    expect(stdout).toContain('research-sweep\trouted\t1\t10\t0.1\t-\t-\t-\t0\n');
  });

  test('the outcome the workflow returned rides the row and the summary; a pre-outcome row counts in n only', () => {
    const shipped = {
      ...FIXTURE,
      runId: 'wf_ship',
      result: {
        ok: true,
        state: 'merge-ready',
        review: { verdict: 'SHIP', findings: [] },
        repairs: 1,
        rounds: [
          { round: 1, status: 'fixed', verdict: 'SHIP' },
          { round: 0, status: 'no response', verdict: '' },
        ],
        gate: { exitCode: 0 },
        checks: 'pass',
        stageReached: 'readback',
      },
    };
    const fixFirst = {
      ...FIXTURE,
      runId: 'wf_fix',
      result: {
        ok: false,
        state: 'missed',
        review: { verdict: 'FIX-FIRST' },
        repairs: 3,
        rounds: [],
        gate: { exitCode: 1 },
      },
    };
    const progress = FIXTURE.workflowProgress.map((entry: Record<string, unknown>) => ({ ...entry }));
    const firstStage = progress.find((entry: { type: string }) => entry.type === 'workflow_agent');
    firstStage.tokens = undefined;
    const replayed = { ...FIXTURE, runId: 'wf_replayed', workflowProgress: progress };
    const brainstorm = {
      ...FIXTURE,
      runId: 'wf_brain',
      workflowName: 'brainstorm',
      result: { state: 'round', round: 6, wrs: { score: 88, bar: '88/100' } },
    };
    const { run, root } = host([shipped, fixFirst, replayed, brainstorm]);
    const report = run(['wf_ship']);
    expect(report.code).toBe(0);
    expect(report.stdout).toContain(
      'outcome: verdict SHIP, round verdicts SHIP, repairs 1, gate exit 0, checks pass, stage reached readback\n',
    );
    expect(run(['wf_brain']).stdout).toContain('outcome: round 6, WRS 88\n');
    expect(run(['wf_replayed']).stdout).toContain('partial: a stage carries no tokens or duration');
    // A version-1 row, written before the outcome fields existed.
    const ledger = join(root, 'genie', 'metrics', 'wish-runs.jsonl');
    mkdirSync(join(root, 'genie', 'metrics'), { recursive: true });
    const legacy = { ...FIXTURE, runId: 'wf_legacy', workflowProgress: undefined, result: undefined };
    writeFileSync(
      ledger,
      `${JSON.stringify({ runId: legacy.runId, sessionId: SESSION, repo: null, workflowName: 'wish', variant: 'v', state: 'merge-ready', timestamp: null, durationMs: 60000, totalTokens: 100, totalToolCalls: null, agentCount: 1, stages: [] })}\n`,
    );
    for (const runId of ['wf_ship', 'wf_fix', 'wf_replayed']) {
      expect(run([runId, '--append', '--variant', 'v']).code).toBe(0);
    }
    const summary = run(['--summary']);
    expect(summary.code).toBe(0);
    expect(summary.stdout).toMatch(/^wish\tv\t4\t\d+\t[\d.]+\t3\/4\t1\/2\t2\.0\t1$/m);
  });

  test('--summary over an empty ledger says so and exits 0; no runId and no --summary exits 2', () => {
    const { run } = host([]);
    const summary = run(['--summary']);
    expect(summary.code).toBe(0);
    expect(summary.stdout).toContain('no runs in');
    const bare = run([]);
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain('name a runId');
  });
});

describe('the built bundle', () => {
  /** `dist/genie.js` when the build already ran, else a throwaway build of the same entry point. */
  function bundle(): string {
    const built = join(ROOT, 'dist', 'genie.js');
    if (existsSync(built)) return built;
    const out = join(tmp('genie-wish-bundle-'), 'genie.js');
    const build = Bun.spawnSync(
      [process.execPath, 'build', ENTRY, '--target', 'bun', '--external', 'bun', '--outfile', out],
      { cwd: ROOT },
    );
    if (build.exitCode !== 0) throw new Error(`bundling failed: ${build.stderr.toString()}`);
    return out;
  }

  function runBundle(argv: string[], cwd: string) {
    const proc = Bun.spawnSync([process.execPath, bundle(), ...argv], { cwd, env: { ...process.env } });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }

  test('--dir names the wishes root, from a cwd that has none of its own', () => {
    const repo = foreignRepo({ good: wishDoc('DRAFT'), broken: wishDoc('SUPERSEDED IN PART') });
    const elsewhere = tmp('genie-wish-cwd-');
    const { code, stderr } = runBundle(['wish', 'lint', '--dir', repo], elsewhere);
    expect(code).toBe(1);
    expect(stderr).toContain('.genie/wishes/broken/WISH.md');
  });

  /**
   * The `import.meta.url` proof. In the bundle that URL resolves under `/$bunfs`,
   * so a root derived from it would scan nothing — and a root derived from the
   * genie checkout would report genie's own ~90 wishes no matter where the binary
   * was run. Exactly two files scanned, in the cwd's OWN git toplevel, is neither.
   */
  test('with no flag the root is the git toplevel of the cwd, never the genie checkout', () => {
    const repo = foreignRepo({ good: wishDoc('DRAFT'), other: wishDoc('SHIPPED') });
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    const fromSubdir = runBundle(['wish', 'lint'], join(repo, 'src', 'deep'));
    expect(fromSubdir.code).toBe(0);
    expect(fromSubdir.stderr).toContain('wishes-lint: OK (2 files scanned');
  });

  test('no imported module runs its own entry block', () => {
    const repo = foreignRepo({ good: wishDoc('DRAFT') });
    const version = runBundle(['--version'], ROOT);
    expect(version.code).toBe(0);
    expect(version.stderr).toBe('');

    const lint = runBundle(['wish', 'lint', '--dir', repo], ROOT);
    expect(lint.code).toBe(0);
    // `scripts/wishes-lint.ts` carries its own entry block; inside the bundle it
    // is an imported module, so its usage banner must never appear on a run that
    // succeeded.
    expect(lint.stderr).not.toContain('usage: wishes-lint');
  });
});
