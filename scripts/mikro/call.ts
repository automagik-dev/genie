#!/usr/bin/env bun
/**
 * scripts/mikro/call.ts — run ONE genie mikro microagent and return validated JSON.
 *
 *   bun scripts/mikro/call.ts <agent> --prompt "<text>" [--dir <repo>] [--timeout-ms 600000]
 *       [--retries 1] [--tag k=v ...] [--trace <id>] [--no-phoenix] [--raw]
 *
 * This is the only surface that runs an `agent.yaml` agent: it speaks MCP over
 * stdio to `mikro mcp --dir <repo>` (the one runtime that loads the agent's
 * SYSTEM.md), calls `mikro_<agent>` with `{prompt}`, and treats what comes back
 * as DATA that has to earn trust:
 *   1. the answer must carry mikro's cost footer (parsed, never estimated);
 *   2. it must contain one ```json block that parses AND validates against
 *      `scripts/mikro/schemas.ts` for that agent;
 *   3. every `path:line` it cites must exist at that line in <repo>, and every
 *      `path` field must exist on disk — a field that declares itself deleted is
 *      excepted only when git can show the path in HEAD's history;
 * a failure on any of these is retried once with the errors appended to the
 * prompt. Each attempt is appended to `<repo>/.mikro/runs/<agent>.jsonl` and
 * posted to Phoenix (project cc-mikro) so the bill is visible where the Opus
 * turns it replaces are. Exit 0 with the result JSON on stdout when the final
 * attempt is ok; exit 1 otherwise (the result JSON still names every error).
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ZodTypeAny } from 'zod';
import { BoundaryError, type BoundaryMode, type BoundarySession, isBoundaryMode, openBoundary } from './boundary';
import { postRunSpan } from './phoenix';
import { AGENT_NAMES, SCHEMAS, isAgentName } from './schemas';

// ─── Footer ───────────────────────────────────────────────

export interface Footer {
  label: string;
  model: string;
  iterations: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  seconds: number;
  budgetHit: string | null;
  validationFailed: boolean;
  sessionId: string;
}

// `mikro · <label> · <provider/model> · N iterations · X in / Y out · $c · Ns[ · budget hit: k][ · validation_failed: true] · session <id>`
const FOOTER_RE =
  /mikro · (.+?) · (\S+) · (\d+) iterations? · ([\d,]+) in \/ ([\d,]+) out · \$([\d.]+) · ([\d.]+)s((?: · [^·]+?)*?) · session (\S+)\s*$/s;

export function parseFooter(text: string): Footer | null {
  const m = FOOTER_RE.exec(text);
  if (!m) return null;
  const extras = m[8] ?? '';
  const budget = /budget hit: ([^·]+)/.exec(extras);
  return {
    label: m[1].trim(),
    model: m[2],
    iterations: Number(m[3]),
    tokensIn: Number(m[4].replace(/,/g, '')),
    tokensOut: Number(m[5].replace(/,/g, '')),
    cost: Number(m[6]),
    seconds: Number(m[7]),
    budgetHit: budget ? budget[1].trim() : null,
    validationFailed: /validation_failed: true/.test(extras),
    sessionId: m[9],
  };
}

export function stripFooter(text: string): string {
  return text.replace(FOOTER_RE, '').trimEnd();
}

// ─── JSON extraction ─────────────────────────────────────

export function extractJson(text: string): { value: unknown; error?: string } {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)].map((m) => m[1]);
  for (const body of fences.reverse()) {
    try {
      return { value: JSON.parse(body) };
    } catch {
      // try the next fence, then the bare-object fallback
    }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return { value: JSON.parse(text.slice(first, last + 1)) };
    } catch (error) {
      return {
        value: undefined,
        error: `no parseable JSON object (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  return { value: undefined, error: 'no JSON object in the answer' };
}

// ─── Citations ───────────────────────────────────────────

export interface Citation {
  path: string;
  line: number | null;
  ok: boolean;
  reason?: string;
  /** Set when a bare file name resolved to exactly one tracked path (and the line exists there): the answer is rewritten to it. */
  resolvedTo?: string;
}

const CITE_RE = /(?<![\w/@-])((?:[\w.@-]+\/)*[\w.-]+\.(?:tsx?|m?[cj]s|mdx?|ya?ml|json|sh|toml|py)):(\d{1,6})\b/g;
const PATH_KEYS = new Set(['path', 'focusedTest', 'pinning_tests']);

function walk(
  value: unknown,
  onPath: (p: string, ctx: Record<string, unknown>) => void,
  ctx: Record<string, unknown> = {},
): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, onPath, ctx);
    return;
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    for (const [key, v] of Object.entries(rec)) {
      if (PATH_KEYS.has(key)) {
        if (typeof v === 'string') onPath(v, rec);
        else if (Array.isArray(v)) for (const s of v) if (typeof s === 'string') onPath(s, rec);
      }
      walk(v, onPath, rec);
    }
  }
}

const trackedCache = new Map<string, Set<string>>();
const historyCache = new Map<string, Map<string, boolean>>();
function isTracked(dir: string, path: string): boolean {
  let set = trackedCache.get(dir);
  if (!set) {
    set = new Set(Bun.spawnSync(['git', 'ls-files'], { cwd: dir }).stdout.toString().split('\n').filter(Boolean));
    trackedCache.set(dir, set);
  }
  if (set.size === 0) return true; // not a git checkout: nothing to compare against
  return set.has(path) || [...set].some((p) => p.startsWith(`${path.replace(/\/$/, '')}/`));
}

/**
 * True when git has this path in HEAD's history — the proof behind a citation that
 * says a file was deleted. Absent from history means the path never existed, whatever
 * the answer declared. Any git that cannot answer — no repository, no commits, a probe
 * that errors — cannot disprove the claim either, so it answers true and `deletedOk`
 * stands as it did before this check existed, the same fail-open direction `isTracked`
 * takes for an empty tracked set.
 */
function everExisted(dir: string, path: string): boolean {
  let known = historyCache.get(dir);
  if (!known) {
    known = new Map();
    historyCache.set(dir, known);
  }
  const hit = known.get(path);
  if (hit !== undefined) return hit;
  // --literal-pathspecs, not decoration: `--` stops OPTION parsing, it does not stop
  // PATHSPEC interpretation, and git's default wildmatch has no WM_PATHNAME, so `*`
  // crosses `/`. Without this flag `src/*.ts` and even `*.ts` match the history of some
  // other file, and a glob in a deleted `path` field proves a file that never existed.
  const probe = Bun.spawnSync(['git', '--literal-pathspecs', 'rev-list', '--max-count=1', 'HEAD', '--', path], {
    cwd: dir,
  });
  const answered = probe.exitCode === 0;
  const result = !answered || probe.stdout.toString().trim().length > 0;
  known.set(path, result);
  return result;
}

/** Rewrite every citation the verifier resolved from a bare name to its full path, so the answer carries what was verified. */
export function applyResolutions<T>(value: T, citations: Citation[]): T {
  const fixes = citations.filter((c) => c.resolvedTo);
  if (!fixes.length) return value;
  let text = JSON.stringify(value);
  for (const c of fixes) {
    const from = c.line === null ? c.path : `${c.path}:${c.line}`;
    const to = c.line === null ? (c.resolvedTo as string) : `${c.resolvedTo}:${c.line}`;
    text = text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
  }
  return JSON.parse(text) as T;
}

/** Tracked paths ending in /<basename> — the hint that turns a bare-name citation into a converging retry. */
function trackedByBasename(dir: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  try {
    const out = Bun.spawnSync(['git', 'ls-files'], { cwd: dir }).stdout.toString();
    for (const p of out.split('\n')) {
      if (!p) continue;
      const base = p.slice(p.lastIndexOf('/') + 1);
      const list = index.get(base) ?? [];
      list.push(p);
      index.set(base, list);
    }
  } catch {
    // not a git checkout: no hints
  }
  return index;
}

export function verifyCitations(parsed: unknown, dir: string): Citation[] {
  const seen = new Map<string, Citation>();
  let byBase: Map<string, string[]> | null = null;
  const hint = (path: string): string => {
    byBase ??= trackedByBasename(dir);
    const base = path.slice(path.lastIndexOf('/') + 1);
    const candidates = (byBase.get(base) ?? []).filter((p) => p !== path).slice(0, 3);
    return candidates.length
      ? ` (did you mean ${candidates.join(' or ')}? cite the path exactly as printed, from the repository root)`
      : '';
  };
  const lineCounts = new Map<string, number>();
  const countLines = (abs: string): number => {
    let n = lineCounts.get(abs);
    if (n === undefined) {
      n = readFileSync(abs, 'utf8').split('\n').length;
      lineCounts.set(abs, n);
    }
    return n;
  };
  const check = (path: string, line: number | null, deletedOk: boolean) => {
    const key = `${path}:${line ?? ''}`;
    if (seen.has(key)) return;
    const clean = path.replace(/^\.\//, '').split('#')[0];
    if (!clean || clean.startsWith('/') || clean.includes('..')) {
      seen.set(key, { path, line, ok: false, reason: 'not a repository-relative path' });
      return;
    }
    const abs = resolve(dir, clean);
    if (existsSync(abs) && !isTracked(dir, clean) && !deletedOk) {
      seen.set(key, {
        path,
        line,
        ok: false,
        reason: 'not a tracked file (untracked or ignored content is never evidence)',
      });
      return;
    }
    if (!existsSync(abs)) {
      if (!clean.includes('/')) {
        byBase ??= trackedByBasename(dir);
        const unique = byBase.get(clean) ?? [];
        if (unique.length === 1) {
          const target = resolve(dir, unique[0]);
          if (line === null || line <= countLines(target)) {
            seen.set(key, { path, line, ok: true, reason: 'resolved from a bare file name', resolvedTo: unique[0] });
            return;
          }
        }
      }
      // `deletedOk` is the ANSWER's own claim that it deleted this file, so on its
      // own it lets a fabricated path pass as evidence by calling itself deleted —
      // the one hole in the rule that citations must be provable. git decides
      // instead: a path it has never recorded was never there to delete.
      const deleted = deletedOk && everExisted(dir, clean);
      seen.set(key, {
        path,
        line,
        ok: deleted,
        reason: deleted
          ? 'absent (deleted)'
          : deletedOk
            ? `declared deleted, but git has no record of this path${hint(clean)}`
            : `no such file${hint(clean)}`,
      });
      return;
    }
    if (line !== null) {
      if (statSync(abs).isDirectory()) {
        seen.set(key, { path, line, ok: false, reason: 'directory cited with a line' });
        return;
      }
      const total = countLines(abs);
      if (line > total) {
        seen.set(key, { path, line, ok: false, reason: `line ${line} past end (${total} lines)` });
        return;
      }
    }
    seen.set(key, { path, line, ok: true });
  };
  const text = JSON.stringify(parsed);
  for (const m of text.matchAll(CITE_RE)) check(m[1], Number(m[2]), false);
  walk(parsed, (p, ctx) => {
    const bare = p.split(':')[0];
    if (/\s/.test(bare)) return; // a command or a sentence, not a path
    check(bare, null, ctx.change === 'deleted');
  });
  return [...seen.values()];
}

// ─── MCP stdio client ────────────────────────────────────

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class McpClient {
  private proc: ReturnType<typeof Bun.spawn>;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = '';
  readonly stderr: string[] = [];

  /**
   * The ONE place a child command line is assembled. Uncontained it is `mikro mcp --dir <dir>`
   * with the allowlisted environment; under a boundary it is whatever that boundary's argv
   * builder returns for the same command, with the environment set inside the sandbox
   * (`--clearenv --setenv …`), so nothing of the caller's environment reaches the runtime.
   */
  constructor(dir: string, env: Record<string, string | undefined>, boundary?: BoundarySession | null) {
    const command = ['mikro', 'mcp', '--dir', dir];
    const argv = boundary ? boundary.argv(command) : command;
    // Under a boundary the environment comes from the builder and is handed to the bwrap
    // PROCESS, which forwards it to the sandbox. It is never passed as `--setenv`: that would
    // put the provider key and the gh token in a world-readable `/proc/<pid>/cmdline`.
    const spawnEnv = boundary ? boundary.env : env;
    this.proc = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: spawnEnv });
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>);
    void this.drain(this.proc.stderr as ReadableStream<Uint8Array>);
    void this.proc.exited.then((code) => {
      for (const [, p] of this.pending) p.reject(new Error(`mikro mcp exited with code ${code} before answering`));
      this.pending.clear();
    });
  }

  private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split('\n')) if (line.trim()) this.stderr.push(line.slice(0, 400));
      if (this.stderr.length > 200) this.stderr.splice(0, this.stderr.length - 200);
    }
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      this.buf += dec.decode(value);
      for (;;) {
        const i = this.buf.indexOf('\n');
        if (i < 0) break;
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof msg.id !== 'number') continue; // notifications (progress, list_changed)
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? 'mcp error'));
        else p.resolve(msg.result);
      }
    }
  }

  private send(payload: unknown): void {
    (this.proc.stdin as { write: (s: string) => void }).write(`${JSON.stringify(payload)}\n`);
  }

  notify(method: string, params: unknown = {}): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * Killing this process is enough to take the whole sandbox with it: `bwrap` is spawned with
   * `--die-with-parent`, so every process it started (socat, the runtime, any REPL child) dies
   * with it. The existing wall-clock timeout therefore bounds the sandbox, not just the request.
   */
  close(): void {
    try {
      this.proc.kill();
    } catch {
      // already gone
    }
  }
}

// ─── One run ─────────────────────────────────────────────

export interface Attempt {
  attempt: number;
  ok: boolean;
  errors: string[];
  footer: Footer | null;
  citations: Citation[];
  elapsedMs: number;
  raw: string;
}

export interface RunResult {
  ok: boolean;
  agent: string;
  runId: string;
  traceId: string;
  dir: string;
  answer: unknown;
  attempts: Attempt[];
  elapsedMs: number;
  costUsd: number;
  tags: Record<string, string>;
  /** Which arm this run belongs to. `none` is the default and the control arm of every boundary comparison. */
  boundary: BoundaryMode;
  /** CONNECT attempts the boundary's proxy saw, allowed and denied; null when the run was uncontained. */
  egress: { allowed: number; denied: number } | null;
}

export interface RunOptions {
  agent: string;
  prompt: string;
  dir?: string;
  /** Where the agent.yaml folders live; default: this checkout's .mikro/agents, so a --dir cut from origin/<base> still finds them. */
  agentsDir?: string;
  timeoutMs?: number;
  retries?: number;
  tags?: Record<string, string>;
  traceId?: string;
  phoenix?: boolean;
  ledger?: boolean;
  schema?: ZodTypeAny | null;
  /** Where the runtime runs: `none` (the default, and the control arm) or `bwrap` (scripts/mikro/boundary.ts). */
  boundary?: BoundaryMode;
  /** Extra paths bound READ-WRITE inside the boundary — the bench's canary root, so an executed side effect stays observable. */
  boundaryWritable?: string[];
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/**
 * The pricing basis every ledger row and Phoenix span is stamped with, so a
 * reprice is mechanical: rows carrying an older basis keep the USD they were
 * billed at and are never rewritten. `deepseek-list-2026-09-18-peak` is
 * DeepSeek's published per-million list price read on 2026-09-18 from
 * https://api-docs.deepseek.com/quick_start/pricing, declared in
 * `.mikro/mikro.yaml` at the PEAK cache-miss rate (off-peak is half, cache
 * hits are not modelled), so a reported cost is an upper bound.
 */
export const PRICE_BASIS = 'deepseek-list-2026-09-18-peak';

/**
 * The provider key the agents need, for a caller whose environment lacks it (a
 * workflow agent, a launchd job): sourced from the operator's ~/.mikro/gate-env.sh
 * — which resolves it from Bitwarden at source time — and handed to the MCP
 * server's environment only. Nothing is written anywhere.
 */
let cachedKeyEnv: Record<string, string> | null = null;
export function providerKeyEnv(): Record<string, string> {
  if (cachedKeyEnv) return cachedKeyEnv;
  cachedKeyEnv = {};
  if (process.env.DEEPSEEK_API_KEY) return cachedKeyEnv;
  const gate = join(process.env.HOME ?? '', '.mikro', 'gate-env.sh');
  if (!existsSync(gate)) return cachedKeyEnv;
  try {
    const script = `source "${gate.replace(/"/g, '\\"')}" >/dev/null 2>&1; printf %s "$DEEPSEEK_API_KEY"`;
    const out = Bun.spawnSync(['bash', '-lc', script], { env: process.env }).stdout.toString().trim();
    if (out) cachedKeyEnv = { DEEPSEEK_API_KEY: out };
  } catch {
    // no key: the run fails loudly at the provider, never silently
  }
  return cachedKeyEnv;
}

function toolName(agent: string): string {
  return `mikro_${agent.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;
}

/**
 * The GitHub token the contained runtime needs, read from `gh auth token` on the HOST so
 * `~/.config/gh` itself never has to be mounted into the sandbox. Empty when gh cannot
 * answer — `gh` then fails loudly inside, which is the same failure an unauthenticated
 * host already has. Nothing is written anywhere.
 */
let cachedGhToken: Record<string, string> | null = null;
export function ghTokenEnv(): Record<string, string> {
  if (cachedGhToken) return cachedGhToken;
  cachedGhToken = {};
  if (process.env.GH_TOKEN) {
    cachedGhToken = { GH_TOKEN: process.env.GH_TOKEN };
    return cachedGhToken;
  }
  try {
    const probe = Bun.spawnSync(['gh', 'auth', 'token'], { env: process.env });
    const token = probe.exitCode === 0 ? probe.stdout.toString().trim() : '';
    if (token) cachedGhToken = { GH_TOKEN: token };
  } catch {
    // no gh, or no credential: the agents' gh helpers fail inside, never silently succeed
  }
  return cachedGhToken;
}

/** The environment the MCP server gets: an allowlist, never the caller's whole environment (no SSH agent, no tokens the agents were never granted). */
export function serverEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'USER', 'SHELL', 'DEEPSEEK_API_KEY'].includes(k) ||
      k.startsWith('LC_') ||
      k.startsWith('MIKRO_')
    )
      out[k] = v;
  }
  return out;
}

/** mikro's own version, once per process, for the ledger and the span. */
let cachedMikroVersion: string | null = null;
export function mikroVersion(): string {
  if (cachedMikroVersion) return cachedMikroVersion;
  try {
    cachedMikroVersion = Bun.spawnSync(['mikro', '--version']).stdout.toString().trim() || 'unknown';
  } catch {
    cachedMikroVersion = 'unknown';
  }
  return cachedMikroVersion;
}

/**
 * mikro loads <dir>/.mikro/{mikro.yaml,TOOLS.md,SYSTEM.md,CRITERIA.md} from the directory it is
 * pointed at — a project provider entry beats the global one, and TOOLS.md is Python injected into the
 * REPL. A --dir that is the tree under review (an executor worktree cut from a PR) must therefore
 * never supply that config: it is refused unless every such file is byte-identical to the invoking
 * checkout's, or absent.
 */
export function untrustedConfig(dir: string, trustedRoot: string): string | null {
  if (resolve(dir) === resolve(trustedRoot)) return null;
  for (const name of ['mikro.yaml', 'TOOLS.md', 'SYSTEM.md', 'CRITERIA.md']) {
    const theirs = join(dir, '.mikro', name);
    if (!existsSync(theirs)) continue;
    const ours = join(trustedRoot, '.mikro', name);
    if (!existsSync(ours) || readFileSync(theirs, 'utf8') !== readFileSync(ours, 'utf8'))
      return `${theirs} differs from the invoking checkout's .mikro/${name}: refusing to run an agent under configuration taken from the tree under review`;
  }
  return null;
}

export async function runAgent(options: RunOptions): Promise<RunResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const agentsDir = resolve(
    options.agentsDir ?? join(dirname(new URL(import.meta.url).pathname), '..', '..', '.mikro', 'agents'),
  );
  const timeoutMs = options.timeoutMs ?? 600_000;
  const retries = options.retries ?? 1;
  const tags = options.tags ?? {};
  const runId = randomUUID();
  const traceId = options.traceId ?? runId;
  const schema =
    options.schema === undefined ? (isAgentName(options.agent) ? SCHEMAS[options.agent] : null) : options.schema;
  const attempts: Attempt[] = [];
  const started = Date.now();
  const trustedRoot = resolve(agentsDir, '..', '..');
  const boundaryMode: BoundaryMode = options.boundary ?? 'none';
  const untrusted = untrustedConfig(dir, trustedRoot);
  if (untrusted) {
    return {
      ok: false,
      agent: options.agent,
      runId,
      traceId,
      dir,
      answer: undefined,
      attempts: [
        { attempt: 0, ok: false, errors: [`config: ${untrusted}`], footer: null, citations: [], elapsedMs: 0, raw: '' },
      ],
      elapsedMs: 0,
      costUsd: 0,
      tags,
      boundary: boundaryMode,
      egress: null,
    };
  }
  // The sandbox is opened ONCE for the whole run (both attempts share one proxy and one
  // egress ledger) and closed on every exit path. A failure to open is fatal by design:
  // `bwrap` mode never silently downgrades to `none` — the rollback is `--boundary none`.
  const boundary: BoundarySession | null =
    boundaryMode === 'bwrap'
      ? await openBoundary({
          dir,
          agentsDir,
          runId,
          ledgerDir: join(trustedRoot, '.mikro', 'runs'),
          writable: options.boundaryWritable,
          env: {
            ...Object.fromEntries(Object.entries(serverEnv()).filter(([k]) => k.startsWith('MIKRO_'))),
            ...providerKeyEnv(),
            // This slice does NOT take credentials out of the REPL: the provider key and a gh
            // token still live in the contained process. Terminating TLS at the proxy and
            // injecting credentials host-side is the next slice, named in the README.
            ...ghTokenEnv(),
            MIKRO_MCP_RUN_TIMEOUT_MS: String(timeoutMs),
            MIKRO_AGENTS_DIR: agentsDir,
          },
        })
      : null;
  let prompt = options.prompt;
  let answer: unknown;
  let ok = false;
  let cost = 0;

  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const t0 = Date.now();
      const errors: string[] = [];
      let raw = '';
      let footer: Footer | null = null;
      let citations: Citation[] = [];
      const client = new McpClient(
        dir,
        {
          ...serverEnv(),
          ...providerKeyEnv(),
          MIKRO_MCP_RUN_TIMEOUT_MS: String(timeoutMs),
          MIKRO_AGENTS_DIR: agentsDir,
        },
        boundary,
      );
      try {
        await client.request(
          'initialize',
          { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'genie-mikro-call', version: '1' } },
          30_000,
        );
        client.notify('notifications/initialized');
        const result = (await client.request(
          'tools/call',
          { name: toolName(options.agent), arguments: { prompt } },
          timeoutMs + 15_000,
        )) as { content?: { type: string; text?: string }[]; isError?: boolean };
        raw = (result.content ?? []).map((c) => c.text ?? '').join('\n');
        if (result.isError) errors.push(`tool error: ${raw.slice(0, 300)}`);
        footer = parseFooter(raw);
        if (!footer) errors.push('no cost footer in the answer');
        else {
          cost += footer.cost;
          if (footer.budgetHit) errors.push(`budget hit: ${footer.budgetHit}`);
        }
        const body = stripFooter(raw);
        if (!body.trim()) errors.push('empty answer');
        const extracted = extractJson(body);
        if (extracted.error) errors.push(extracted.error);
        else if (schema) {
          const parsed = schema.safeParse(extracted.value);
          if (!parsed.success) {
            for (const issue of parsed.error.issues.slice(0, 12))
              errors.push(`schema: ${issue.path.join('.') || '(root)'} — ${issue.message}`);
          } else {
            citations = verifyCitations(parsed.data, dir);
            answer = applyResolutions(parsed.data, citations);
            for (const c of citations.filter((x) => !x.ok))
              errors.push(`citation: ${c.path}${c.line ? `:${c.line}` : ''} — ${c.reason}`);
          }
        } else {
          citations = verifyCitations(extracted.value, dir);
          answer = applyResolutions(extracted.value, citations);
          for (const c of citations.filter((x) => !x.ok))
            errors.push(`citation: ${c.path}${c.line ? `:${c.line}` : ''} — ${c.reason}`);
        }
      } catch (error) {
        errors.push(`run: ${error instanceof Error ? error.message : String(error)}`);
        const tail = client.stderr.slice(-3).join(' / ');
        if (tail) errors.push(`stderr: ${tail.slice(0, 300)}`);
      } finally {
        client.close();
      }
      const elapsedMs = Date.now() - t0;
      const attemptOk = errors.length === 0;
      attempts.push({ attempt, ok: attemptOk, errors, footer, citations, elapsedMs, raw });
      if (options.ledger !== false) {
        const runsDir = join(trustedRoot, '.mikro', 'runs');
        mkdirSync(runsDir, { recursive: true });
        appendFileSync(
          join(runsDir, `${options.agent}.jsonl`),
          `${JSON.stringify({ runId, traceId, ts: new Date(t0).toISOString(), agent: options.agent, dir, mikro: mikroVersion(), priceBasis: PRICE_BASIS, attempt, ok: attemptOk, errors, footer, citations: citations.filter((c) => !c.ok), elapsedMs, promptSha: sha(options.prompt), tags, boundary: boundaryMode, egress: boundary ? boundary.counts() : null })}\n`,
        );
      }
      if (options.phoenix !== false) {
        await postRunSpan({
          agent: options.agent,
          runId,
          traceId,
          attempt,
          startMs: t0,
          endMs: t0 + elapsedMs,
          model: footer?.model ?? 'unknown',
          iterations: footer?.iterations ?? 0,
          tokensIn: footer?.tokensIn ?? 0,
          tokensOut: footer?.tokensOut ?? 0,
          costUsd: footer?.cost ?? 0,
          ok: attemptOk,
          errors,
          tags: {
            ...tags,
            prompt_sha: sha(options.prompt),
            mikro_version: mikroVersion(),
            price_basis: PRICE_BASIS,
            dir,
            boundary: boundaryMode,
          },
          prompt,
          answer: raw,
        });
      }
      if (attemptOk) {
        ok = true;
        break;
      }
      if (attempt < retries) {
        prompt = `${options.prompt}\n\nYOUR PREVIOUS ATTEMPT FAILED VALIDATION. Do the work again from the starter block and return the complete JSON, fixing every point below:\n${errors.map((e) => `- ${e}`).join('\n')}`;
      }
    }
  } finally {
    await boundary?.close();
  }

  return {
    ok,
    agent: options.agent,
    runId,
    traceId,
    dir,
    answer,
    attempts,
    elapsedMs: Date.now() - started,
    costUsd: cost,
    tags,
    boundary: boundaryMode,
    egress: boundary ? boundary.counts() : null,
  };
}

// ─── CLI ─────────────────────────────────────────────────

/**
 * `--boundary none|bwrap`. An unknown value is REFUSED rather than ignored: a typo
 * that silently ran uncontained would be a boundary that reports itself on and is off.
 */
export function parseBoundaryFlag(argv: string[]): BoundaryMode {
  const i = argv.indexOf('--boundary');
  if (i < 0) return 'none';
  const value = argv[i + 1] ?? '';
  if (!isBoundaryMode(value))
    throw new BoundaryError('bad-spec', `--boundary must be none or bwrap, got ${value || '(missing)'}`);
  return value;
}

function usage(): never {
  process.stderr.write(
    `usage: bun scripts/mikro/call.ts <${AGENT_NAMES.join('|')}> --prompt "<text>" [--prompt-file f] [--dir repo] [--agents-dir dir] [--timeout-ms n] [--retries n] [--tag k=v] [--trace id] [--boundary none|bwrap] [--no-phoenix] [--no-ledger] [--raw]\n`,
  );
  process.exit(2);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const agent = argv[0];
  if (!agent || agent.startsWith('--')) usage();
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(name);
  const tags: Record<string, string> = {};
  argv.forEach((a, i) => {
    if (a === '--tag' && argv[i + 1]?.includes('=')) {
      const [k, ...v] = argv[i + 1].split('=');
      tags[k] = v.join('=');
    }
  });
  const promptFile = opt('--prompt-file');
  const prompt = promptFile ? readFileSync(promptFile, 'utf8') : opt('--prompt');
  if (!prompt) usage();
  let boundary: ReturnType<typeof parseBoundaryFlag>;
  try {
    boundary = parseBoundaryFlag(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const result = await runAgent({
    agent,
    prompt,
    boundary,
    dir: opt('--dir'),
    agentsDir: opt('--agents-dir'),
    timeoutMs: opt('--timeout-ms') ? Number(opt('--timeout-ms')) : undefined,
    retries: opt('--retries') ? Number(opt('--retries')) : undefined,
    tags,
    traceId: opt('--trace'),
    phoenix: !has('--no-phoenix'),
    ledger: !has('--no-ledger'),
  }).catch((error: unknown) => {
    // A boundary that cannot be established aborts the run; it never downgrades to `none`.
    if (error instanceof BoundaryError) {
      process.stderr.write(`boundary (${error.failure}): ${error.message}\nrollback: re-run with --boundary none\n`);
      process.exit(1);
    }
    throw error;
  });
  if (has('--raw')) {
    for (const a of result.attempts)
      process.stdout.write(`--- attempt ${a.attempt} (${a.ok ? 'ok' : 'failed'}) ---\n${a.raw}\n`);
  } else {
    const { attempts, ...rest } = result;
    process.stdout.write(
      `${JSON.stringify({ ...rest, attempts: attempts.map(({ raw, ...a }) => ({ ...a, rawChars: raw.length })) }, null, 2)}\n`,
    );
  }
  process.exit(result.ok ? 0 : 1);
}
