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
 * one live session that was running a genie write for the card when the event was written.
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
 * How long a tool call with NO logged result (still running, or a torn log) may have taken to reach its
 * `genie task …` write. A call that has a result is bounded by that result instead. On one real host
 * the 105 bash calls of a session ran for 6 ms – 20.8 s (median 0.36 s); 60 s covers a command that
 * does work before its genie call.
 */
export const OMP_TOOL_CALL_WINDOW_MS = 60_000;

/** Slack on each side of a call's execution interval: clocks of two processes and millisecond rounding. */
export const OMP_TOOL_CALL_SLACK_MS = 2_000;

/** One logged tool call whose arguments name at least one card this export asks about. */
interface OmpToolCall {
  /** When the assistant record carrying the call was written — the call's issuance. */
  at: number;
  /** When its `toolResult` record was written; null while none is logged. */
  endAt: number | null;
  /** The shell command of a `bash` call; null for every other tool. */
  command: string | null;
  /** The cards (of {@link OmpEvidenceCache.tasks}) a decoded string of its arguments names as a whole word. */
  mentions: Set<string>;
}

/** Per export run: the cards asked about, and log file → its tool calls naming one, so each log is read once. */
export interface OmpEvidenceCache {
  tasks: string[];
  files: Map<string, OmpToolCall[]>;
}

export function newOmpEvidenceCache(tasks: Iterable<string>): OmpEvidenceCache {
  return { tasks: [...new Set(tasks)], files: new Map() };
}

/**
 * The `genie task <verb> <id>` verbs that append a card event (`src/term-commands/v5-task.ts` over
 * `appendTaskEventInTx`), each with its options and whether the option takes a value — the registered
 * table, restated here because an option's value must never be read as the card. `status`, `list`,
 * `export`, `import`, `sync`, `heartbeat` and `delete` append none; `create` names no existing card.
 */
const CARD_WRITE_VERBS: Record<string, Record<string, boolean>> = {
  adopt: { '--board': true, '--lane': true },
  assign: { '--agent': true, '--why': true, '--clear': false },
  block: { '--reason': true, '--hold': false },
  checkout: { '--worker': true },
  comment: { '--worker': true },
  done: {},
  link: { '--wish': true, '--group': true },
  move: { '--to': true },
  release: {},
  report: { '--worker': true },
  'set-wish': { '--wish': true, '--group': true, '--clear': false },
  unblock: {},
};

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GENIE_EXECUTABLE = /(?:^|\/)genie(?:\.[jt]s)?$/;
const WORD_CHAR = /[A-Za-z0-9_]/;
const COMMAND_SEPARATORS = new Set([';', '&', '|', '\n', '(', ')']);

/**
 * A shell command line → its simple commands, each a list of words. This is a lexer, not a shell
 * parser: it honours single quotes, double quotes and backslash escapes, and starts a new simple
 * command at every unquoted `;`, `&`, `|`, newline or parenthesis — which is all the recognizer below
 * needs. A word is kept exactly as the shell would pass it only when it holds no expansion; `$x` and
 * `$(…)` stay literal text, so they can never equal a card id.
 */
function simpleCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word = (word ?? '') + char;
    } else if (char === '\\' && i + 1 < command.length) {
      word = (word ?? '') + (command[++i] as string);
    } else if (char === quote) {
      quote = null;
    } else if (quote === null && (char === "'" || char === '"')) {
      quote = char;
      word = word ?? '';
    } else if (quote === null && COMMAND_SEPARATORS.has(char)) {
      endWord();
      commands.push(words);
      words = [];
    } else if (quote === null && (char === ' ' || char === '\t')) {
      endWord();
    } else {
      word = (word ?? '') + char;
    }
  }
  endWord();
  commands.push(words);
  return commands.filter((list) => list.length > 0);
}

/** The words after the genie executable when `words` INVOKES genie — the executable at command position — else null. */
function genieArguments(words: string[]): string[] | null {
  let i = 0;
  const skipAssignments = () => {
    while (i < words.length && ENV_ASSIGNMENT.test(words[i] ?? '')) i++;
  };
  skipAssignments();
  // Wrappers that run their operand as the command: `env [VAR=x…]`, `flock <file>`, `bun [run]`, `node`.
  if (words[i] === 'env') {
    i++;
    skipAssignments();
  }
  if (words[i] === 'flock') i += 2;
  if (words[i] === 'bun' || words[i] === 'node') {
    i++;
    if (words[i] === 'run') i++;
  }
  return GENIE_EXECUTABLE.test(words[i] ?? '') ? words.slice(i + 1) : null;
}

/**
 * The card a `<verb> …` argument list operates on: its first operand, with every registered option
 * (and the value it takes) skipped. null when there is none before a bare `--`, when an option is not
 * one the verb registers, or when help was asked for — commander then prints and writes nothing.
 */
function cardOperand(options: Record<string, boolean>, args: string[]): string | null {
  const end = args.indexOf('--');
  const scope = end === -1 ? args : args.slice(0, end);
  if (scope.includes('--help') || scope.includes('-h')) return null;
  for (let i = 0; i < scope.length; i++) {
    const word = scope[i] as string;
    if (!word.startsWith('-')) return word;
    const [name, inline] = word.split('=', 2) as [string, string | undefined];
    const takesValue = options[name];
    if (takesValue === undefined || (inline !== undefined && !takesValue)) return null;
    if (takesValue && inline === undefined) i++;
  }
  return null;
}

/**
 * Whether one simple command INVOKES a card-writing genie verb for this card:
 *
 *   [VAR=x…] [env|flock <file>|bun [run]|node] <genie|…/genie|…/genie.js|…/genie.ts>
 *     [--no-interactive] task <write verb> [registered options] <card id> …
 *
 * The executable must be at command position — `echo genie task done t1` and `xargs genie task done`
 * are not invocations this can prove — and the card must be the verb's own operand, never an option's
 * value or a comment's text.
 */
function invokesCardWrite(words: string[], taskId: string): boolean {
  const args = genieArguments(words);
  if (!args) return false;
  const rest = args[0] === '--no-interactive' ? args.slice(1) : args;
  const options = rest[0] === 'task' ? CARD_WRITE_VERBS[rest[1] ?? ''] : undefined;
  return options !== undefined && cardOperand(options, rest.slice(2)) === taskId;
}

/** Whether a bash command proves a write of this card. A here-document anywhere disqualifies it: its body is data the lexer would read as command lines. */
function provesCardWrite(command: string, taskId: string): boolean {
  if (command.includes('<<')) return false;
  return simpleCommands(command).some((words) => invokesCardWrite(words, taskId));
}

/** Whether `text` holds the card id as a whole word. */
function namesCard(text: string, taskId: string): boolean {
  for (let at = text.indexOf(taskId); at !== -1; at = text.indexOf(taskId, at + 1)) {
    const before = text[at - 1];
    const after = text[at + taskId.length];
    if (!(before && WORD_CHAR.test(before)) && !(after && WORD_CHAR.test(after))) return true;
  }
  return false;
}

/** The cards any DECODED string value inside a tool call's arguments names — never the serialized JSON, whose escapes glue words together. */
function cardsNamed(value: unknown, tasks: string[], found: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    for (const task of tasks) if (!found.has(task) && namesCard(value, task)) found.add(task);
  } else if (Array.isArray(value)) {
    for (const item of value) cardsNamed(item, tasks, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) cardsNamed(item, tasks, found);
  }
  return found;
}

/** Whether the event falls inside the call's execution: issuance → logged result, or the window when no result is logged. */
function ranDuring(call: OmpToolCall, at: number): boolean {
  const end = call.endAt ?? call.at + OMP_TOOL_CALL_WINDOW_MS;
  return at >= call.at - OMP_TOOL_CALL_SLACK_MS && at <= end + OMP_TOOL_CALL_SLACK_MS;
}

const TOOL_CALL_BYTES = Buffer.from('"type":"toolCall"', 'utf8');
const TOOL_RESULT_BYTES = Buffer.from('"toolCallId":"', 'utf8');

/** Feeds every line of a file to `inspect`, reading in chunks: these logs run to tens of MB. */
function forEachLine(file: string, inspect: (line: Buffer) => void): void {
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
}

/**
 * Every tool call of one OMP log that names one of `tasks`, with its execution interval, in one
 * streaming pass:
 *
 *   {"type":"message","timestamp":"<ISO>","message":{"role":"assistant","content":[
 *     {"type":"toolCall","id":"<call>","name":"bash","arguments":{"command":"genie task comment <id> …"}}]}}
 *   {"type":"message","timestamp":"<ISO>","message":{"role":"toolResult","toolCallId":"<call>","toolName":"bash",…}}
 *
 * A line is only decoded when its bytes hold a tool call and one of the card ids, or the result of a
 * call already collected (the `toolCallId` is read from the bytes first).
 */
function readOmpToolCalls(file: string, tasks: string[]): OmpToolCall[] {
  const needles = tasks.map((task) => Buffer.from(task, 'utf8'));
  const calls: OmpToolCall[] = [];
  const open = new Map<string, OmpToolCall>();
  const toolCall = (item: Rec, at: number): OmpToolCall | null => {
    if (item.type !== 'toolCall') return null;
    const mentions = cardsNamed(item.arguments, tasks);
    if (mentions.size === 0) return null;
    const command = item.name === 'bash' ? obj(item.arguments)?.command : null;
    return { at, endAt: null, command: typeof command === 'string' ? command : null, mentions };
  };
  const collect = (record: Rec | null): void => {
    const message = obj(record?.message);
    const at = Date.parse(String(record?.timestamp));
    if (!message || !Number.isFinite(at)) return;
    if (message.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const call = open.get(message.toolCallId);
      if (call && call.endAt === null) call.endAt = at;
      return;
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return;
    for (const part of message.content) {
      const item = obj(part);
      const call = item ? toolCall(item, at) : null;
      if (!call) continue;
      calls.push(call);
      if (typeof item?.id === 'string') open.set(item.id, call);
    }
  };
  const resultOfOpenCall = (line: Buffer): boolean => {
    const start = line.indexOf(TOOL_RESULT_BYTES);
    if (start === -1) return false;
    const from = start + TOOL_RESULT_BYTES.length;
    const end = line.indexOf(34, from);
    return end !== -1 && open.has(line.toString('utf8', from, end));
  };
  forEachLine(file, (line) => {
    const isCall = line.includes(TOOL_CALL_BYTES) && needles.some((needle) => line.includes(needle));
    if (!isCall && !resultOfOpenCall(line)) return;
    try {
      collect(obj(JSON.parse(line.toString('utf8'))));
    } catch {
      // a torn line of a live log
    }
  });
  return calls;
}

type Evidence = 'proven' | 'mention' | null;

/**
 * What a session's own log, and its subagents' (the sibling `<session>/` folder, one level — the same
 * reach as usage reading), say about the card at `at`: 'proven' as soon as one call running then
 * invoked a genie write for it, else 'mention' when one running then named it at all.
 */
function sessionEvidence(main: string, taskId: string, at: number, cache: OmpEvidenceCache): Evidence {
  const sibling = main.replace(/\.jsonl$/, '');
  let evidence: Evidence = null;
  for (const file of [main, ...(isDir(sibling) ? listJsonl(sibling) : [])]) {
    let calls = cache.files.get(file);
    if (!calls) {
      calls = readOmpToolCalls(file, cache.tasks);
      cache.files.set(file, calls);
    }
    for (const call of calls) {
      if (!call.mentions.has(taskId) || !ranDuring(call, at)) continue;
      if (call.command !== null && provesCardWrite(call.command, taskId)) return 'proven';
      evidence = 'mention';
    }
  }
  return evidence;
}

/**
 * The fallback when NO OMP session has the capture cwd itself: the agent ran genie from another
 * directory than the one its session was started in — a git worktree of the repository, or the
 * repository itself from a session started somewhere else entirely. A header cwd says nothing then,
 * so the only tie is evidence, read from the OMP sessions alive at the event (started by it, log
 * still written at or after it — the file's mtime, the same cheap liveness test the equal-cwd rule
 * uses). For each, over the tool calls that were EXECUTING when the event was written
 * ({@link ranDuring}):
 *
 *   MENTION — a call of any tool whose decoded arguments name the card as a whole word.
 *   PROVEN  — a bash call with no here-document that invokes a card-writing genie verb with this card
 *             as its operand ({@link invokesCardWrite}).
 *
 * Exactly one PROVEN session and no OTHER session with a MENTION is the writer. One proven session
 * beside another that mentions the card is 'ambiguous' — the other may be the writer in a form this
 * cannot recognize (the `eval` tool, `xargs`, `| sh`, `$(…)`), and even a concurrent `genie task status`
 * poll costs the match: the price of never guessing. Two proven are 'ambiguous'; none is null, a lone
 * live session that only mentions the card included.
 *
 * Inherent limits: a writer whose log never names the card (`./report.sh`, `genie task done $ID`) is
 * invisible, so it neither matches nor blocks; and a long-running proven call claims every event of
 * its card written inside its interval.
 *
 * Only an event of a real repository reaches it: its `db` must be `<root>/.genie/genie.db` and the
 * capture cwd must lie in a checkout of that root (the root, or a worktree git registered for it).
 */
export function matchOmpSessionByEvidence(
  event: { cwd: string; db: string; task: string; at: number },
  env: NodeJS.ProcessEnv = process.env,
  cache: OmpEvidenceCache = newOmpEvidenceCache([event.task]),
): PiSessionMatch {
  // Only a per-repo database names a repository; any other path (a test fixture, a foreign file) names none.
  if (basename(event.db) !== 'genie.db' || basename(dirname(event.db)) !== '.genie') return null;
  const checkouts = repoCheckouts(repoRootOfDb(event.db));
  if (!checkouts.some((c) => event.cwd === c || event.cwd.startsWith(`${c}${sep}`))) return null;
  const alive = ompSessionsOverlapping(event.at, env, () => true);
  const evidence = alive.map((session) => sessionEvidence(session.file, event.task, event.at, cache));
  const proven = alive.filter((_, index) => evidence[index] === 'proven');
  if (proven.length === 0) return null;
  if (proven.length > 1 || evidence.includes('mention')) return 'ambiguous';
  return proven[0] ?? null;
}
