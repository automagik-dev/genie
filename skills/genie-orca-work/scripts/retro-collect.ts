#!/usr/bin/env bun
/**
 * retro-collect — the genie-orca retro cost collector.
 *
 * Joins an Orca Run's tasks → dispatches → worker worktrees → the agent's own
 * session logs, and emits per-group tokens, wall-clock, outcome and fix-loop
 * counts. Every number carries the command that produced it, so a retro
 * council reasons over data, not vibes.
 *
 *   bun retro-collect.ts --run <run_id> [--orca <bin>] [--out RETRO.md] [--json]
 *
 * Sources (all read-only):
 *   orca orchestration task-list --json            → tasks (run-scoped by the bound Run)
 *   orca orchestration worker-list --json          → dispatches for the run (fallback: dispatch-show per task)
 *   orca orchestration worker-show --dispatch <id> → worktree_id, timings, status, failure_count
 *   ~/.claude/projects/<encoded worktree path>/*.jsonl → per-turn `usage` (Claude Code)
 *   ~/.codex/sessions/**.jsonl                     → per-turn usage (Codex; best effort)
 *
 * Orca receipts expose launch/timings/status only — no tokens. This join is the
 * only place the two meet. See council 2026-08-22 (brain .genie/brainstorms/genie-v6-corpo-leve/COUNCIL.md).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type Usage = {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  turns: number;
  models: Record<string, number>;
};

const args = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((acc, a, i, arr) => {
    if (a.startsWith('--'))
      acc.push([a.slice(2), arr[i + 1]?.startsWith('--') || arr[i + 1] === undefined ? 'true' : arr[i + 1]]);
    return acc;
  }, []),
);
const ORCA = args.orca ?? process.env.ORCA_CLI_COMMAND ?? 'orca';
const RUN = args.run;
if (!RUN) {
  console.error('usage: retro-collect --run <run_id> [--orca <bin>] [--out <file>] [--json]');
  process.exit(2);
}

async function orca(...argv: string[]): Promise<any> {
  const cmd = [ORCA, ...argv, '--json'];
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`${cmd.join(' ')}: no JSON in output`);
  const j = JSON.parse(out.slice(start));
  if (!j.ok) throw new Error(`${cmd.join(' ')}: ${j.error?.message ?? 'not ok'}`);
  return { result: j.result, cmd: cmd.join(' ') };
}

function encodeProjectPath(p: string): string {
  // Claude Code encodes the cwd by replacing every non [A-Za-z0-9] char with '-'.
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

function sumClaudeUsage(
  worktreePath: string,
  dispatchedAtIso?: string,
): { usage: Usage; files: string[]; first?: string; last?: string } {
  const dir = join(homedir(), '.claude', 'projects', encodeProjectPath(worktreePath));
  const usage: Usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, models: {} };
  const files: string[] = [];
  let first: string | undefined;
  let last: string | undefined;
  if (!existsSync(dir)) return { usage, files };
  // Attribution: Orca does not expose the agent session id, and several
  // dispatches can share one worktree (engineer → reviewer → fixer, or the
  // main worktree with the coordinator itself). A fresh agent terminal opens
  // a NEW session file right after dispatched_at, so pick the session whose
  // first record lands within the window [dispatched_at, +5 min] and is the
  // earliest such — never sum every file in the project dir.
  let candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f));
  if (dispatchedAtIso) {
    const t0 = Date.parse(dispatchedAtIso);
    const starts = candidates
      .map((full) => {
        const head = readFileSync(full, 'utf8').slice(0, 4000);
        const ts = head.match(/"timestamp":"([^"]+)"/)?.[1];
        return { full, t: ts ? Date.parse(ts) : Number.NaN };
      })
      .filter((c) => !Number.isNaN(c.t) && c.t >= t0 - 5_000 && c.t <= t0 + 300_000)
      .sort((a, b) => a.t - b.t);
    candidates = starts.length ? [starts[0].full] : [];
  }
  for (const full of candidates) {
    files.push(full);
    for (const line of readFileSync(full, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const u = rec?.message?.usage ?? rec?.usage;
      if (!u) continue;
      usage.input += u.input_tokens ?? 0;
      usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
      usage.cacheRead += u.cache_read_input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
      usage.turns += 1;
      const m = rec?.message?.model ?? 'unknown';
      usage.models[m] = (usage.models[m] ?? 0) + 1;
      const ts = rec?.timestamp;
      if (ts) {
        if (!first || ts < first) first = ts;
        if (!last || ts > last) last = ts;
      }
    }
  }
  return { usage, files, first, last };
}

function worktreePathFromId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const i = id.indexOf('::');
  return i >= 0 ? id.slice(i + 2) : id;
}

const provenance: string[] = [];
const tasks = await orca('orchestration', 'task-list');
provenance.push(tasks.cmd);
const taskRows: any[] = tasks.result.tasks ?? tasks.result;

let dispatches: any[] = [];
try {
  const wl = await orca('orchestration', 'worker-list');
  provenance.push(wl.cmd);
  dispatches = (wl.result.workers ?? wl.result.dispatches ?? wl.result) as any[];
} catch {
  /* fallback below */
}

type Row = {
  task: string;
  specHead: string;
  status: string;
  dispatch?: string;
  dispatchStatus?: string;
  failures: number;
  dispatchedAt?: string;
  completedAt?: string;
  wallMin?: number;
  worktree?: string;
  usage: Usage;
  sessionFiles: number;
};
const rows: Row[] = [];
for (const t of taskRows) {
  const row: Row = {
    task: t.id,
    specHead: String(t.spec ?? '')
      .split('\n')[0]
      .slice(0, 80),
    status: t.status,
    failures: 0,
    usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, models: {} },
    sessionFiles: 0,
  };
  let ds: any[] = dispatches.filter((d) => (d.task_id ?? d.dispatch?.task_id) === t.id);
  if (ds.length === 0) {
    try {
      const show = await orca('orchestration', 'dispatch-show', '--task', t.id);
      provenance.push(show.cmd);
      ds = [show.result.dispatch ? show.result : { dispatch: show.result }];
    } catch {
      ds = [];
    }
  }
  for (const d0 of ds) {
    const did = d0.dispatch?.id ?? d0.dispatch_id ?? d0.id;
    if (!did) continue;
    let show: any;
    try {
      const s = await orca('orchestration', 'worker-show', '--dispatch', did);
      provenance.push(s.cmd);
      show = s.result;
    } catch {
      continue;
    }
    const disp = show.dispatch ?? {};
    row.dispatch = did;
    row.dispatchStatus = disp.status;
    row.failures += disp.failure_count ?? 0;
    row.dispatchedAt = disp.dispatched_at;
    row.completedAt = disp.completed_at ?? undefined;
    const wt = worktreePathFromId(show.worker?.worktree_id);
    row.worktree = wt;
    if (wt) {
      const dispIso = row.dispatchedAt
        ? row.dispatchedAt.replace(' ', 'T') + (row.dispatchedAt.endsWith('Z') ? '' : 'Z')
        : undefined;
      const u = sumClaudeUsage(resolve(wt), dispIso);
      row.usage.input += u.usage.input;
      row.usage.cacheWrite += u.usage.cacheWrite;
      row.usage.cacheRead += u.usage.cacheRead;
      row.usage.output += u.usage.output;
      row.usage.turns += u.usage.turns;
      for (const [m, n] of Object.entries(u.usage.models)) row.usage.models[m] = (row.usage.models[m] ?? 0) + n;
      row.sessionFiles += u.files.length;
      if (!row.completedAt && u.last) row.completedAt = u.last; // still running: last turn seen
    }
    if (row.dispatchedAt && row.completedAt) {
      const a = Date.parse(row.dispatchedAt.replace(' ', 'T') + (row.dispatchedAt.endsWith('Z') ? '' : 'Z'));
      const b = Date.parse(row.completedAt);
      if (!Number.isNaN(a) && !Number.isNaN(b)) row.wallMin = Math.round(((b - a) / 60000) * 10) / 10;
    }
  }
  rows.push(row);
}

const total = rows.reduce(
  (acc, r) => {
    acc.input += r.usage.input;
    acc.cacheWrite += r.usage.cacheWrite;
    acc.cacheRead += r.usage.cacheRead;
    acc.output += r.usage.output;
    acc.turns += r.usage.turns;
    return acc;
  },
  { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0 },
);

const fmt = (n: number) => n.toLocaleString('en-US');
const md: string[] = [];
md.push(`# RETRO — Orca run \`${RUN}\``);
md.push('');
md.push(
  `Collected ${new Date().toISOString()} by \`retro-collect.ts\`. Tokens come from the agents' own session logs joined on the dispatch worktree; Orca receipts carry status/timings only.`,
);
md.push('');
md.push(
  '| task | spec | status | dispatch | disp.status | fails | wall (min) | turns | in | cache w | cache r | out | models |',
);
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  md.push(
    `| ${r.task.slice(-6)} | ${r.specHead.replace(/\|/g, '/')} | ${r.status} | ${r.dispatch?.slice(-6) ?? '—'} | ${r.dispatchStatus ?? '—'} | ${r.failures} | ${r.wallMin ?? '—'} | ${r.usage.turns} | ${fmt(r.usage.input)} | ${fmt(r.usage.cacheWrite)} | ${fmt(r.usage.cacheRead)} | ${fmt(r.usage.output)} | ${
      Object.entries(r.usage.models)
        .map(([m, n]) => `${m}×${n}`)
        .join(', ') || '—'
    } |`,
  );
}
md.push(
  `| **total** | | | | | | | ${total.turns} | ${fmt(total.input)} | ${fmt(total.cacheWrite)} | ${fmt(total.cacheRead)} | ${fmt(total.output)} | |`,
);
md.push('');
md.push('## Provenance (commands that produced the numbers)');
md.push('');
for (const c of [...new Set(provenance)]) md.push(`- \`${c}\``);
md.push(
  '- session logs: `~/.claude/projects/<encoded worktree path>/<session>.jsonl` — the session whose first record starts within 5 min after dispatched_at (Orca exposes no session id); per-turn `message.usage`',
);
md.push('');
md.push('## Gaps');
md.push('');
md.push('- Codex / third-model sessions are not joined yet (no worktree→session map for Codex on this host).');
md.push('- Cost in $ is not computed: price tables drift; multiply the token columns by the current model rates.');

const out = `${md.join('\n')}\n`;
if (args.json === 'true') {
  console.log(JSON.stringify({ run: RUN, rows, total, provenance }, null, 2));
} else if (args.out) {
  await Bun.write(args.out, out);
  console.log(`wrote ${args.out}`);
} else {
  console.log(out);
}
