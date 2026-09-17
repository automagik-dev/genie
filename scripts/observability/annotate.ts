#!/usr/bin/env bun
/**
 * Code annotator: per-session friction/waste metrics as Phoenix session annotations.
 *
 * Source of truth is the transcript on disk (the backfill's own parser), never an LLM.
 * Each annotation is upserted with identifier `code-annotator/v1` so re-runs update in place.
 * The pricing table version rides in the annotation metadata: one declared source for waste
 * dollars.
 *
 * Usage: bun scripts/observability/annotate.ts [--since <days>] [--dry-run] [<transcript.jsonl>...]
 *   With no transcripts, every `*.jsonl` under the Claude Code projects dir (HOME/.claude/projects)
 *   modified within --since days is annotated.
 * Env: PHOENIX_ENDPOINT (base URL, default http://127.0.0.1:6006), PHOENIX_API_KEY (optional)
 *
 * Annotate only after `backfill.ts --verify` reported the session fully inserted: Phoenix
 * answers 404 for a session whose first trace is not stored yet.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type ContentBlock, type TranscriptRecord, readJsonl } from './backfill.js';

export const ANNOTATOR_ID = 'code-annotator/v1';
export const PRICING_VERSION = 'phoenix-list-2026-09';
export const ANNOTATION_NAMES = [
  'polling_share',
  'tool_error_rate',
  'interrupts',
  'max_context',
  'compactions',
  'rework',
  'waste_usd',
  'total_usd',
] as const;
export type AnnotationName = (typeof ANNOTATION_NAMES)[number];

// USD per million tokens, Phoenix built-in table (cache_read / cache_write / input / output)
const PRICE: Record<string, [number, number, number, number]> = {
  'claude-fable-5': [1.0, 12.5, 10, 50],
  'claude-fable-5-1': [0.25, 12.5, 10, 50],
  'claude-opus-5': [0.5, 6.25, 5, 25],
  'claude-sonnet-5': [0.2, 2.5, 2, 10],
  'claude-opus-4-8': [0.5, 6.25, 5, 25],
};
const FALLBACK_PRICE: [number, number, number, number] = [0.5, 6.25, 5, 25];
/** A response whose every tool call is a Bash command of this shape is polling, not work. */
const POLL =
  /\bsleep\b|\buntil\b|\bwhile\b|\btail -n?\s*\d+\s+\/private\/tmp\/claude|\bcat\s+\/private\/tmp\/claude-\S+\/tasks\//;
const INTERRUPT = /\[Request interrupted by user/;
const NOT_HUMAN = /^\s*<(task-notification|local-command|bash-|command-)/;
const REPEAT_THRESHOLD = 4;

export function usd(model: string, cacheRead: number, cacheWrite: number, input: number, output: number): number {
  const p = PRICE[model] ?? FALLBACK_PRICE;
  return (cacheRead * p[0] + cacheWrite * p[1] + input * p[2] + output * p[3]) / 1e6;
}

export interface Metrics {
  responses: number;
  polling_responses: number;
  polling_share: number;
  tool_calls: number;
  tool_errors: number;
  tool_error_rate: number;
  interrupts: number;
  ask_user: number;
  max_context: number;
  compactions: number;
  repeated_commands: number;
  skill_reinvocations: number;
  total_usd: number;
  waste_usd: number;
  human_turns: number;
}

interface ResponseGroup {
  ctx: number;
  usd: number;
  tools: [string, string][];
}

interface FileState {
  groups: Map<string, ResponseGroup>;
  cmdCount: Map<string, number>;
  lastSkill: string | null;
}

const emptyMetrics = (): Metrics => ({
  responses: 0,
  polling_responses: 0,
  polling_share: 0,
  tool_calls: 0,
  tool_errors: 0,
  tool_error_rate: 0,
  interrupts: 0,
  ask_user: 0,
  max_context: 0,
  compactions: 0,
  repeated_commands: 0,
  skill_reinvocations: 0,
  total_usd: 0,
  waste_usd: 0,
  human_turns: 0,
});

const blocks = (content: unknown): ContentBlock[] =>
  Array.isArray(content) ? (content.filter((b) => b && typeof b === 'object') as ContentBlock[]) : [];

function measureUser(m: Metrics, r: TranscriptRecord, isMain: boolean): void {
  const c = r.message?.content;
  const list = blocks(c);
  const text =
    typeof c === 'string'
      ? c
      : list
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
  const hasToolResult = list.some((b) => b.type === 'tool_result');
  if (INTERRUPT.test(text)) m.interrupts++;
  else if (isMain && !hasToolResult && (typeof c === 'string' || Array.isArray(c)) && !NOT_HUMAN.test(text)) {
    m.human_turns++;
  }
  for (const b of list) if (b.type === 'tool_result' && b.is_error) m.tool_errors++;
}

function measureAssistant(m: Metrics, r: TranscriptRecord, state: FileState, skillRuns: Map<string, number>): void {
  const msg = r.message ?? {};
  const id = msg.id as string;
  const g = state.groups.get(id) ?? { ctx: 0, usd: 0, tools: [] };
  if (!state.groups.has(id)) {
    const u = msg.usage ?? {};
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    g.ctx = (u.input_tokens ?? 0) + cacheRead + cacheWrite;
    g.usd = usd(msg.model ?? '', cacheRead, cacheWrite, u.input_tokens ?? 0, u.output_tokens ?? 0);
  }
  const sk = r.attributionSkill ?? null;
  if (sk && sk !== state.lastSkill) skillRuns.set(sk, (skillRuns.get(sk) ?? 0) + 1);
  if (sk) state.lastSkill = sk;
  for (const b of blocks(msg.content)) {
    if (b.type !== 'tool_use') continue;
    const command = b.name === 'Bash' ? String(b.input?.command ?? '') : '';
    g.tools.push([b.name ?? '', command]);
    if (b.name === 'AskUserQuestion') m.ask_user++;
    if (b.name === 'Bash') {
      const k = command.trim();
      state.cmdCount.set(k, (state.cmdCount.get(k) ?? 0) + 1);
    }
  }
  state.groups.set(id, g);
}

function foldFile(m: Metrics, state: FileState): void {
  for (const g of state.groups.values()) {
    m.responses++;
    m.tool_calls += g.tools.length;
    m.max_context = Math.max(m.max_context, g.ctx);
    m.total_usd += g.usd;
    if (g.tools.length > 0 && g.tools.every(([n, cmd]) => n === 'Bash' && POLL.test(cmd))) {
      m.polling_responses++;
      m.waste_usd += g.usd;
    }
  }
  for (const n of state.cmdCount.values()) if (n >= REPEAT_THRESHOLD) m.repeated_commands += n;
}

/** Metrics for one session: the main transcript plus every `<session>/subagents/*.jsonl`. */
export function measure(mainPath: string): Metrics {
  const files = [mainPath];
  const subDir = mainPath.replace(/\.jsonl$/, '/subagents');
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir).sort()) if (f.endsWith('.jsonl')) files.push(join(subDir, f));
  }
  const m = emptyMetrics();
  const skillRuns = new Map<string, number>();
  for (const f of files) {
    const state: FileState = { groups: new Map(), cmdCount: new Map(), lastSkill: null };
    for (const r of readJsonl(f)) {
      if (r.type === 'system' && r.subtype === 'compact_boundary') m.compactions++;
      if (r.type === 'user' && !r.isMeta) measureUser(m, r, f === mainPath);
      if (r.type === 'assistant' && r.message?.id) measureAssistant(m, r, state, skillRuns);
    }
    foldFile(m, state);
  }
  for (const n of skillRuns.values()) if (n > 1) m.skill_reinvocations += n - 1;
  m.polling_share = m.responses ? m.polling_responses / m.responses : 0;
  m.tool_error_rate = m.tool_calls ? m.tool_errors / m.tool_calls : 0;
  return m;
}

export interface AnnotationRow {
  session_id: string;
  name: AnnotationName;
  annotator_kind: 'CODE';
  identifier: typeof ANNOTATOR_ID;
  result: { score: number; label: string; explanation: null };
  metadata: Record<string, string | number>;
}

/** The eight session annotations, in ANNOTATION_NAMES order. */
export function annotationRows(sessionId: string, metrics: Metrics): AnnotationRow[] {
  const rework = metrics.repeated_commands + metrics.skill_reinvocations;
  const results: Record<AnnotationName, { score: number; label: string }> = {
    polling_share: { score: +metrics.polling_share.toFixed(4), label: metrics.polling_share > 0.05 ? 'high' : 'ok' },
    tool_error_rate: {
      score: +metrics.tool_error_rate.toFixed(4),
      label: metrics.tool_error_rate > 0.1 ? 'high' : 'ok',
    },
    interrupts: { score: metrics.interrupts, label: metrics.interrupts > 0 ? 'interrupted' : 'clean' },
    max_context: { score: metrics.max_context, label: metrics.max_context > 500_000 ? 'bloated' : 'ok' },
    compactions: { score: metrics.compactions, label: metrics.compactions > 0 ? 'compacted' : 'none' },
    rework: { score: rework, label: rework > 20 ? 'high' : 'ok' },
    waste_usd: { score: +metrics.waste_usd.toFixed(2), label: metrics.waste_usd > 5 ? 'high' : 'ok' },
    total_usd: { score: +metrics.total_usd.toFixed(2), label: PRICING_VERSION },
  };
  const metadata = { pricing_version: PRICING_VERSION, annotator: ANNOTATOR_ID, ...metrics };
  return ANNOTATION_NAMES.map((name) => ({
    session_id: sessionId,
    name,
    annotator_kind: 'CODE',
    identifier: ANNOTATOR_ID,
    result: { ...results[name], explanation: null },
    metadata,
  }));
}

async function upsert(sessionId: string, metrics: Metrics, dryRun: boolean): Promise<void> {
  const rows = annotationRows(sessionId, metrics);
  if (dryRun) {
    console.log(sessionId.slice(0, 8), JSON.stringify(metrics));
    return;
  }
  const base = (process.env.PHOENIX_ENDPOINT ?? 'http://127.0.0.1:6006').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.PHOENIX_API_KEY) headers.authorization = `Bearer ${process.env.PHOENIX_API_KEY}`;
  const res = await fetch(`${base}/v1/session_annotations?sync=true`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: rows }),
  });
  const text = await res.text();
  console.log(
    `${sessionId.slice(0, 8)} ${res.status} polling=${metrics.polling_share.toFixed(3)} errors=${metrics.tool_error_rate.toFixed(3)} waste=$${metrics.waste_usd.toFixed(2)} total=$${metrics.total_usd.toFixed(2)}${res.ok ? '' : ` ${text.slice(0, 200)}`}`,
  );
}

function recentTranscripts(sinceDays: number): string[] {
  const root = join(process.env.HOME ?? '', '.claude', 'projects');
  if (!existsSync(root)) return [];
  const cutoff = Date.now() - sinceDays * 86_400_000;
  const files: string[] = [];
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.jsonl') && statSync(join(dir, f)).mtimeMs >= cutoff) files.push(join(dir, f));
    }
  }
  return files;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sinceIdx = args.indexOf('--since');
  const sinceDays = sinceIdx >= 0 ? Number(args[sinceIdx + 1]) : Number.POSITIVE_INFINITY;
  const given = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--since');
  const files = given.length > 0 ? given : recentTranscripts(sinceDays);
  for (const f of files) {
    const sessionId = readJsonl(f).find((r) => r.sessionId)?.sessionId ?? basename(f, '.jsonl');
    const metrics = measure(f);
    if (metrics.responses === 0) continue;
    await upsert(sessionId, metrics, dryRun);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`annotate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
