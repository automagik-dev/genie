#!/usr/bin/env bun
/**
 * scripts/mikro/coach.ts — one coaching round over one microagent's prompt.
 *
 *   genie mikro coach <agent> [--reps 2] [--concurrency 3] [--only a,b]
 *       [--fixtures path] [--proposal file.json] [--null-control] [--band file.json]
 *       [--dir repo] [--keep-temp] [--no-phoenix]
 *   bun scripts/mikro/coach.ts <agent> …          # the same code, inside this checkout
 *
 * `genie mikro coach` and `bun scripts/mikro/coach.ts` are ONE code path: both call
 * {@link runCoachCli}, which returns the exit code and never calls `process.exit`,
 * because inside the genie binary it is one command of a longer-lived process.
 *
 * The loop the three microagents were tuned by hand through — read the evidence,
 * hypothesize, patch, bench, compare — with the model doing only the
 * hypothesizing. Everything that could damage something is script-side:
 *
 *   1. `mikro-coach` returns a PROPOSAL as data (`schemas.ts` Coach): one to
 *      three `{find, replace}` pairs against the target's SYSTEM.md, the fixtures
 *      they should move, and the lift they expect. Or `null`, which is a correct
 *      answer.
 *   2. This script VERIFIES it mechanically — every `find` unique at the moment
 *      it is applied (sequentially, in the copy, never one up-front pass), the
 *      size bounds, and `targetFixtures` resolving to real fixture ids. A
 *      proposal that fails is refused with the reason and nothing is benched.
 *   3. The patch is applied to a `mkdtemp` COPY of `.mikro/`, never to the
 *      checkout, and the unified diff is printed with its sha256 — that hash is
 *      what an operator records beside the table when they apply it by hand.
 *   4. Two bench runs, sequential, same session, same fixtures and reps: BEFORE
 *      on the tracked agents dir, AFTER through `bench.ts --agents-dir <copy>`.
 *   5. One table and one verdict, by the rule pre-registered in `decideVerdict`
 *      below and in `README.md`: the target fixtures decide, the others guard,
 *      any bar that was passing and stops passing is a regression, and a lift
 *      smaller than the null-control drift band is `inconclusive`.
 *
 * There is NO `--apply`. The operator applies the printed diff by hand; nothing
 * here, and nothing the coach returns, writes to a tracked file.
 *
 * `--null-control` runs steps 3–5 with an EMPTY patch: the "after" copy is
 * byte-identical to the checkout, so whatever the table then shows is noise —
 * session-to-session drift — and that band is what every later verdict is judged
 * against. Run it first.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { resolveFixturesPath } from './bench-options';
import { type RunResult, runAgent } from './call';
import { COACH_LIMITS, Coach, isAgentName } from './schemas';
import { gitProbeEnv } from './trusted-source';

// ─── Types ───────────────────────────────────────────────

export interface CoachEdit {
  find: string;
  replace: string;
}
export interface CoachProposal {
  hypothesis: string;
  edits: CoachEdit[];
  targetFixtures: string[];
  expectedLift: { metric: Metric; from: number; to: number };
}
export type Metric = 'recall' | 'yield' | 'cost';

/** One bench row as `bench.ts` records it (the subset a verdict needs). */
export interface BenchRow {
  id: string;
  rep: number;
  ok: boolean;
  cost: number;
  seconds: number;
  score: { filesRecall: number | null };
}
export interface BenchRecord {
  traceId: string;
  tags: Record<string, string>;
  agentsDir?: string;
  summary: Record<string, unknown>;
  bars: Record<string, boolean>;
  rows: BenchRow[];
  results?: { result: { runId: string } }[];
}

/** Per-fixture aggregate over the reps of one bench. */
export interface FixtureMetrics {
  yield: number;
  recall: number | null;
  cost: number;
  p50: number;
  runs: number;
}

/** A refusal that costs nothing: raised before any bench run is spawned. */
export class CoachRefusal extends Error {}

// ─── Verification and application (deterministic, before generative) ───

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Apply the edits IN ORDER, proving each `find` unique at the moment it is
 * applied rather than in one up-front pass: edit 2 may only anchor on text edit 1
 * left behind, and an up-front check would bless an anchor the first edit has
 * already duplicated or destroyed.
 */
export function applyEditsSequentially(text: string, edits: CoachEdit[]): { text: string; at: number[] } {
  let out = text;
  const at: number[] = [];
  edits.forEach((edit, i) => {
    if (!edit.find) throw new CoachRefusal(`edit ${i + 1}: \`find\` is empty`);
    if (edit.find.length > COACH_LIMITS.maxFindChars)
      throw new CoachRefusal(
        `edit ${i + 1}: \`find\` is ${edit.find.length} chars, over the ${COACH_LIMITS.maxFindChars} limit`,
      );
    const first = out.indexOf(edit.find);
    if (first < 0)
      throw new CoachRefusal(`edit ${i + 1}: \`find\` does not occur in the prompt at the point it is applied`);
    if (out.indexOf(edit.find, first + 1) >= 0)
      throw new CoachRefusal(
        `edit ${i + 1}: \`find\` occurs more than once at the point it is applied — an anchor must be unique`,
      );
    at.push(out.slice(0, first).split('\n').length);
    out = `${out.slice(0, first)}${edit.replace}${out.slice(first + edit.find.length)}`;
  });
  return { text: out, at };
}

/**
 * Everything a proposal must satisfy before a cent is spent on measuring it.
 * `targetFixtures` that is empty or names an id the set does not hold is a HARD
 * REJECT — never quietly downgraded to "no proposal", because the two mean
 * opposite things about the coach.
 */
export function verifyProposal(
  proposal: CoachProposal,
  systemText: string,
  fixtureIds: string[],
): { text: string; at: number[]; replaceChars: number } {
  if (!proposal.edits.length || proposal.edits.length > COACH_LIMITS.maxEdits)
    throw new CoachRefusal(`a proposal carries 1–${COACH_LIMITS.maxEdits} edits, not ${proposal.edits.length}`);
  const replaceChars = proposal.edits.reduce((n, e) => n + e.replace.length, 0);
  if (replaceChars > COACH_LIMITS.maxReplaceCharsTotal)
    throw new CoachRefusal(
      `the replacements total ${replaceChars} chars, over the ${COACH_LIMITS.maxReplaceCharsTotal} limit`,
    );
  if (!proposal.targetFixtures.length)
    throw new CoachRefusal('`targetFixtures` is empty: name the fixtures this patch should move');
  const unknown = proposal.targetFixtures.filter((id) => !fixtureIds.includes(id));
  if (unknown.length)
    throw new CoachRefusal(`\`targetFixtures\` names ids the fixture set does not hold: ${unknown.join(', ')}`);
  const applied = applyEditsSequentially(systemText, proposal.edits);
  if (applied.text === systemText) throw new CoachRefusal('the edits leave the prompt unchanged');
  return { ...applied, replaceChars };
}

// ─── Metrics and the pre-registered verdict rule ──────────

export function fixtureMetrics(rows: BenchRow[]): Map<string, FixtureMetrics> {
  const byId = new Map<string, BenchRow[]>();
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
  const out = new Map<string, FixtureMetrics>();
  for (const [id, rs] of byId) {
    const recalls = rs
      .filter((r) => r.ok)
      .map((r) => r.score.filesRecall)
      .filter((x): x is number => x !== null);
    out.set(id, {
      yield: mean(rs.map((r) => (r.ok ? 1 : 0))),
      recall: recalls.length ? mean(recalls) : null,
      cost: mean(rs.map((r) => r.cost)),
      p50: median(rs.map((r) => r.seconds)),
      runs: rs.length,
    });
  }
  return out;
}

export function metricValue(metric: Metric, m: FixtureMetrics | undefined): number | null {
  if (!m) return null;
  if (metric === 'recall') return m.recall;
  if (metric === 'yield') return m.yield;
  return m.cost;
}

/** Higher is better for recall and yield; lower is better for cost. One sign convention, one place. */
export function improvement(metric: Metric, before: number, after: number): number {
  return metric === 'cost' ? before - after : after - before;
}

export type Verdict = 'lift' | 'no-lift' | 'regression' | 'inconclusive';

export interface VerdictInput {
  metric: Metric;
  targetFixtures: string[];
  before: Map<string, FixtureMetrics>;
  after: Map<string, FixtureMetrics>;
  barsBefore: Record<string, boolean>;
  barsAfter: Record<string, boolean>;
  /** Per-fixture noise floor from a null-control round, on this metric. `null` when none is on record. */
  band: Map<string, number> | null;
}

/**
 * THE VERDICT RULE, pre-registered (README: "Coach one"):
 *
 *   - any bar that passed BEFORE and fails AFTER           → regression
 *   - any GUARD fixture whose metric worsens by more than
 *     its own drift band                                   → regression
 *   - no drift band on record, or the metric was measured
 *     on no target fixture                                 → inconclusive
 *   - mean improvement over the TARGET fixtures above the
 *     widest band among them                               → lift
 *   - |mean improvement| inside that band                  → inconclusive
 *   - otherwise (the targets moved the wrong way)          → no-lift
 *
 * The target fixtures DECIDE and the others GUARD, and the split is what the
 * two words mean: `regression` is the patch breaking something it was not aiming
 * at — a bar, or a fixture it never claimed — while a target fixture falling is
 * the hypothesis being wrong, which is `no-lift`. A band is per fixture because
 * the noise is: a fixture with a large truth set swings, a small one does not.
 */
export function decideVerdict(input: VerdictInput): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  for (const [bar, passed] of Object.entries(input.barsBefore))
    if (passed && input.barsAfter[bar] === false) reasons.push(`bar ${bar} passed before and fails after`);
  const bandFor = (id: string) => input.band?.get(id) ?? 0;
  const improvements = new Map<string, number>();
  for (const id of new Set([...input.before.keys(), ...input.after.keys()])) {
    const b = metricValue(input.metric, input.before.get(id));
    const a = metricValue(input.metric, input.after.get(id));
    if (b === null || a === null) continue;
    const delta = improvement(input.metric, b, a);
    improvements.set(id, delta);
    const guard = !input.targetFixtures.includes(id);
    if (guard && input.band && delta < -bandFor(id))
      reasons.push(
        `guard fixture ${id} ${input.metric} worsened by ${(-delta).toFixed(3)}, past its ${bandFor(id).toFixed(3)} drift band`,
      );
  }
  if (reasons.length) return { verdict: 'regression', reasons };
  if (!input.band)
    return {
      verdict: 'inconclusive',
      reasons: ['no null-control drift band on record: run coach.ts --null-control first'],
    };
  const targets = input.targetFixtures.filter((id) => improvements.has(id));
  if (!targets.length)
    return {
      verdict: 'inconclusive',
      reasons: [`no ${input.metric} measured on any target fixture (${input.targetFixtures.join(', ')})`],
    };
  const delta = mean(targets.map((id) => improvements.get(id) as number));
  const widest = Math.max(...targets.map(bandFor));
  if (delta > widest)
    return {
      verdict: 'lift',
      reasons: [`target ${input.metric} +${delta.toFixed(3)} over a ${widest.toFixed(3)} drift band`],
    };
  if (Math.abs(delta) <= widest)
    return {
      verdict: 'inconclusive',
      reasons: [`target ${input.metric} moved ${delta.toFixed(3)}, inside the ${widest.toFixed(3)} drift band`],
    };
  return {
    verdict: 'no-lift',
    reasons: [`target ${input.metric} moved ${delta.toFixed(3)} against a ${widest.toFixed(3)} drift band`],
  };
}

// ─── CLI ─────────────────────────────────────────────────

const COST_BAR_USD = 0.05; // bench.ts's median-cost bar, the per-run figure an expected cost is built from
const WALL_CLOCK_CAP_MS = 20 * 60 * 1000;

export const COACH_USAGE = `usage: genie mikro coach <issue-triage|wish-context|review-prep> [--reps 2] [--concurrency 3] [--only a,b] [--fixtures path] [--proposal file.json] [--null-control] [--band file.json] [--dir repo] [--keep-temp] [--no-phoenix]
       (inside this checkout the same code runs as: bun scripts/mikro/coach.ts <agent> …)
`;

/** A refusal or an abort, carrying the exit code `runCoachCli` returns. Never a `process.exit`. */
class CoachExit extends Error {
  constructor(readonly code: number) {
    super(`coach exited ${code}`);
  }
}

function usage(): never {
  process.stderr.write(COACH_USAGE);
  throw new CoachExit(2);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * `git status --porcelain`, as a set of lines, for the before/after side-effect assertion.
 * On the stripped ambient environment, because `-C <dir>` does not override an exported
 * `GIT_DIR` and a status read from another repository would make the gate meaningless.
 */
function gitStatus(dir: string, pathspec?: string): string[] {
  const argv = ['git', '-C', dir, 'status', '--porcelain', ...(pathspec ? ['--', pathspec] : [])];
  return Bun.spawnSync(argv, { env: gitProbeEnv() }).stdout.toString().split('\n').filter(Boolean);
}

/**
 * Gate 1's abort text. The diagnostic half is unchanged — the reason the gate exists, then
 * every dirty path — and the remedy half names BOTH ways out, because the sequence
 * `genie mikro init` prints leaves an untracked `EVIDENCE.md` here and said nothing about it.
 */
export function dirtyAgentsAbortReason(dirtyAgents: string[]): string {
  return [
    `.mikro/agents is not clean — "before" would not be the recorded prompt:`,
    ...dirtyAgents,
    'commit the listed paths (a bench --write-evidence run writes one of them), or remove them, then re-run this command.',
  ].join('\n');
}

/**
 * How this round runs its two benches — the one thing a coaching round cannot do
 * in-process, because a bench is a whole run of its own with its own record.
 *
 * Inside the genie checkout it is still `bun <repo>/scripts/mikro/bench.ts`, so every
 * recorded round is reproduced by the same command line it always was. In a repository
 * that is not genie there is no such file, and the answer is whatever is running this
 * code: a sibling `bench.ts` when the coach was started from a checkout, the bundled
 * entry when it is `bun dist/genie.js`, and the compiled binary itself otherwise —
 * where `Bun.main` resolves under `/$bunfs` and must never be passed to anything.
 */
export function benchCommand(
  repo: string,
  main: string = Bun.main,
  execPath: string = process.execPath,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const local = join(repo, 'scripts', 'mikro', 'bench.ts');
  if (exists(local)) return ['bun', local];
  if (!isEmbeddedPath(main)) {
    const sibling = main.endsWith(`${sep}coach.ts`) ? join(dirname(main), 'bench.ts') : '';
    if (sibling && exists(sibling)) return ['bun', sibling];
    if (exists(main)) return [execPath, main, 'mikro', 'bench'];
  }
  return [execPath, 'mikro', 'bench'];
}

/**
 * True for a path inside a Bun standalone binary's embedded filesystem: `/$bunfs/root/…`
 * on Unix, `B:\~BUN\root\…` on Windows.
 *
 * The check cannot be `existsSync`, and that is the whole point of this function. Inside
 * the running binary the embedded file IS there — `existsSync('/$bunfs/root/genie')` is
 * TRUE — so a "does it exist" test says "script" about a path no OTHER process can open.
 * Handing it on produces `genie /$bunfs/root/genie mikro bench`, which exits 1 with
 * `unknown command`, which leaves the round with no bench record to find. Verified by
 * compiling a probe binary against this file; the unit fixture that answered false for
 * the embedded path was describing a host that does not exist.
 */
function isEmbeddedPath(path: string): boolean {
  return path.startsWith('/$bunfs') || path.includes('/$bunfs/') || path.includes('~BUN');
}

/**
 * The prompt the coach is given: which prompt to read, which evidence, which fixtures —
 * all of them paths in the tree under `--dir`, relative to it, because the citation gate
 * verifies every `path:line` an answer carries against that tree.
 *
 * A freshly seeded repository has no `EVIDENCE.md`, which is not an error and must not
 * be a crash: the prompt then says so and names what there IS to reason from. Citing a
 * file that does not exist would fail the gate the agent is judged by.
 */
export function coachPrompt(args: {
  agent: string;
  repo: string;
  systemPath: string;
  evidencePath: string;
  fixturesPath: string;
  evidenceExists: boolean;
}): string {
  const rel = (path: string) => (path.startsWith(`${args.repo}${sep}`) ? path.slice(args.repo.length + 1) : path);
  const head = `Coach ${args.agent}.\nsystem: ${rel(args.systemPath)}\n`;
  const fixtures = `fixtures: ${rel(args.fixturesPath)}\n`;
  return args.evidenceExists
    ? `${head}evidence: ${rel(args.evidencePath)}\n${fixtures}\nRead the prompt, read the rows of every round in that evidence file, and propose at most one bounded patch to that SYSTEM.md, or null.`
    : `${head}${fixtures}\nThere is no evidence file yet (${rel(args.evidencePath)} does not exist): this agent has never been benched, so there are no measured rows to diagnose. Read the prompt and the fixture set, and propose a bounded patch ONLY where the prompt plainly cannot answer what the fixtures ask for — otherwise null, which is the right answer before the first round.`;
}

/** The newest bench record in `.mikro/runs` carrying these tags — the round's own, never a neighbour's. */
function findBenchRecord(dir: string, agent: string, stamp: string, phase: string): BenchRecord {
  const runs = join(dir, '.mikro', 'runs');
  const hits = readdirSync(runs)
    .filter((f) => f.startsWith(`bench-${agent}-`) && f.endsWith('.json'))
    .map((f) => join(runs, f))
    .map((p) => ({ p, record: JSON.parse(readFileSync(p, 'utf8')) as BenchRecord }))
    .filter(({ record }) => record.tags?.coachRound === stamp && record.tags?.coach === phase);
  if (!hits.length) throw new Error(`no bench record for coachRound=${stamp} coach=${phase} in ${runs}`);
  return hits[hits.length - 1].record;
}

/** Run one bench, inheriting stdio so the operator watches it, and kill it at the round's wall-clock deadline. */
async function runBench(args: {
  repo: string;
  agent: string;
  stamp: string;
  phase: 'before' | 'after';
  reps: number;
  concurrency: number;
  only?: string;
  fixtures?: string;
  agentsDir?: string;
  phoenix: boolean;
  deadline: number;
}): Promise<BenchRecord> {
  const argv = [
    ...benchCommand(args.repo),
    args.agent,
    '--dir',
    args.repo,
    '--reps',
    String(args.reps),
    '--concurrency',
    String(args.concurrency),
    '--tag',
    `coach=${args.phase}`,
    '--tag',
    `coachRound=${args.stamp}`,
    ...(args.only ? ['--only', args.only] : []),
    ...(args.fixtures ? ['--fixtures', args.fixtures] : []),
    ...(args.agentsDir ? ['--agents-dir', args.agentsDir] : []),
    ...(args.phoenix ? [] : ['--no-phoenix']),
  ];
  process.stderr.write(`\n▶ bench ${args.phase}: ${argv.slice(1).join(' ')}\n`);
  const proc = Bun.spawn(argv, { cwd: args.repo, stdout: 'inherit', stderr: 'inherit' });
  const left = args.deadline - Date.now();
  const timer = setTimeout(() => proc.kill(), Math.max(1, left));
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }
  if (Date.now() >= args.deadline)
    throw new Error(
      `the round passed its ${WALL_CLOCK_CAP_MS / 60000}-minute wall-clock cap during the ${args.phase} bench`,
    );
  // A non-zero exit is a FAILED BAR, not a failed bench: the record is still written and is still the evidence.
  return findBenchRecord(args.repo, args.agent, args.stamp, args.phase);
}

function table(
  metric: Metric,
  ids: string[],
  before: Map<string, FixtureMetrics>,
  after: Map<string, FixtureMetrics>,
  targets: string[],
  band: Map<string, number> | null,
): string {
  const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(3));
  const lines = [
    `| fixture | role | yield b→a | recall b→a | $ b→a | p50s b→a | Δ${metric} | band |`,
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const id of ids) {
    const b = before.get(id);
    const a = after.get(id);
    const bv = metricValue(metric, b);
    const av = metricValue(metric, a);
    const delta = bv !== null && av !== null ? improvement(metric, bv, av) : null;
    lines.push(
      `| ${id} | ${targets.includes(id) ? 'target' : 'guard'} | ${fmt(b?.yield ?? null)}→${fmt(a?.yield ?? null)} | ${fmt(b?.recall ?? null)}→${fmt(a?.recall ?? null)} | ${b ? b.cost.toFixed(4) : '—'}→${a ? a.cost.toFixed(4) : '—'} | ${fmt(b?.p50 ?? null)}→${fmt(a?.p50 ?? null)} | ${delta === null ? '—' : (delta >= 0 ? '+' : '') + delta.toFixed(3)} | ${band ? (band.get(id) ?? 0).toFixed(3) : '—'} |`,
    );
  }
  return lines.join('\n');
}

/** The drift band from a null-control round record, on one metric. */
function bandFromRecord(path: string, metric: Metric): { band: Map<string, number>; source: string } {
  const record = JSON.parse(readFileSync(path, 'utf8')) as {
    mode?: string;
    perFixture?: { id: string; before: FixtureMetrics; after: FixtureMetrics }[];
  };
  if (record.mode !== 'null-control')
    throw new Error(`${path} is not a null-control round (mode: ${record.mode ?? 'absent'})`);
  const band = new Map<string, number>();
  for (const row of record.perFixture ?? []) {
    const b = metricValue(metric, row.before);
    const a = metricValue(metric, row.after);
    if (b !== null && a !== null) band.set(row.id, Math.abs(improvement(metric, b, a)));
  }
  return { band, source: path };
}

/** The newest null-control round on record for this agent, if any. */
function newestNullControl(dir: string, agent: string): string | null {
  const runs = join(dir, '.mikro', 'runs');
  if (!existsSync(runs)) return null;
  const hits = readdirSync(runs)
    .filter((f) => f.startsWith(`coach-${agent}-`) && f.endsWith('.json'))
    .sort()
    .map((f) => join(runs, f))
    .filter((p) => {
      try {
        return (JSON.parse(readFileSync(p, 'utf8')) as { mode?: string }).mode === 'null-control';
      } catch {
        return false;
      }
    });
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * One coaching round. Returns 0 (a proposal measured, or a null answer), 1 (the round
 * aborted, or left a tracked change behind) or 2 (refused before anything was written).
 */
export async function runCoachCli(argv: string[]): Promise<number> {
  try {
    return await coachRound(argv);
  } catch (error) {
    if (error instanceof CoachExit) return error.code;
    throw error;
  }
}

/** One linear round: refuse, propose, verify, patch a copy, bench twice, judge, report. */
async function coachRound(argv: string[]): Promise<number> {
  const agent = argv[0];
  if (!agent || !isAgentName(agent) || agent === 'mikro-coach') usage();
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(name);
  const repo = resolve(opt('--dir') ?? process.cwd());
  const reps = Number(opt('--reps') ?? 2);
  const concurrency = Number(opt('--concurrency') ?? 3);
  const only = opt('--only');
  const nullControl = has('--null-control');
  const replayFrom = opt('--proposal');
  const phoenix = !has('--no-phoenix');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const started = Date.now();
  const deadline = started + WALL_CLOCK_CAP_MS;

  // Refusals that cost nothing come FIRST, before a run directory or a record exists:
  // a repository with no agent to coach, or no fixture set to measure it with, is a
  // mistake to name with its remedy rather than an ENOENT three steps later.
  const fixturesPath = resolveFixturesPath({ dir: repo, agent, explicit: opt('--fixtures') });
  const systemPath = join(repo, '.mikro', 'agents', agent, 'SYSTEM.md');
  const evidencePath = join(repo, '.mikro', 'agents', agent, 'EVIDENCE.md');
  if (!existsSync(systemPath)) {
    process.stderr.write(
      `no ${agent} prompt at ${systemPath}
  a coaching round measures the WORKING TREE under --dir, never a git ref
  seed this repository's agents first: genie mikro init --dir ${repo}
`,
    );
    return 2;
  }
  if (!existsSync(fixturesPath)) {
    process.stderr.write(
      `no fixture set at ${fixturesPath}
  --fixtures <path>, else <dir>/.mikro/fixtures/${agent}.json, else <dir>/scripts/mikro/fixtures/${agent}.json
  build one from this repository's own history: genie mikro fixtures --from-commits <range> --agent ${agent}
`,
    );
    return 2;
  }

  const runsDir = join(repo, '.mikro', 'runs');
  mkdirSync(runsDir, { recursive: true });
  const roundPath = join(runsDir, `coach-${agent}-${stamp}.json`);
  const headSha = Bun.spawnSync(['git', '-C', repo, 'rev-parse', 'HEAD'], { env: gitProbeEnv() })
    .stdout.toString()
    .trim();
  const statusBefore = gitStatus(repo);
  const fixtureSet = JSON.parse(readFileSync(fixturesPath, 'utf8')) as { fixtures: { id: string }[] };
  const fixtureIds = fixtureSet.fixtures.map((f) => f.id).filter((id) => !only || only.split(',').includes(id));
  const systemText = readFileSync(systemPath, 'utf8');

  const round: Record<string, unknown> = {
    schema: 'mikro-coach-round/1',
    agent,
    stamp,
    mode: nullControl ? 'null-control' : replayFrom ? 'replay' : 'coach',
    outcome: 'aborted',
    headSha,
    reps,
    concurrency,
    fixturesPath,
    fixtureIds,
    /** The coach can read the fixture file, ground truth and all: recorded honestly, holdout evaluation is a follow-up. */
    truthSetsVisible: true,
    costUsd: 0,
    elapsedMs: 0,
  };
  const abort: (reason: string, extra?: Record<string, unknown>) => never = (reason, extra = {}) => {
    Object.assign(round, { outcome: 'aborted', abortReason: reason, elapsedMs: Date.now() - started }, extra);
    writeFileSync(roundPath, `${JSON.stringify(round, null, 2)}\n`);
    process.stderr.write(`\ncoach: ABORTED — ${reason}\ncoach: round recorded at ${roundPath}\n`);
    if (typeof extra.tempRoot === 'string')
      process.stderr.write(`coach: the patched copy was kept at ${extra.tempRoot}\n`);
    // Thrown, never exited: inside the genie binary this is one command of a longer-lived
    // process, and a `finally` still has a temp directory to remove.
    throw new CoachExit(1);
  };

  // Gate 1: the tracked agents dir must be clean. A patched or half-staged prompt makes "before" meaningless.
  const dirtyAgents = gitStatus(repo, '.mikro/agents');
  if (dirtyAgents.length) abort(dirtyAgentsAbortReason(dirtyAgents), { dirtyAgents });
  round.trackedAgentsClean = true;

  // Step 1: the proposal — from the coach, from a file (deterministic replay), or the null patch.
  let proposal: CoachProposal | null = null;
  let coachRun: RunResult | null = null;
  if (nullControl) {
    process.stderr.write('coach: --null-control — no coach call, an empty patch, a byte-identical copy\n');
  } else if (replayFrom) {
    const raw = JSON.parse(readFileSync(resolve(replayFrom), 'utf8'));
    const parsed = Coach.safeParse(raw);
    if (!parsed.success)
      abort(
        `--proposal does not validate against the Coach schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    proposal = (parsed.success ? parsed.data.proposal : null) as CoachProposal | null;
    round.proposal = proposal;
  } else {
    const prompt = coachPrompt({
      agent,
      repo,
      systemPath,
      evidencePath,
      fixturesPath,
      evidenceExists: existsSync(evidencePath),
    });
    process.stderr.write(`coach: calling mikro-coach on ${agent}…\n`);
    coachRun = await runAgent({
      agent: 'mikro-coach',
      prompt,
      dir: repo,
      tags: { coachRound: stamp, coach: 'propose', target: agent },
      phoenix,
    });
    round.coach = {
      runId: coachRun.runId,
      traceId: coachRun.traceId,
      ok: coachRun.ok,
      costUsd: coachRun.costUsd,
      elapsedMs: coachRun.elapsedMs,
      errors: coachRun.attempts.flatMap((a) => a.errors),
      answer: coachRun.answer,
    };
    round.costUsd = coachRun.costUsd;
    if (!coachRun.ok) abort(`the coach run failed: ${coachRun.attempts.flatMap((a) => a.errors).join('; ')}`);
    proposal = ((coachRun.answer as { proposal?: CoachProposal | null } | undefined)?.proposal ??
      null) as CoachProposal | null;
    round.proposal = proposal;
    const diagnosis =
      (coachRun.answer as { diagnosis?: { observation: string; evidence: string }[] } | undefined)?.diagnosis ?? [];
    for (const d of diagnosis) process.stdout.write(`· ${d.observation}  [${d.evidence}]\n`);
    const injections = (coachRun.answer as { injection_attempts?: string[] } | undefined)?.injection_attempts ?? [];
    for (const i of injections) process.stdout.write(`! injection reported: ${i}\n`);
  }

  if (!nullControl && !proposal) {
    Object.assign(round, { outcome: 'null', elapsedMs: Date.now() - started });
    writeFileSync(roundPath, `${JSON.stringify(round, null, 2)}\n`);
    process.stdout.write(
      `\ncoach: no patch proposed — the evidence did not earn one. Nothing was benched.\ncoach: round recorded at ${roundPath}\n`,
    );
    return 0;
  }

  // Step 2: verify, then apply to a COPY. Nothing tracked is touched, in either order.
  let patched = systemText;
  let verification: Record<string, unknown> = { edits: 0, replaceChars: 0 };
  if (proposal) {
    try {
      const v = verifyProposal(proposal, systemText, fixtureIds);
      patched = v.text;
      verification = {
        edits: proposal.edits.length,
        appliedAtLines: v.at,
        replaceChars: v.replaceChars,
        targetFixtures: proposal.targetFixtures,
      };
    } catch (error) {
      abort(
        `the proposal was refused before any bench run: ${error instanceof Error ? error.message : String(error)}`,
        {
          verification: { refused: true },
        },
      );
    }
  }
  round.verification = verification;

  const tempRoot = mkdtempSync(join(tmpdir(), `mikro-coach-${agent}-`));
  /** The copy is removed on success; `--keep-temp`, and every failure, keeps it and names it. */
  let tempKept = has('--keep-temp');
  try {
    // The copy carries the whole `.mikro/` config, not just `agents/`: `runAgent` derives its trusted
    // root from the agents dir and refuses a --dir whose .mikro/{mikro.yaml,TOOLS.md,SYSTEM.md,CRITERIA.md}
    // differs from it (call.ts untrustedConfig). A copy that carried only `agents/` would be refused —
    // correctly, and the guard is not weakened for it; the copy is made to satisfy it.
    cpSync(join(repo, '.mikro'), join(tempRoot, '.mikro'), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !src.startsWith(join(repo, '.mikro', 'runs')),
    });
    const copiedSystem = join(tempRoot, '.mikro', 'agents', agent, 'SYSTEM.md');
    writeFileSync(copiedSystem, patched);
    const agentsDir = join(tempRoot, '.mikro', 'agents');
    round.agentsDirAfter = agentsDir;
    round.promptSha = { before: sha256(systemText), after: sha256(patched) };

    const diff = Bun.spawnSync(['diff', '-u', systemPath, copiedSystem]).stdout.toString();
    round.diffSha256 = sha256(diff);
    process.stdout.write(
      diff ? `\n${diff}\n` : '\ncoach: the patched copy is byte-identical to the checkout (null control)\n',
    );
    process.stdout.write(`coach: diff sha256 ${round.diffSha256}\n`);

    // Step 3: two benches, sequential, same session.
    const costCap = 2 * (2 * fixtureIds.length * reps * COST_BAR_USD + 0.2);
    // The RESOLVED fixtures path, always — both benches must measure the set this round
    // read its ids from, and a child that resolved again could resolve differently.
    const benchArgs = { repo, agent, stamp, reps, concurrency, only, fixtures: fixturesPath, phoenix, deadline };
    let before: BenchRecord;
    let after: BenchRecord;
    try {
      before = await runBench({ ...benchArgs, phase: 'before' });
      after = await runBench({ ...benchArgs, phase: 'after', agentsDir });
    } catch (error) {
      tempKept = true;
      abort(error instanceof Error ? error.message : String(error), { tempRoot });
    }
    const spend = (r: BenchRecord) => r.rows.reduce((n, row) => n + row.cost, 0);
    round.costUsd = (coachRun?.costUsd ?? 0) + spend(before) + spend(after);
    if ((round.costUsd as number) > costCap) {
      tempKept = true;
      abort(
        `the round cost $${(round.costUsd as number).toFixed(4)}, over the $${costCap.toFixed(4)} cap (2 × the expected bench cost)`,
        { tempRoot },
      );
    }

    // The "after" run's ledger rows land under the copy's trusted root; fold them into the real ledger
    // so every attempt of this round is in one machine-local file.
    const copiedLedger = join(tempRoot, '.mikro', 'runs', `${agent}.jsonl`);
    if (existsSync(copiedLedger)) {
      appendFileSync(join(runsDir, `${agent}.jsonl`), readFileSync(copiedLedger, 'utf8'));
      round.ledgerRowsMerged = readFileSync(copiedLedger, 'utf8').split('\n').filter(Boolean).length;
    }

    // Step 4: the verdict, by the rule above.
    const metric: Metric = proposal?.expectedLift.metric ?? 'recall';
    const beforeMetrics = fixtureMetrics(before.rows);
    const afterMetrics = fixtureMetrics(after.rows);
    const bandPath = opt('--band') ?? (nullControl ? null : newestNullControl(repo, agent));
    let band: Map<string, number> | null = null;
    let bandSource: string | null = null;
    if (bandPath) {
      try {
        const loaded = bandFromRecord(resolve(bandPath), metric);
        band = loaded.band;
        bandSource = loaded.source;
      } catch (error) {
        // An unreadable band is not a reason to throw away two benches that already ran: the rows
        // are recorded, and a verdict with no band is `inconclusive` by the rule, which is honest.
        process.stderr.write(
          `coach: drift band unusable (${error instanceof Error ? error.message : String(error)})\n`,
        );
        round.driftBandError = error instanceof Error ? error.message : String(error);
      }
    }
    const ids = [...new Set([...beforeMetrics.keys(), ...afterMetrics.keys()])].sort();
    const targets = proposal?.targetFixtures ?? [];
    const decision = nullControl
      ? {
          verdict: 'inconclusive' as Verdict,
          reasons: ['null control: an empty patch cannot lift anything — this table IS the drift band'],
        }
      : decideVerdict({
          metric,
          targetFixtures: targets,
          before: beforeMetrics,
          after: afterMetrics,
          barsBefore: before.bars,
          barsAfter: after.bars,
          band,
        });

    round.perFixture = ids.map((id) => ({
      id,
      role: targets.includes(id) ? 'target' : 'guard',
      before: beforeMetrics.get(id) ?? null,
      after: afterMetrics.get(id) ?? null,
      band: band?.get(id) ?? null,
    }));
    round.before = {
      traceId: before.traceId,
      bars: before.bars,
      summary: before.summary,
      rows: before.rows,
      runIds: (before.results ?? []).map((r) => r.result.runId),
    };
    round.after = {
      traceId: after.traceId,
      bars: after.bars,
      summary: after.summary,
      rows: after.rows,
      agentsDir: after.agentsDir,
      runIds: (after.results ?? []).map((r) => r.result.runId),
    };
    round.driftBand = bandSource ? { source: bandSource, metric, perFixture: Object.fromEntries(band ?? []) } : null;
    round.verdict = decision.verdict;
    round.verdictReasons = decision.reasons;
    /** Two reps is a measurement, not a mandate: no operator hand-applies a round-1 lift. */
    round.actionability = reps <= 2 ? 'non-actionable' : 'actionable';
    round.outcome = nullControl ? 'null' : 'proposal';
    round.elapsedMs = Date.now() - started;

    const rendered = table(metric, ids, beforeMetrics, afterMetrics, targets, band);
    process.stdout.write(`\n${rendered}\n\n`);
    process.stdout.write(
      `bars before ${Object.entries(before.bars)
        .map(([k, v]) => `${k}:${v ? '✔' : '✖'}`)
        .join(' ')}\nbars after  ${Object.entries(after.bars)
        .map(([k, v]) => `${k}:${v ? '✔' : '✖'}`)
        .join(' ')}\n`,
    );
    process.stdout.write(
      `\nverdict: ${decision.verdict} (${round.actionability}) · metric ${metric} · band ${bandSource ?? 'none on record'}\n${decision.reasons.map((r) => `  - ${r}`).join('\n')}\n`,
    );
    process.stdout.write(
      `cost $${(round.costUsd as number).toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(0)}s · diff sha256 ${round.diffSha256}\n`,
    );
    writeFileSync(roundPath, `${JSON.stringify(round, null, 2)}\n`);
    process.stdout.write(`coach: round recorded at ${roundPath}\n`);

    // Gate 2: nothing new outside .mikro/runs (which is gitignored anyway). Printed, always.
    const statusAfter = gitStatus(repo);
    const added = statusAfter.filter((l) => !statusBefore.includes(l));
    process.stdout.write(
      `coach: git status --porcelain: ${statusAfter.length} line(s), ${added.length} new since the round started\n`,
    );
    if (added.length) {
      process.stderr.write(`coach: SIDE EFFECT — the round left tracked changes behind:\n${added.join('\n')}\n`);
      round.gitStatusAdded = added;
      writeFileSync(roundPath, `${JSON.stringify(round, null, 2)}\n`);
      return 1;
    }
    return 0;
  } finally {
    if (tempKept) process.stderr.write(`coach: the patched copy was kept at ${tempRoot}\n`);
    else rmSync(tempRoot, { recursive: true, force: true });
  }
}

// No top-level `await`: this module is imported by the genie CLI, where
// `import.meta.main` is false and nothing below must run.
if (import.meta.main) {
  void runCoachCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
