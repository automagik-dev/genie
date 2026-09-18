#!/usr/bin/env bun
/**
 * scripts/mikro/bench.ts — run one microagent over its fixture set and score it.
 *
 *   bun scripts/mikro/bench.ts <agent> [--reps 1] [--concurrency 3] [--only id,id] [--tag round=N]
 *       [--dir repo] [--timeout-ms 600000] [--no-phoenix] [--write-evidence]
 *
 * Every fixture runs through `runAgent` (call.ts: validation, citations, retry,
 * ledger, Phoenix) and is scored mechanically (score.ts) against its ground
 * truth. The table this prints is the evidence a refinement round is judged
 * on; `--write-evidence` appends it to `.mikro/agents/<agent>/EVIDENCE.md`.
 * Bars (the "would I rather call this than a subagent" test), all over the
 * fixture set: yield >= 0.9 (ok runs), fabrication == 0 (dropped citations on
 * ok runs), files recall >= 0.6 mean, median cost <= $0.05, p90 <= 240 s.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type RunResult, runAgent } from './call';
import { isAgentName } from './schemas';
import { type Score, type Truth, scoreAnswer } from './score';

interface Fixture {
  id: string;
  prompt: string;
  truth: Truth;
}

interface Row {
  id: string;
  rep: number;
  ok: boolean;
  attempts: number;
  cost: number;
  seconds: number;
  iterations: number;
  score: Score;
  errors: string[];
}

const argv = process.argv.slice(2);
const agent = argv[0];
if (!agent || !isAgentName(agent)) {
  process.stderr.write(
    'usage: bun scripts/mikro/bench.ts <issue-triage|wish-context|review-prep> [--reps n] [--concurrency n] [--only a,b] [--tag k=v] [--dir repo] [--write-evidence]\n',
  );
  process.exit(2);
}
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);
const dir = resolve(opt('--dir') ?? process.cwd());
const reps = Number(opt('--reps') ?? 1);
const concurrency = Number(opt('--concurrency') ?? 3);
const only = opt('--only')?.split(',').filter(Boolean);
const tags: Record<string, string> = {};
argv.forEach((a, i) => {
  if (a === '--tag' && argv[i + 1]?.includes('=')) {
    const [k, ...v] = argv[i + 1].split('=');
    tags[k] = v.join('=');
  }
});
const fixturesPath = opt('--fixtures') ?? join(dir, 'scripts', 'mikro', 'fixtures', `${agent}.json`);
const set = JSON.parse(readFileSync(fixturesPath, 'utf8')) as { fixtures: Fixture[] };
const fixtures = set.fixtures.filter((f) => !only || only.includes(f.id));
const traceId = `bench:${agent}:${new Date().toISOString()}`;

const jobs: { fixture: Fixture; rep: number }[] = [];
for (let rep = 0; rep < reps; rep++) for (const fixture of fixtures) jobs.push({ fixture, rep });

const rows: Row[] = [];
const results: { fixture: Fixture; rep: number; result: RunResult }[] = [];
let cursor = 0;
async function worker(): Promise<void> {
  for (;;) {
    const job = jobs[cursor++];
    if (!job) return;
    const t0 = Date.now();
    process.stderr.write(`▶ ${agent} ${job.fixture.id} rep ${job.rep}\n`);
    const result = await runAgent({
      agent,
      prompt: job.fixture.prompt,
      dir,
      timeoutMs: opt('--timeout-ms') ? Number(opt('--timeout-ms')) : undefined,
      tags: { ...tags, fixture: job.fixture.id, rep: String(job.rep), bench: 'true' },
      traceId,
      phoenix: !has('--no-phoenix'),
    });
    const last = result.attempts[result.attempts.length - 1];
    const score = scoreAnswer(agent, result.answer, job.fixture.truth, last?.citations ?? []);
    rows.push({
      id: job.fixture.id,
      rep: job.rep,
      ok: result.ok,
      attempts: result.attempts.length,
      cost: result.costUsd,
      seconds: (Date.now() - t0) / 1000,
      iterations: result.attempts.reduce((n, a) => n + (a.footer?.iterations ?? 0), 0),
      score,
      errors: last?.errors ?? [],
    });
    results.push({ fixture: job.fixture, rep: job.rep, result });
    process.stderr.write(
      `✔ ${agent} ${job.fixture.id} rep ${job.rep}: ${result.ok ? 'ok' : 'FAILED'} $${result.costUsd.toFixed(4)} ${((Date.now() - t0) / 1000).toFixed(0)}s recall=${fmt(score.filesRecall)}\n`,
    );
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));

function fmt(v: number | null | boolean): string {
  if (v === null) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return v.toFixed(2);
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

rows.sort((a, b) => a.id.localeCompare(b.id) || a.rep - b.rep);
const okRows = rows.filter((r) => r.ok);
const summary = {
  agent,
  runs: rows.length,
  yield: rows.length ? okRows.length / rows.length : 0,
  fabrications: okRows.reduce((n, r) => n + r.score.citationsDropped, 0),
  filesRecallMean: mean(okRows.map((r) => r.score.filesRecall).filter((x): x is number => x !== null)),
  filesPrecisionMean: mean(okRows.map((r) => r.score.filesPrecision).filter((x): x is number => x !== null)),
  testsRecallMean: mean(okRows.map((r) => r.score.testsRecall).filter((x): x is number => x !== null)),
  typeAccuracy: mean(
    okRows
      .map((r) => r.score.typeOk)
      .filter((x): x is boolean => x !== null)
      .map(Number),
  ),
  costMedian: pct(
    rows.map((r) => r.cost),
    50,
  ),
  costMean: mean(rows.map((r) => r.cost)),
  secondsP50: pct(
    rows.map((r) => r.seconds),
    50,
  ),
  secondsP90: pct(
    rows.map((r) => r.seconds),
    90,
  ),
  retriesUsed: rows.filter((r) => r.attempts > 1).length,
};
const bars = {
  yield: summary.yield >= 0.9,
  fabrication: summary.fabrications === 0,
  recall: summary.filesRecallMean >= 0.6,
  cost: summary.costMedian <= 0.05,
  latency: summary.secondsP90 <= 240,
};
const pass = Object.values(bars).every(Boolean);

const table = [
  '| fixture | rep | ok | att | $ | s | iter | recall | prec | tests | type | cites (dropped) | errors |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.id} | ${r.rep} | ${r.ok ? '✔' : '✖'} | ${r.attempts} | ${r.cost.toFixed(4)} | ${r.seconds.toFixed(0)} | ${r.iterations} | ${fmt(r.score.filesRecall)} | ${fmt(r.score.filesPrecision)} | ${fmt(r.score.testsRecall)} | ${fmt(r.score.typeOk)} | ${r.score.citationsTotal} (${r.score.citationsDropped}) | ${r.errors.slice(0, 2).join('; ').replace(/\|/g, '/').slice(0, 120)} |`,
  ),
].join('\n');
const summaryLine = `runs ${summary.runs} · yield ${fmt(summary.yield)} · fabrications ${summary.fabrications} · recall ${fmt(summary.filesRecallMean)} · precision ${fmt(summary.filesPrecisionMean)} · tests ${fmt(summary.testsRecallMean)} · type ${fmt(summary.typeAccuracy)} · $ median ${summary.costMedian.toFixed(4)} mean ${summary.costMean.toFixed(4)} · s p50 ${summary.secondsP50.toFixed(0)} p90 ${summary.secondsP90.toFixed(0)} · retries ${summary.retriesUsed} · bars ${Object.entries(
  bars,
)
  .map(([k, v]) => `${k}:${v ? '✔' : '✖'}`)
  .join(' ')} → ${pass ? 'PASS' : 'FAIL'}`;

process.stdout.write(`${table}\n\n${summaryLine}\n`);
const runsDir = join(dir, '.mikro', 'runs');
mkdirSync(runsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(
  join(runsDir, `bench-${agent}-${stamp}.json`),
  JSON.stringify({ traceId, tags, summary, bars, rows, results }, null, 2),
);
if (has('--write-evidence')) {
  const evidence = join(dir, '.mikro', 'agents', agent, 'EVIDENCE.md');
  const header = existsSync(evidence)
    ? ''
    : `# ${agent} — evidence\n\nEvery row below is a real run recorded by \`scripts/mikro/bench.ts\`; nothing is estimated. Bars: yield ≥ 0.9, fabrications 0, recall ≥ 0.6, median cost ≤ $0.05, p90 ≤ 240 s.\n`;
  appendFileSync(
    evidence,
    `${header}\n## ${new Date().toISOString().slice(0, 16)}Z${tags.round ? ` — round ${tags.round}` : ''}${tags.note ? ` — ${tags.note}` : ''}\n\nmodel: deepseek-api/deepseek-flash · fixtures: ${fixtures.map((f) => f.id).join(', ')} · reps ${reps} · trace \`${traceId}\`\n\n${table}\n\n${summaryLine}\n`,
  );
}
process.exit(pass ? 0 : 1);
