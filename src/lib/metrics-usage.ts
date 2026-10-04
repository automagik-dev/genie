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
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
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
}

type Rec = Record<string, unknown>;

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
    byMessage.set(message.id, {
      at: Date.parse(String(record.timestamp)),
      input: num(usage.input_tokens),
      cacheRead: num(usage.cache_read_input_tokens),
      cacheWrite: num(usage.cache_creation_input_tokens),
      output: num(usage.output_tokens),
      costUsd: null,
    });
  }
  return [...byMessage.values()];
}

function codexSamples(records: Rec[]): UsageSample[] {
  const out: UsageSample[] = [];
  for (const record of records) {
    const payload = obj(record.payload);
    const last = obj(obj(payload?.info)?.last_token_usage);
    if (record.type !== 'event_msg' || payload?.type !== 'token_count' || !last) continue;
    const cached = num(last.cached_input_tokens);
    out.push({
      at: Date.parse(String(record.timestamp)),
      input: Math.max(0, num(last.input_tokens) - cached),
      cacheRead: cached,
      cacheWrite: num(last.cache_write_input_tokens),
      output: num(last.output_tokens),
      costUsd: null,
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
  const samples = sessionLogFiles(session, env).flatMap((file) => parse(readRecords(file)));
  return samples.filter((sample) => Number.isFinite(sample.at)).sort((a, b) => a.at - b.at);
}
