/**
 * Runtime session logs → model-call usage samples, for `genie metrics export`.
 *
 * Each runtime already writes every model call's token usage to its own session
 * log; genie only reads them, after the run, off the critical path:
 *
 *   claude-code  <claude>/projects/<cwd-slug>/<session>.jsonl (+ <session>/subagents/*.jsonl)
 *                assistant records, `message.usage`, deduplicated by `message.id`
 *   codex        <codex>/sessions/YYYY/MM/DD/rollout-*-<session>.jsonl
 *                `event_msg` / `token_count`, `info.last_token_usage` per turn
 *   pi / OMP     the file PI_SESSION_FILE named (+ its sibling <session>/ subagent logs)
 *                `message` records with an assistant `message.usage` (+ `cost.total`)
 *
 * A log that is absent or unreadable yields no samples — the caller reports the
 * interval as having no usage, never as zero.
 *
 * OMP 18.6.1 exports no session id to its tool shells, so an OMP capture line
 * carries only its cwd; {@link matchPiSessionByCwd} finds the session whose own
 * `session.cwd` record equals it and whose life overlaps the interval.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveClaudeDir, resolveCodexDir } from './genie-home.js';
import type { RuntimeSession } from './metrics-capture.js';

export interface UsageSample {
  /** Epoch ms of the model call's record. */
  at: number;
  /** Uncached input tokens. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Only when the runtime itself priced the call (pi/OMP); null otherwise — never a guess. */
  costUsd: number | null;
  /**
   * The model id the runtime logged for the call, as written (pi/OMP may provider-prefix it); null when
   * the log names none. Claude Code's `<synthetic>` placeholder is no model and reads as null.
   */
  model: string | null;
  /** The part of `cacheWrite` Claude Code logged as 1-hour cache writes; absent when no TTL split was logged. */
  cacheWrite1h?: number;
}

type Rec = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const obj = (value: unknown): Rec | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null;

function readRecords(file: string): Rec[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Rec[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = obj(JSON.parse(line));
      if (parsed) out.push(parsed);
    } catch {
      // a torn tail line of a live log
    }
  }
  return out;
}

function listJsonl(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function claudeFiles(id: string, env: NodeJS.ProcessEnv): string[] {
  const projects = join(env.CLAUDE_CONFIG_DIR || resolveClaudeDir(), 'projects');
  const files: string[] = [];
  let slugs: string[] = [];
  try {
    slugs = readdirSync(projects);
  } catch {
    return files;
  }
  for (const slug of slugs) {
    const main = join(projects, slug, `${id}.jsonl`);
    if (!existsSync(main)) continue;
    files.push(main, ...listJsonl(join(projects, slug, id, 'subagents')));
  }
  return files;
}

function codexFiles(id: string, env: NodeJS.ProcessEnv): string[] {
  const root = join(resolveCodexDir(env), 'sessions');
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (depth < 3) walk(path, depth + 1);
      else if (name.endsWith(`${id}.jsonl`)) found.push(path);
    }
  };
  walk(root, 0);
  return found;
}

function piFiles(session: RuntimeSession, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME || homedir();
  let main = session.file;
  if (!main && session.id) {
    for (const root of [join(home, '.omp', 'agent', 'sessions'), join(home, '.pi', 'agent', 'sessions')]) {
      for (const slug of safeReaddir(root)) {
        const hit = safeReaddir(join(root, slug)).find((name) => name.endsWith(`_${session.id}.jsonl`));
        if (hit) main = join(root, slug, hit);
      }
    }
  }
  if (!main || !existsSync(main)) return [];
  const sibling = main.replace(/\.jsonl$/, '');
  return [main, ...(isDir(sibling) ? listJsonl(sibling) : [])];
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function sessionLogFiles(session: RuntimeSession, env: NodeJS.ProcessEnv = process.env): string[] {
  if (session.source === 'claude-code' && session.id) return claudeFiles(session.id, env);
  if (session.source === 'codex' && session.id) return codexFiles(session.id, env);
  if (session.source === 'pi') return piFiles(session, env);
  return [];
}

function claudeSamples(records: Rec[]): UsageSample[] {
  // One API response streams as several records sharing message.id; the last one carries the final usage.
  const byMessage = new Map<string, UsageSample>();
  for (const record of records) {
    const message = obj(record.message);
    const usage = obj(message?.usage);
    if (record.type !== 'assistant' || !usage || typeof message?.id !== 'string') continue;
    const ttl = obj(usage.cache_creation);
    byMessage.set(message.id, {
      ...(ttl ? { cacheWrite1h: num(ttl.ephemeral_1h_input_tokens) } : {}),
      at: Date.parse(String(record.timestamp)),
      input: num(usage.input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      output: num(usage.output_tokens),
      costUsd: null,
      model: message.model === '<synthetic>' ? null : str(message.model),
    });
  }
  return [...byMessage.values()];
}

function codexSamples(records: Rec[]): UsageSample[] {
  const out: UsageSample[] = [];
  // Codex re-emits the same token_count (identical cumulative total) more than once per turn; only a
  // total that moved is a new model call. Summing every event overcounted 4–16% on real rollouts.
  let previousTotal: string | null = null;
  // The model rides each turn's `turn_context`; a token_count belongs to the latest one before it.
  let model: string | null = null;
  for (const record of records) {
    const payload = obj(record.payload);
    if (record.type === 'turn_context') model = str(payload?.model);
    const info = obj(payload?.info);
    const last = obj(info?.last_token_usage);
    if (record.type !== 'event_msg' || payload?.type !== 'token_count' || !last) continue;
    const total = JSON.stringify(info?.total_token_usage ?? null);
    if (total !== 'null' && total === previousTotal) continue;
    previousTotal = total;
    const cached = num(last.cached_input_tokens);
    out.push({
      at: Date.parse(String(record.timestamp)),
      input: Math.max(0, num(last.input_tokens) - cached),
      cacheRead: cached,
      cacheWrite: num(last.cache_write_input_tokens),
      output: num(last.output_tokens),
      costUsd: null,
      model,
    });
  }
  return out;
}

function piSamples(records: Rec[]): UsageSample[] {
  const out: UsageSample[] = [];
  for (const record of records) {
    const message = obj(record.message);
    const usage = obj(message?.usage);
    if (record.type !== 'message' || message?.role !== 'assistant' || !usage) continue;
    const cost = obj(usage.cost);
    out.push({
      at: Date.parse(String(record.timestamp)),
      input: num(usage.input),
      cacheRead: num(usage.cacheRead),
      cacheWrite: num(usage.cacheWrite),
      output: num(usage.output),
      costUsd: cost && typeof cost.total === 'number' ? cost.total : null,
      model: str(message.model),
    });
  }
  return out;
}

/** Every model call the session's logs record, oldest first; [] when the logs are not on this host. */
export function readUsageSamples(session: RuntimeSession, env: NodeJS.ProcessEnv = process.env): UsageSample[] {
  const parse =
    session.source === 'claude-code'
      ? claudeSamples
      : session.source === 'codex'
        ? codexSamples
        : session.source === 'pi'
          ? piSamples
          : null;
  if (!parse) return [];
  const files = sessionLogFiles(session, env);
  // Claude dedupes by message id ACROSS the session's files: a fork subagent transcript repeats its
  // parent's messages. Codex's cumulative totals are per rollout file, so it parses file by file.
  const samples =
    session.source === 'claude-code'
      ? parse(files.flatMap(readRecords))
      : files.flatMap((file) => parse(readRecords(file)));
  return samples.filter((sample) => Number.isFinite(sample.at)).sort((a, b) => a.at - b.at);
}

const headerCache = new Map<string, { id: string | null; cwd: string; startedAt: number } | null>();

/** The `session` header record of a pi/OMP log (its first lines), read once per file per process. */
function piSessionHeader(file: string): { id: string | null; cwd: string; startedAt: number } | null {
  if (!headerCache.has(file)) headerCache.set(file, readPiSessionHeader(file));
  return headerCache.get(file) ?? null;
}

function readPiSessionHeader(file: string): { id: string | null; cwd: string; startedAt: number } | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(16_384);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, read).toString('utf8').split('\n').slice(0, 8)) {
      try {
        const record = obj(JSON.parse(line));
        if (record?.type === 'session' && typeof record.cwd === 'string') {
          return {
            id: typeof record.id === 'string' ? record.id : null,
            cwd: record.cwd,
            startedAt: Date.parse(String(record.timestamp)),
          };
        }
      } catch {
        // a torn header line
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return null;
}

export type PiSessionMatch = { id: string | null; file: string } | 'ambiguous' | null;

/**
 * The single OMP session that wrote the opening event: its header's cwd is equal, it had started by
 * `openedAt` and it was still written at or after it. Only `~/.omp` is scanned — only OMP shells
 * produce id-less lines, so a pi log there would be someone else's usage. Two candidates are
 * 'ambiguous' — never a guess; none is null. Top-level session logs only: an OMP subagent's log lives
 * in its parent's folder, so a `genie` call from a subagent shell is matched to the parent session.
 */
export function matchOmpSessionByCwd(
  cwd: string,
  openedAt: number,
  env: NodeJS.ProcessEnv = process.env,
): PiSessionMatch {
  const root = join(env.HOME || homedir(), '.omp', 'agent', 'sessions');
  const hits: Array<{ id: string | null; file: string }> = [];
  for (const slug of safeReaddir(root)) {
    for (const file of listJsonl(join(root, slug))) {
      const header = piSessionHeader(file);
      if (!header || header.cwd !== cwd || !(header.startedAt <= openedAt)) continue;
      let lastWrite = 0;
      try {
        lastWrite = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (lastWrite >= openedAt) hits.push({ id: header.id, file });
    }
  }
  if (hits.length > 1) return 'ambiguous';
  return hits[0] ?? null;
}
