#!/usr/bin/env bun
/**
 * Claude Code transcript -> Phoenix backfill.
 *
 * Reads a Claude Code session transcript `<session>.jsonl` (plus `<session>/subagents/*.jsonl`)
 * and posts OpenInference-shaped spans to POST /v1/projects/<project>/spans with ORIGINAL
 * timestamps and DETERMINISTIC ids (sha256 of record uuids), so a re-run produces
 * byte-identical spans and Phoenix rejects the duplicate batch instead of double-ingesting.
 *
 * Tree (one trace per user turn):
 *   turn (CHAIN)                          session.id, user.id, metadata.*, friction counters
 *   └─ skill:<name> (AGENT)               contiguous run of attributionSkill inside the turn
 *      └─ <model> (LLM)                   one per API response (records grouped by message.id)
 *         └─ <tool> (TOOL)                tool_use -> tool_result, ERROR on is_error
 *            └─ subagent:<type> (AGENT)   reconstructed from subagents/agent-*.jsonl
 *
 * Usage: bun scripts/observability/backfill.ts [--project <name>] [--content metadata|head|full]
 *          [--dry-run] [--replace | --incremental] [--verify [--verify-timeout S]]
 *          [--batch N] [--pace-ms N] [--limit-turns N] <transcript.jsonl | session-dir>...
 *   --dry-run     convert and print the per-session span count; post nothing
 *   --replace     delete the session's stored traces first, then post
 *   --incremental post only the spans Phoenix does not hold yet (safe to re-run after every turn)
 *   --verify      after posting, wait until Phoenix has INSERTED every span (202 means queued,
 *                 not stored); exit 1 on shortfall
 * Env: PHOENIX_ENDPOINT (base URL), PHOENIX_API_KEY (optional), BACKFILL_USER_ID (default $USER)
 *
 * Projects are named cc-<repo> (see projectNameFor). See scripts/observability/README.md for
 * the ingestion semantics every mode relies on.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { scanRepoSkills } from '../skills-inventory-parity.js';

// ---------- limits ----------
// base limits; --content full multiplies them by 8, still under Phoenix's attribute ceiling
const TEXT_MAX = 8_000;
const TOOL_IN_MAX = 4_000;
const TOOL_OUT_MAX = 4_000;
const DEFAULT_BATCH = 400;
const MAX_DEPTH = 4;
const EPOCH = '1970-01-01T00:00:00Z';
/** Postgres text columns reject NUL. Built from a char code so no raw NUL ever sits in this file. */
const NUL = String.fromCharCode(0);

// ---------- transcript types ----------
export interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}
interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}
export interface TranscriptMessage {
  id?: string;
  role?: string;
  model?: string;
  usage?: Usage;
  stop_reason?: string;
  content?: string | ContentBlock[];
}
export interface TranscriptRecord {
  type?: string;
  subtype?: string;
  uuid?: string;
  sessionId?: string;
  promptId?: string;
  timestamp?: string;
  message?: TranscriptMessage;
  attributionSkill?: string;
  isMeta?: boolean;
  origin?: { kind?: string };
  promptSource?: string;
  requestId?: string;
  effort?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  permissionMode?: string;
  entrypoint?: string;
  aiTitle?: string;
}

type AttributeValue = string | number | boolean | string[];
export interface Span {
  name: string;
  context: { trace_id: string; span_id: string };
  parent_id: string | null;
  span_kind: 'CHAIN' | 'LLM' | 'TOOL' | 'AGENT';
  start_time: string;
  end_time: string;
  status_code: 'OK' | 'ERROR' | 'UNSET';
  status_message?: string;
  attributes: Record<string, AttributeValue>;
}

// ---------- content profile ----------
// metadata: no prompt text, no tool args, no tool output — names, counts, tokens, bash first token only
// head:     bounded, scrubbed head of prompts / assistant text / tool args / tool output (+ length + sha256)
// full:     same as head with the limits raised 8x (still scrubbed); per-project opt-in only
export type ContentLevel = 'metadata' | 'head' | 'full';
const CONTENT_LEVELS: readonly ContentLevel[] = ['metadata', 'head', 'full'];
let CONTENT: ContentLevel = 'metadata';
/** Test and CLI hook: the active content profile. */
export function setContentLevel(level: ContentLevel): void {
  CONTENT = level;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{32,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{40,}/g,
  /xox[abpr]-[A-Za-z0-9-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g,
  /(Bearer\s+)[A-Za-z0-9._-]{20,}/gi,
  /((?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*["']?)[A-Za-z0-9._\-/+]{12,}/gi,
];

/** Remove every NUL. Postgres text rejects it; binary-ish tool output (images, archives) carries it. */
export function stripNul(s: string): string {
  return s.includes(NUL) ? s.split(NUL).join('') : s;
}

export function scrub(s: string): string {
  let out = stripNul(s);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, keep?: string) => `${typeof keep === 'string' ? keep : ''}[REDACTED]`);
  }
  return out;
}

// ---------- skill roster ----------
const REPO_ROOT = join(import.meta.dir, '..', '..');

/** Genie's shipped skills, derived from skills/<name>/SKILL.md — never hand-listed. */
export function genieSkillRoster(repoRoot: string = REPO_ROOT): string[] {
  return scanRepoSkills(repoRoot).names;
}

let rosterCache: ReadonlySet<string> | null = null;
function roster(): ReadonlySet<string> {
  if (rosterCache === null) rosterCache = new Set(genieSkillRoster());
  return rosterCache;
}

/** Canonical skill name: a bare shipped genie skill name is the same skill as `genie:<name>`. */
export function canonicalSkill(name: string | null | undefined): string | null {
  if (!name) return null;
  return roster().has(name) ? `genie:${name}` : name;
}

// ---------- helpers ----------
const hex = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);
const traceId = (s: string) => hex(`trace:${s}`, 32);
const spanId = (s: string) => hex(`span:${s}`, 16);
const sha = (s: string) => hex(s, 16);

/** Bounded, scrubbed content under the active profile. Returns '' at the metadata level. */
function clip(s: string, n: number): string {
  if (CONTENT === 'metadata') return '';
  const limit = CONTENT === 'full' ? n * 8 : n;
  const scrubbed = scrub(s);
  if (scrubbed.length <= limit) return scrubbed;
  return `${scrubbed.slice(0, limit)}\n…[truncated ${scrubbed.length - limit} chars, sha256:${sha(s)}]`;
}
const orderTimes = (a: string, b: string): [string, string] => (new Date(b) < new Date(a) ? [a, a] : [a, b]);

function blocksOf(content: unknown): ContentBlock[] {
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === 'object') as ContentBlock[]) : [];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksOf(content)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: ContentBlock | null) => (b?.type === 'text' ? String(b.text ?? '') : JSON.stringify(b)))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

const field = (input: Record<string, unknown>, key: string): string => {
  const v = input[key];
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
};

function renderQuestions(input: Record<string, unknown>): string {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return questions
    .map((q: { question?: string; options?: { label?: string }[] }) => {
      const labels = (q.options ?? []).map((o) => o.label ?? '').join(' | ');
      return `${q.question ?? ''}\n  ${labels}`;
    })
    .join('\n');
}

/** Human-readable rendering of a tool call's input — never a raw JSON dump. */
export function renderToolInput(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const f = (key: string) => field(i, key);
  switch (name) {
    case 'Bash':
      return f('description') ? `# ${f('description')}\n${f('command')}` : f('command');
    case 'Read': {
      const range = i.offset != null ? ` (offset ${f('offset')}${i.limit != null ? `, limit ${f('limit')}` : ''})` : '';
      return `${f('file_path') || f('path')}${range}`;
    }
    case 'Edit':
      return `${f('file_path')}\n--- old\n${f('old_string')}\n+++ new\n${f('new_string')}`;
    case 'Write':
      return `${f('file_path')}\n${f('content')}`;
    case 'Grep':
      return `pattern: ${f('pattern')}${f('path') ? `\npath: ${f('path')}` : ''}${f('glob') ? `\nglob: ${f('glob')}` : ''}`;
    case 'Glob':
      return `${f('pattern')}${f('path') ? `\nin ${f('path')}` : ''}`;
    case 'Agent':
      return `${f('subagent_type') || 'agent'}: ${f('description')}\n\n${f('prompt')}`;
    case 'Skill':
      return `${f('skill')}${f('args') ? ` ${f('args')}` : ''}`;
    case 'SendMessage':
      return `to ${f('to')}\n${f('message')}`;
    case 'WebFetch':
      return `${f('url')}\n${f('prompt')}`;
    case 'AskUserQuestion':
      return renderQuestions(i);
    default:
      return Object.keys(i)
        .map((k) => `${k}: ${f(k)}`)
        .join('\n');
  }
}

export function bashHead(cmd: string): string {
  const c = cmd
    .trim()
    .replace(/^(cd\s+\S+\s*(&&|;)\s*)+/, '')
    .replace(/^([A-Z_]+=\S+\s+)+/, '');
  const m = /^([\w./-]+)/.exec(c);
  return m ? (m[1] as string) : '?';
}

/** Parse a transcript, skipping malformed lines and records a resumed session re-appended. */
export function readJsonl(path: string): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  const seen = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: TranscriptRecord;
    try {
      r = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue; // fail-soft: skip malformed line
    }
    if (!r || typeof r !== 'object') continue;
    if (r.uuid) {
      if (seen.has(r.uuid)) continue;
      seen.add(r.uuid);
    }
    out.push(r);
  }
  return out;
}

// ---------- subagent index ----------
interface SubagentRef {
  jsonl: string;
  agentType: string;
  description: string;
  name: string;
  teamName: string;
  toolUseId?: string;
  /** promptId of the parent turn, read from the subagent's first record */
  promptId?: string;
  startTs?: string;
  used?: boolean;
}
interface SubagentIndex {
  byToolUse: Map<string, SubagentRef>;
  byPrompt: Map<string, SubagentRef[]>;
  all: SubagentRef[];
}
interface SubagentMeta {
  agentType?: string;
  description?: string;
  name?: string;
  teamName?: string;
  toolUseId?: string;
}

function readSubagentRef(dir: string, metaFile: string): SubagentRef | null {
  const jsonl = join(dir, metaFile.replace(/\.meta\.json$/, '.jsonl'));
  if (!existsSync(jsonl)) return null;
  let meta: SubagentMeta;
  try {
    meta = JSON.parse(readFileSync(join(dir, metaFile), 'utf8')) as SubagentMeta;
  } catch {
    return null;
  }
  const ref: SubagentRef = {
    jsonl,
    agentType: meta.agentType ?? 'unknown',
    description: meta.description ?? '',
    name: meta.name ?? '',
    teamName: meta.teamName ?? '',
    toolUseId: meta.toolUseId,
  };
  // first record carries the parent turn's promptId + the start timestamp
  const firstLine = readFileSync(jsonl, 'utf8')
    .split('\n')
    .find((l) => l.trim());
  if (firstLine) {
    try {
      const first = JSON.parse(firstLine) as TranscriptRecord;
      ref.promptId = first.promptId;
      ref.startTs = first.timestamp;
    } catch {
      /* first record unreadable: the ref links by tool use or not at all */
    }
  }
  return ref;
}

function indexSubagents(sessionDir: string): SubagentIndex {
  const idx: SubagentIndex = { byToolUse: new Map(), byPrompt: new Map(), all: [] };
  const dir = join(sessionDir, 'subagents');
  if (!existsSync(dir)) return idx;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.meta.json')) continue;
    const ref = readSubagentRef(dir, f);
    if (!ref) continue;
    idx.all.push(ref);
    if (ref.toolUseId) idx.byToolUse.set(ref.toolUseId, ref);
    else if (ref.promptId) {
      const list = idx.byPrompt.get(ref.promptId) ?? [];
      list.push(ref);
      idx.byPrompt.set(ref.promptId, list);
    }
  }
  return idx;
}

/** Classify what produced a "user" record so analytics can separate human turns from system injections. */
export function promptKind(r: TranscriptRecord, text: string): string {
  const origin = r.origin?.kind;
  if (origin === 'task-notification' || /^\s*<task-notification>/.test(text)) return 'task-notification';
  if (origin === 'channel' || /^\s*<channel\b/.test(text)) return 'channel';
  if (origin === 'peer' || /^\s*<teammate-message/.test(text)) return 'peer';
  if (origin === 'auto-continuation') return 'auto-continuation';
  if (r.isMeta) return 'system';
  if (/^\s*<command-name>/.test(text)) return 'command';
  if (/^\s*<(local-command-stdout|bash-input|bash-stdout|command-message)/.test(text)) return 'local-command';
  if (/^\s*\[Request interrupted by user/.test(text)) return 'interrupt';
  if (r.promptSource === 'sdk') return 'sdk';
  return 'human';
}

// ---------- core builder ----------
export interface ConvertStats {
  turns: number;
  llm: number;
  tools: number;
  skills: number;
  subagents: number;
  toolErrors: number;
}
export interface Ctx {
  sessionId: string;
  project: string;
  userId: string;
  subagents: SubagentIndex;
  spans: Span[];
  stats: ConvertStats;
}

interface Body {
  llmCount: number;
  toolCount: number;
  toolErrors: number;
  askUser: number;
  lastText: string;
  lastTs: string;
  models: Set<string>;
  skills: Set<string>;
}

interface ToolResult {
  rec: TranscriptRecord;
  block: ContentBlock;
}

interface Group {
  id: string;
  recs: TranscriptRecord[];
  skill: string | null;
  prevTs: string;
}

interface Scope {
  ctx: Ctx;
  trace: string;
  depth: number;
  scope: string;
  body: Body;
  results: Map<string, ToolResult>;
}

const newStats = (): ConvertStats => ({ turns: 0, llm: 0, tools: 0, skills: 0, subagents: 0, toolErrors: 0 });

function indexToolResults(records: TranscriptRecord[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const r of records) {
    if (r.type !== 'user') continue;
    for (const b of blocksOf(r.message?.content)) {
      if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, { rec: r, block: b });
    }
  }
  return results;
}

/** Group assistant records by message.id (Claude Code writes one record per content block). */
function groupResponses(records: TranscriptRecord[], startTs: string, body: Body): Group[] {
  const groups: Group[] = [];
  let prevTs = startTs;
  for (const r of records) {
    if (r.type === 'assistant' && r.message) {
      const id = r.message.id ?? r.uuid ?? '';
      const last = groups[groups.length - 1];
      if (last && last.id === id) last.recs.push(r);
      else groups.push({ id, recs: [r], skill: canonicalSkill(r.attributionSkill), prevTs });
    }
    if (r.timestamp) prevTs = r.timestamp;
    if (r.type === 'user' && blocksOf(r.message?.content).some((b) => b.type === 'tool_result')) {
      body.lastTs = r.timestamp ?? body.lastTs;
    }
  }
  return groups;
}

function openSkillSpan(s: Scope, g: Group, parentId: string, skill: string): Span {
  const first = g.recs[0] as TranscriptRecord;
  s.ctx.stats.skills++;
  s.body.skills.add(skill);
  return {
    name: `skill:${skill}`,
    context: { trace_id: s.trace, span_id: spanId(`skill:${s.ctx.sessionId}:${s.scope}:${first.uuid}`) },
    parent_id: parentId,
    span_kind: 'AGENT',
    start_time: g.prevTs,
    end_time: g.prevTs,
    status_code: 'OK',
    attributes: {
      'openinference.span.kind': 'AGENT',
      'session.id': s.ctx.sessionId,
      'user.id': s.ctx.userId,
      'metadata.skill': skill,
      'metadata.project': s.ctx.project,
      'tag.tags': ['skill', skill],
    },
  };
}

function emitLlm(s: Scope, g: Group, parentId: string): Span {
  const first = g.recs[0] as TranscriptRecord;
  const lastRec = g.recs[g.recs.length - 1] as TranscriptRecord;
  const msg = first.message ?? {};
  const usage = msg.usage ?? {};
  const model = msg.model ?? 'unknown';
  const [s0, s1] = orderTimes(g.prevTs, lastRec.timestamp ?? g.prevTs);
  const text = textOf(g.recs.flatMap((r) => blocksOf(r.message?.content)));
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const prompt = input + cacheRead + cacheWrite;
  const llm: Span = {
    name: model,
    context: { trace_id: s.trace, span_id: spanId(`llm:${s.ctx.sessionId}:${s.scope}:${g.id}`) },
    parent_id: parentId,
    span_kind: 'LLM',
    start_time: s0,
    end_time: s1,
    status_code: 'OK',
    attributes: {
      'openinference.span.kind': 'LLM',
      'session.id': s.ctx.sessionId,
      'user.id': s.ctx.userId,
      'llm.model_name': model,
      'llm.provider': 'anthropic',
      'llm.system': 'anthropic',
      'llm.token_count.prompt': prompt,
      'llm.token_count.completion': output,
      'llm.token_count.total': prompt + output,
      'llm.token_count.prompt_details.cache_read': cacheRead,
      'llm.token_count.prompt_details.cache_write': cacheWrite,
      'llm.token_count.completion_details.reasoning': usage.output_tokens_details?.thinking_tokens ?? 0,
      'output.value': clip(text, TEXT_MAX),
      'output.mime_type': 'text/plain',
      'metadata.request_id': first.requestId ?? '',
      'metadata.stop_reason': msg.stop_reason ?? '',
      'metadata.effort': first.effort ?? '',
      'metadata.skill': g.skill ?? '',
      'metadata.project': s.ctx.project,
      'metadata.context_tokens': prompt,
    },
  };
  s.ctx.spans.push(llm);
  s.ctx.stats.llm++;
  s.body.llmCount++;
  s.body.models.add(model);
  if (text) s.body.lastText = text;
  s.body.lastTs = s1;
  return llm;
}

function emitTool(s: Scope, g: Group, llm: Span, b: ContentBlock, skillSpan: Span | null): void {
  const toolName = b.name ?? 'unknown';
  const toolUseId = b.id ?? '';
  const res = s.results.get(toolUseId);
  const [t0, t1] = orderTimes(llm.end_time, res?.rec.timestamp ?? llm.end_time);
  const isErr = Boolean(res?.block.is_error);
  const inputText = renderToolInput(toolName, b.input);
  const outText = resultText(res?.block.content);
  const toolSpanId = spanId(`tool:${s.ctx.sessionId}:${s.scope}:${toolUseId}`);
  const attrs: Span['attributes'] = {
    'openinference.span.kind': 'TOOL',
    'session.id': s.ctx.sessionId,
    'user.id': s.ctx.userId,
    'tool.name': toolName,
    'input.value': clip(inputText, TOOL_IN_MAX),
    'input.mime_type': 'text/plain',
    'output.value': clip(outText, TOOL_OUT_MAX),
    'output.mime_type': 'text/plain',
    'metadata.tool_use_id': toolUseId,
    'metadata.input_chars': inputText.length,
    'metadata.output_chars': outText.length,
    'metadata.skill': g.skill ?? '',
    'metadata.project': s.ctx.project,
  };
  const command = b.input?.command;
  if (toolName === 'Bash' && typeof command === 'string') attrs['metadata.bash_head'] = bashHead(command);
  if (toolName === 'Skill' && b.input?.skill)
    attrs['metadata.skill_invoked'] = canonicalSkill(String(b.input.skill)) ?? '';
  if (toolName === 'Agent') attrs['metadata.subagent_type'] = String(b.input?.subagent_type ?? '');
  if (toolName === 'AskUserQuestion') s.body.askUser++;
  const tool: Span = {
    name: toolName,
    context: { trace_id: s.trace, span_id: toolSpanId },
    parent_id: llm.context.span_id,
    span_kind: 'TOOL',
    start_time: t0,
    end_time: t1,
    status_code: isErr ? 'ERROR' : res ? 'OK' : 'UNSET',
    attributes: attrs,
  };
  if (isErr) {
    tool.status_message = clip(outText, 300);
    s.body.toolErrors++;
    s.ctx.stats.toolErrors++;
  }
  s.ctx.spans.push(tool);
  s.ctx.stats.tools++;
  s.body.toolCount++;
  if (skillSpan && new Date(t1) > new Date(skillSpan.end_time)) skillSpan.end_time = t1;
  if (new Date(t1) > new Date(s.body.lastTs)) s.body.lastTs = t1;

  const sub = s.ctx.subagents.byToolUse.get(toolUseId);
  if (sub && !sub.used && s.depth < MAX_DEPTH) {
    emitSubagent(s.ctx, sub, s.trace, toolSpanId, t0, s.depth + 1, 'tool_use_id');
  }
}

/**
 * Emit LLM/TOOL/skill spans for a run of records that belong to one parent span.
 * `records` are the records of a turn (or a whole subagent transcript) in order.
 */
function emitBody(
  ctx: Ctx,
  records: TranscriptRecord[],
  trace: string,
  parentId: string,
  startTs: string,
  depth: number,
  scope = '',
): Body {
  const body: Body = {
    llmCount: 0,
    toolCount: 0,
    toolErrors: 0,
    askUser: 0,
    lastText: '',
    lastTs: startTs,
    models: new Set(),
    skills: new Set(),
  };
  const s: Scope = { ctx, trace, depth, scope, body, results: indexToolResults(records) };
  const groups = groupResponses(records, startTs, body);

  // skill runs: contiguous groups sharing attributionSkill
  let currentSkill: string | null = null;
  let skillSpan: Span | null = null;
  for (const g of groups) {
    if ((g.recs[0]?.message?.model ?? 'unknown') === '<synthetic>') continue; // Claude Code's own notices
    if (g.skill !== currentSkill) {
      if (skillSpan) ctx.spans.push(skillSpan);
      currentSkill = g.skill;
      skillSpan = g.skill ? openSkillSpan(s, g, parentId, g.skill) : null;
    }
    const llm = emitLlm(s, g, skillSpan ? skillSpan.context.span_id : parentId);
    if (skillSpan) skillSpan.end_time = llm.end_time;
    for (const r of g.recs) {
      for (const b of blocksOf(r.message?.content)) if (b.type === 'tool_use') emitTool(s, g, llm, b, skillSpan);
    }
  }
  if (skillSpan) ctx.spans.push(skillSpan);
  return body;
}

type LinkedBy = 'tool_use_id' | 'prompt_id' | 'time' | 'unlinked';

function emitSubagent(
  ctx: Ctx,
  sub: SubagentRef,
  trace: string,
  parentId: string,
  startTs: string,
  depth: number,
  linkedBy: LinkedBy,
): Span | null {
  sub.used = true;
  const recs = readJsonl(sub.jsonl);
  if (recs.length === 0) return null;
  const first = recs.find((r) => r.timestamp)?.timestamp ?? startTs;
  const agentSpanId = spanId(`subagent:${ctx.sessionId}:${basename(sub.jsonl)}`);
  const prompt = textOf(recs.find((r) => r.type === 'user')?.message?.content);
  const body = emitBody(ctx, recs, trace, agentSpanId, first, depth, basename(sub.jsonl));
  const span: Span = {
    name: `subagent:${sub.agentType}`,
    context: { trace_id: trace, span_id: agentSpanId },
    parent_id: parentId,
    span_kind: 'AGENT',
    start_time: first,
    end_time: body.lastTs,
    status_code: 'OK',
    attributes: {
      'openinference.span.kind': 'AGENT',
      'session.id': ctx.sessionId,
      'user.id': ctx.userId,
      'input.value': clip(prompt, TEXT_MAX),
      'input.mime_type': 'text/plain',
      'output.value': clip(body.lastText, TEXT_MAX),
      'output.mime_type': 'text/plain',
      'metadata.subagent_type': sub.agentType,
      'metadata.subagent_name': sub.name,
      'metadata.team': sub.teamName,
      'metadata.description': sub.description,
      'metadata.linked_by': linkedBy,
      'metadata.project': ctx.project,
      'metadata.llm_calls': body.llmCount,
      'metadata.tool_calls': body.toolCount,
      'metadata.tool_errors': body.toolErrors,
      'tag.tags': ['subagent', sub.agentType],
    },
  };
  ctx.spans.push(span);
  ctx.stats.subagents++;
  return span;
}

/**
 * A turn starts at any user record that is not a tool result and not a local-command echo.
 * `isMeta` alone does NOT exclude a record: channel, peer (teammate) and auto-continuation
 * messages are marked isMeta and drive whole sessions. promptKind() keeps them distinguishable.
 */
function isTurnStart(r: TranscriptRecord): boolean {
  if (r.type !== 'user') return false;
  const c = r.message?.content;
  if (typeof c !== 'string' && !Array.isArray(c)) return false;
  if (blocksOf(c).some((b) => b.type === 'tool_result')) return false;
  return !/^\s*<(local-command-caveat|local-command-stdout|bash-input|bash-stdout)/.test(textOf(c));
}

const INTERRUPT = /\[Request interrupted by user/;

function attachLooseSubagents(
  ctx: Ctx,
  prompt: TranscriptRecord,
  trace: string,
  turnSpanId: string,
  window: [string, string | undefined],
): void {
  const [startTs, nextStart] = window;
  // subagents that name this turn's promptId but carried no tool_use id (teams, workflows, forks)
  for (const sub of ctx.subagents.byPrompt.get(prompt.promptId ?? '') ?? []) {
    if (!sub.used) emitSubagent(ctx, sub, trace, turnSpanId, sub.startTs ?? startTs, 1, 'prompt_id');
  }
  // subagents with neither link: attach by start time to the turn that was running
  for (const sub of ctx.subagents.all) {
    if (sub.used || !sub.startTs) continue;
    if (sub.startTs >= startTs && (!nextStart || sub.startTs < nextStart)) {
      emitSubagent(ctx, sub, trace, turnSpanId, sub.startTs, 1, 'time');
    }
  }
}

function emitTurn(ctx: Ctx, recs: TranscriptRecord[], k: number, a: number, b: number, title: string): void {
  const prompt = recs[a] as TranscriptRecord;
  const turnRecs = recs.slice(a, b);
  const key = `${ctx.sessionId}:${prompt.uuid ?? a}`;
  const trace = traceId(key);
  const turnSpanId = spanId(`turn:${key}`);
  const startTs = prompt.timestamp ?? EPOCH;
  const promptText = textOf(prompt.message?.content);
  const kind = promptKind(prompt, promptText);
  const body = emitBody(ctx, turnRecs, trace, turnSpanId, startTs, 0);
  attachLooseSubagents(ctx, prompt, trace, turnSpanId, [startTs, recs[b]?.timestamp]);
  const subEnd = ctx.spans
    .filter((s) => s.parent_id === turnSpanId && s.span_kind === 'AGENT')
    .reduce((m, s) => (s.end_time > m ? s.end_time : m), body.lastTs);
  const [t0, t1] = orderTimes(startTs, subEnd);
  const interrupted = INTERRUPT.test(promptText) || turnRecs.some((r) => INTERRUPT.test(textOf(r.message?.content)));
  const skills = [...body.skills];
  ctx.spans.push({
    name: 'turn',
    context: { trace_id: trace, span_id: turnSpanId },
    parent_id: null,
    span_kind: 'CHAIN',
    start_time: t0,
    end_time: t1,
    status_code: 'OK',
    attributes: {
      'openinference.span.kind': 'CHAIN',
      'session.id': ctx.sessionId,
      'user.id': ctx.userId,
      'input.value': clip(promptText, TEXT_MAX),
      'input.mime_type': 'text/plain',
      'output.value': clip(body.lastText, TEXT_MAX),
      'output.mime_type': 'text/plain',
      'metadata.project': ctx.project,
      'metadata.cwd': prompt.cwd ?? '',
      'metadata.git_branch': prompt.gitBranch ?? '',
      'metadata.claude_version': prompt.version ?? '',
      'metadata.permission_mode': prompt.permissionMode ?? '',
      'metadata.entrypoint': prompt.entrypoint ?? '',
      'metadata.session_title': title,
      'metadata.turn_index': k,
      'metadata.prompt_kind': kind,
      'metadata.llm_calls': body.llmCount,
      'metadata.tool_calls': body.toolCount,
      'metadata.tool_errors': body.toolErrors,
      'metadata.ask_user_questions': body.askUser,
      'metadata.interrupted': interrupted,
      'metadata.models': [...body.models].join(','),
      'metadata.skills': skills.join(','),
      'tag.tags': [
        'claude-code',
        ctx.project,
        `prompt:${kind}`,
        ...(interrupted ? ['interrupted'] : []),
        ...skills.map((sk) => `skill:${sk}`),
      ],
    },
  });
  ctx.stats.turns++;
}

/** Every still-unattached subagent becomes the root of its own trace. */
function promoteRemaining(ctx: Ctx, tag: 'orphan' | 'headless'): void {
  for (const sub of ctx.subagents.all) {
    if (sub.used) continue;
    const file = basename(sub.jsonl);
    const trace = traceId(`${ctx.sessionId}:${tag}:${file}`);
    const root = emitSubagent(ctx, sub, trace, '', sub.startTs ?? EPOCH, 1, 'unlinked');
    if (!root) continue;
    root.parent_id = null;
    if (tag === 'headless') root.attributes['metadata.headless_session'] = true;
  }
}

export function convertSession(
  path: string,
  project: string,
  userId: string,
  limitTurns = Number.POSITIVE_INFINITY,
): Ctx {
  const recs = readJsonl(path);
  const ctx: Ctx = {
    sessionId: recs.find((r) => r.sessionId)?.sessionId ?? basename(path, '.jsonl'),
    project,
    userId,
    subagents: indexSubagents(path.replace(/\.jsonl$/, '')),
    spans: [],
    stats: newStats(),
  };
  const title = recs.find((r) => r.type === 'ai-title')?.aiTitle ?? '';
  const starts: number[] = [];
  recs.forEach((r, i) => {
    if (isTurnStart(r)) starts.push(i);
  });
  for (let k = 0; k < starts.length && k < limitTurns; k++) {
    const a = starts[k] as number;
    const b = k + 1 < starts.length ? (starts[k + 1] as number) : recs.length;
    emitTurn(ctx, recs, k, a, b, title);
  }
  promoteRemaining(ctx, 'orphan');
  return ctx;
}

/** A session whose main transcript is gone but whose subagents/ dir survived: every subagent becomes its own trace. */
export function convertHeadlessSession(sessionDir: string, project: string, userId: string): Ctx {
  const ctx: Ctx = {
    sessionId: basename(sessionDir),
    project,
    userId,
    subagents: indexSubagents(sessionDir),
    spans: [],
    stats: newStats(),
  };
  promoteRemaining(ctx, 'headless');
  return ctx;
}

/**
 * Phoenix project for an encoded Claude project dir: cc-<repo> for <home>/workspace/repos/<repo>,
 * cc-<path> for anything else under the home dir, cc-scratch for /private/tmp and /private/var.
 */
export function projectNameFor(encodedDir: string, home: string = process.env.HOME ?? ''): string {
  if (encodedDir.startsWith('-private-')) return 'cc-scratch';
  const encodedHome = home.replace(/\//g, '-');
  let rest = encodedHome && encodedDir.startsWith(encodedHome) ? encodedDir.slice(encodedHome.length) : encodedDir;
  rest = rest.replace(/^-/, '');
  if (rest.startsWith('workspace-repos-')) rest = rest.slice('workspace-repos-'.length);
  return `cc-${rest || 'home'}`;
}

/** Final pass before posting: strip NUL everywhere and drop repeated span ids. */
export function finalizeSpans(spans: Span[]): Span[] {
  const seen = new Set<string>();
  const out: Span[] = [];
  for (const sp of [...spans].sort((a, b) => a.start_time.localeCompare(b.start_time))) {
    if (seen.has(sp.context.span_id)) continue; // Phoenix rejects a batch with any repeated span id
    seen.add(sp.context.span_id);
    for (const [k, v] of Object.entries(sp.attributes)) {
      if (typeof v === 'string') sp.attributes[k] = stripNul(v);
      else if (Array.isArray(v)) sp.attributes[k] = v.map(stripNul);
    }
    if (sp.status_message) sp.status_message = stripNul(sp.status_message);
    sp.name = stripNul(sp.name);
    out.push(sp);
  }
  return out;
}

// ---------- CLI options ----------
export interface BackfillOptions {
  dryRun: boolean;
  replace: boolean;
  incremental: boolean;
  verify: boolean;
  verifyTimeoutS: number;
  project?: string;
  limitTurns: number;
  content: ContentLevel;
  batch: number;
  paceMs: number;
  files: string[];
}

const VALUE_FLAGS = new Set(['--project', '--limit-turns', '--content', '--batch', '--pace-ms', '--verify-timeout']);
const BOOLEAN_FLAGS = new Set(['--dry-run', '--replace', '--incremental', '--verify']);

export const USAGE =
  'usage: bun scripts/observability/backfill.ts [--project <name>] [--content metadata|head|full] [--dry-run] [--replace | --incremental] [--verify [--verify-timeout S]] [--batch N] [--pace-ms N] [--limit-turns N] <transcript.jsonl | session-dir>...';

/** Parse argv; throws with a one-line reason on anything the usage does not allow. */
export function parseBackfillArgs(argv: readonly string[]): BackfillOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} requires a value`);
      values.set(a, v);
      i++;
    } else if (BOOLEAN_FLAGS.has(a)) flags.add(a);
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else files.push(a);
  }
  const content = (values.get('--content') ?? 'metadata') as ContentLevel;
  if (!CONTENT_LEVELS.includes(content)) throw new Error(`--content must be one of ${CONTENT_LEVELS.join('|')}`);
  if (flags.has('--replace') && flags.has('--incremental'))
    throw new Error('--replace and --incremental are exclusive');
  if (files.length === 0) throw new Error('no transcript or session dir given');
  return {
    dryRun: flags.has('--dry-run'),
    replace: flags.has('--replace'),
    incremental: flags.has('--incremental'),
    verify: flags.has('--verify'),
    verifyTimeoutS: Number(values.get('--verify-timeout') ?? 1800),
    project: values.get('--project'),
    limitTurns: Number(values.get('--limit-turns') ?? Number.POSITIVE_INFINITY),
    content,
    batch: Number(values.get('--batch') ?? DEFAULT_BATCH),
    paceMs: Number(values.get('--pace-ms') ?? 0),
    files,
  };
}

// ---------- ingest ----------
const base = () =>
  (process.env.PHOENIX_ENDPOINT ?? process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006').replace(
    /\/+$/,
    '',
  );
const authHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.PHOENIX_API_KEY) headers.authorization = `Bearer ${process.env.PHOENIX_API_KEY}`;
  return headers;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StoredSpan {
  context: { trace_id: string; span_id: string };
}
interface SpanPage {
  data?: StoredSpan[];
  next_cursor?: string | null;
}

/** Stored spans of a session (paginated REST; `limit` 1 reads one page only); [] when the project is absent. */
async function storedSpans(project: string, sessionId: string, limit = 1000): Promise<StoredSpan[]> {
  const out: StoredSpan[] = [];
  let cursor: string | null = null;
  do {
    const attr = encodeURIComponent(`session.id:${sessionId}`);
    const url = `${base()}/v1/projects/${encodeURIComponent(project)}/spans?limit=${limit}&attribute=${attr}${cursor ? `&cursor=${cursor}` : ''}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (res.status === 404) return out;
    if (!res.ok) throw new Error(`GET spans ${res.status}`);
    const page = (await res.json()) as SpanPage;
    out.push(...(page.data ?? []));
    cursor = limit === 1 ? null : (page.next_cursor ?? null);
  } while (cursor);
  return out;
}

/** Re-run semantics: Phoenix rejects a whole batch if one span id exists, so --replace deletes first. */
async function deleteSession(project: string, sessionId: string): Promise<number> {
  // every span, not only roots: a wedged insert can leave child spans whose root never landed
  const traces = new Set((await storedSpans(project, sessionId)).map((s) => s.context.trace_id));
  for (const t of traces) await fetch(`${base()}/v1/traces/${t}`, { method: 'DELETE', headers: authHeaders() });
  return traces.size;
}

async function storedSpanIds(project: string, sessionId: string): Promise<Set<string>> {
  return new Set((await storedSpans(project, sessionId)).map((s) => s.context.span_id));
}

export interface VerifyTarget {
  project: string;
  sessionId: string;
  expected: number;
  label: string;
}

/**
 * Phoenix answers 202 from an in-memory queue and inserts later. A restart discards the queue
 * and a count taken too early reads as loss. So "done" means: stored == expected, per session.
 */
async function verifyDrained(targets: VerifyTarget[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let pending = targets.filter((t) => t.expected > 0);
  while (pending.length > 0) {
    const short: { target: VerifyTarget; stored: number }[] = [];
    for (const t of pending) {
      const stored = (await storedSpanIds(t.project, t.sessionId)).size;
      if (stored < t.expected) short.push({ target: t, stored });
    }
    pending = short.map((s) => s.target);
    if (pending.length === 0) break;
    const labels = short.map((s) => `${s.target.label} ${s.stored}/${s.target.expected}`);
    if (Date.now() > deadline) {
      console.error(
        `verify: ${pending.length} session(s) still short after ${Math.round(timeoutMs / 1000)}s: ${labels.join(', ')}`,
      );
      return false;
    }
    console.log(
      `verify: waiting for Phoenix to insert ${pending.length} session(s) (${labels.slice(0, 3).join(', ')})`,
    );
    await sleep(15_000);
  }
  console.log(`verify: all ${targets.length} session(s) fully inserted`);
  return true;
}

async function postSpans(project: string, spans: Span[], batch: number, paceMs: number): Promise<number> {
  let queued = 0;
  for (let i = 0; i < spans.length; i += batch) {
    const res = await fetch(`${base()}/v1/projects/${encodeURIComponent(project)}/spans`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ data: spans.slice(i, i + batch) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST spans ${res.status}: ${text.slice(0, 800)}`);
    queued += (JSON.parse(text) as { total_queued?: number }).total_queued ?? 0;
    // Phoenix inserts asynchronously; pacing keeps a slow writer from wedging
    if (paceMs > 0) await sleep(paceMs);
  }
  return queued;
}

async function shipSession(opts: BackfillOptions, project: string, ctx: Ctx, line: string): Promise<void> {
  if (opts.incremental) {
    const stored = await storedSpanIds(project, ctx.sessionId);
    const fresh = ctx.spans.filter((s) => !stored.has(s.context.span_id));
    if (fresh.length === 0) {
      console.log(`${line} up to date (${stored.size} stored)`);
      return;
    }
    const queued = await postSpans(project, fresh, opts.batch, opts.paceMs);
    console.log(`${line} incremental: ${stored.size} stored, +${fresh.length} posted, queued=${queued}`);
    return;
  }
  if ((await storedSpans(project, ctx.sessionId, 1)).length > 0) {
    if (!opts.replace) {
      console.log(`${line} SKIPPED (already in ${project}; use --replace)`);
      return;
    }
    const n = await deleteSession(project, ctx.sessionId);
    console.log(`  replaced: deleted ${n} stored trace(s) for ${ctx.sessionId.slice(0, 8)}`);
  }
  const queued = await postSpans(project, ctx.spans, opts.batch, opts.paceMs);
  console.log(`${line} content=${opts.content} queued=${queued}`);
}

async function main(): Promise<void> {
  let opts: BackfillOptions;
  try {
    opts = parseBackfillArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`backfill: ${(error as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  setContentLevel(opts.content);
  // refuse to write content into an instance on a non-loopback address unless auth is on
  if (!opts.dryRun && opts.content !== 'metadata' && !process.env.PHOENIX_API_KEY) {
    const host = new URL(base()).hostname;
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
      console.error(`refusing --content ${opts.content} against ${host} without PHOENIX_API_KEY`);
      process.exit(3);
    }
  }
  const userId = process.env.BACKFILL_USER_ID ?? process.env.USER ?? 'unknown';
  const targets: VerifyTarget[] = [];
  for (const raw of opts.files) {
    const f = raw.replace(/\/+$/, '');
    const project = opts.project ?? projectNameFor(basename(dirname(f)));
    const headless = !f.endsWith('.jsonl');
    const ctx = headless
      ? convertHeadlessSession(f, project, userId)
      : convertSession(f, project, userId, opts.limitTurns);
    ctx.spans = finalizeSpans(ctx.spans);
    const line = `${basename(f, '.jsonl').slice(0, 8)}${headless ? ' (headless)' : ''} -> ${project}: ${JSON.stringify(ctx.stats)} spans=${ctx.spans.length}`;
    if (opts.dryRun) {
      console.log(`[dry-run] ${line}`);
      continue;
    }
    targets.push({ project, sessionId: ctx.sessionId, expected: ctx.spans.length, label: ctx.sessionId.slice(0, 8) });
    await shipSession(opts, project, ctx, line);
  }
  if (opts.verify && !opts.dryRun) {
    process.exitCode = (await verifyDrained(targets, opts.verifyTimeoutS * 1000)) ? 0 : 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`backfill: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
