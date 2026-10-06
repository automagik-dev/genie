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
 * carries only its cwd; {@link matchOmpSessionByCwd} finds the session whose own
 * `session.cwd` record equals it and whose life overlaps the interval. An agent
 * that runs genie from another directory than its session's (a git worktree)
 * never has an equal cwd; {@link matchOmpSessionByEvidence} is the fallback: the
 * one live session whose log ran `genie task` for the card just before the event.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { resolveClaudeDir, resolveCodexDir } from './genie-home.js';
import type { RuntimeSession } from './metrics-capture.js';
import { repoCheckouts, repoRootOfDb } from './metrics-offload.js';

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
      // A negative or non-finite price is no price.
      costUsd:
        cost && typeof cost.total === 'number' && Number.isFinite(cost.total) && cost.total >= 0 ? cost.total : null,
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
 * Every top-level OMP session whose header cwd passes `cwdMatches`, that had started by `openedAt` and
 * was still written at or after it. Only `~/.omp` is scanned — only OMP shells produce id-less lines,
 * so a pi log there would be someone else's usage. Top-level session logs only: an OMP subagent's log
 * lives in its parent's folder, so a `genie` call from a subagent shell is matched to the parent session.
 */
function ompSessionsOverlapping(
  openedAt: number,
  env: NodeJS.ProcessEnv,
  cwdMatches: (cwd: string) => boolean,
): Array<{ id: string | null; file: string }> {
  const root = join(env.HOME || homedir(), '.omp', 'agent', 'sessions');
  const hits: Array<{ id: string | null; file: string }> = [];
  for (const slug of safeReaddir(root)) {
    for (const file of listJsonl(join(root, slug))) {
      const header = piSessionHeader(file);
      if (!header || !cwdMatches(header.cwd) || !(header.startedAt <= openedAt)) continue;
      let lastWrite = 0;
      try {
        lastWrite = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (lastWrite >= openedAt) hits.push({ id: header.id, file });
    }
  }
  return hits;
}

/**
 * The single OMP session that wrote the opening event: its header's cwd is equal, it had started by
 * `openedAt` and it was still written at or after it. Two candidates are 'ambiguous' — never a guess;
 * none is null.
 */
export function matchOmpSessionByCwd(
  cwd: string,
  openedAt: number,
  env: NodeJS.ProcessEnv = process.env,
): PiSessionMatch {
  const hits = ompSessionsOverlapping(openedAt, env, (header) => header === cwd);
  if (hits.length > 1) return 'ambiguous';
  return hits[0] ?? null;
}

/**
 * How long before a card event its `genie task …` tool call may have been logged. OMP writes the
 * assistant record (with the tool call) and then runs the command: over 69 real events of one host the
 * record preceded the event by 0.3–3.2 s. 60 s leaves room for a command that does work before its
 * genie call, and stays far below the minutes that separate two sessions touching the same card.
 */
export const OMP_TOOL_CALL_WINDOW_MS = 60_000;

/** One logged tool call whose command ran `genie task …`. */
interface GenieToolCall {
  at: number;
  command: string;
}

/** Per export run: log file → its `genie task …` tool calls, so each log is read once however many cards ask. */
export type OmpEvidenceCache = Map<string, GenieToolCall[]>;

const GENIE_TASK_COMMAND = /\bgenie(?:\.[jt]s)?["']?\s+task\s/;
const GENIE_BYTES = Buffer.from('genie', 'utf8');
const TASK_BYTES = Buffer.from('task', 'utf8');

/** The `genie task …` commands of one parsed log record's assistant tool calls. */
function genieCommands(record: Rec | null): string[] {
  const message = obj(record?.message);
  if (record?.type !== 'message' || message?.role !== 'assistant' || !Array.isArray(message.content)) return [];
  const commands: string[] = [];
  for (const part of message.content) {
    const command = obj(obj(part)?.arguments)?.command;
    if (obj(part)?.type === 'toolCall' && typeof command === 'string' && GENIE_TASK_COMMAND.test(command)) {
      commands.push(command);
    }
  }
  return commands;
}

/**
 * Every tool call of one OMP log whose command ran `genie task …`, in one streaming pass:
 *
 *   {"type":"message","timestamp":"<ISO>","message":{"role":"assistant","content":[
 *     {"type":"toolCall","name":"bash","arguments":{"command":"genie task comment <taskId> …"}}]}}
 *
 * The log is read in chunks and a line is only decoded when its bytes contain both "genie" and
 * "task" — these logs run to tens of MB and few lines run genie.
 */
function readGenieToolCalls(file: string): GenieToolCall[] {
  const calls: GenieToolCall[] = [];
  const inspect = (line: Buffer): void => {
    if (!line.includes(GENIE_BYTES) || !line.includes(TASK_BYTES)) return;
    try {
      const record = obj(JSON.parse(line.toString('utf8')));
      const at = Date.parse(String(record?.timestamp));
      if (!Number.isFinite(at)) return;
      for (const command of genieCommands(record)) calls.push({ at, command });
    } catch {
      // a torn line of a live log
    }
  };
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const chunk = Buffer.alloc(1 << 20);
    let rest: Buffer = Buffer.alloc(0);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      let data: Buffer = rest.length > 0 ? Buffer.concat([rest, chunk.subarray(0, read)]) : chunk.subarray(0, read);
      for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10)) {
        inspect(data.subarray(0, end));
        data = data.subarray(end + 1);
      }
      // `data` may alias `chunk`, which the next read overwrites.
      rest = Buffer.from(data);
    }
    inspect(rest);
  } catch {
    // an unreadable log is no evidence
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return calls;
}

/** Whether a session's own log, or one of its subagents' (the sibling `<session>/` folder), ran genie for the task shortly before `at`. */
function sessionInvokedGenie(main: string, taskId: string, at: number, cache: OmpEvidenceCache): boolean {
  const sibling = main.replace(/\.jsonl$/, '');
  for (const file of [main, ...(isDir(sibling) ? listJsonl(sibling) : [])]) {
    let calls = cache.get(file);
    if (!calls) {
      calls = readGenieToolCalls(file);
      cache.set(file, calls);
    }
    const ran = (call: GenieToolCall) =>
      call.at <= at && at - call.at <= OMP_TOOL_CALL_WINDOW_MS && call.command.includes(taskId);
    if (calls.some(ran)) return true;
  }
  return false;
}

/**
 * The fallback when NO OMP session has the capture cwd itself: the agent ran genie from another
 * directory than the one its session was started in — a git worktree of the repository, or the
 * repository itself from a session started somewhere else entirely. A header cwd says nothing then,
 * so the only tie is evidence: among the OMP sessions alive at the event (started by it, log still
 * written at or after it — the file's mtime, the same cheap liveness test the equal-cwd rule uses),
 * the ONE whose log holds a `genie task …` tool call naming this card within
 * {@link OMP_TOOL_CALL_WINDOW_MS} at or before the event. None is null and several are 'ambiguous' —
 * never a guess, and a lone live session with no such call is not matched either.
 *
 * Only an event of a real repository reaches it: its `db` must be `<root>/.genie/genie.db` and the
 * capture cwd must lie in a checkout of that root (the root, or a worktree git registered for it).
 */
export function matchOmpSessionByEvidence(
  event: { cwd: string; db: string; task: string; at: number },
  env: NodeJS.ProcessEnv = process.env,
  cache: OmpEvidenceCache = new Map(),
): PiSessionMatch {
  // Only a per-repo database names a repository; any other path (a test fixture, a foreign file) names none.
  if (basename(event.db) !== 'genie.db' || basename(dirname(event.db)) !== '.genie') return null;
  const checkouts = repoCheckouts(repoRootOfDb(event.db));
  if (!checkouts.some((c) => event.cwd === c || event.cwd.startsWith(`${c}${sep}`))) return null;
  const alive = ompSessionsOverlapping(event.at, env, () => true);
  const proven = alive.filter((c) => sessionInvokedGenie(c.file, event.task, event.at, cache));
  if (proven.length > 1) return 'ambiguous';
  return proven[0] ?? null;
}
