#!/usr/bin/env bun
/**
 * scripts/mikro/call.ts — run ONE genie mikro microagent and return validated JSON.
 *
 *   bun scripts/mikro/call.ts <agent> --prompt "<text>" [--dir <repo>] [--timeout-ms 600000]
 *       [--retries 1] [--agents-dir <dir>] [--agents-ref <ref>] [--facts auto|<path>]
 *       [--tag k=v ...] [--trace <id>] [--boundary none|bwrap] [--no-phoenix] [--raw]
 *
 * Where the agent's prompt comes from is a trust boundary, not a lookup: without
 * `--agents-dir` the files are read from a git REF in the INVOKING checkout
 * (`scripts/mikro/trusted-source.ts`), never from `--dir` and never from the working
 * tree, so a pull request cannot rewrite the prompt or the configuration of the agent
 * that reviews it.
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
 * prompt.
 *
 * `--facts auto` (or `MIKRO_FACTS=auto`) precomputes the mechanical facts for
 * whatever mode the prompt implies (`scripts/mikro/facts.ts`), writes them
 * beside the ledger as `facts-<runId>.{json,md}` and hands the Markdown to the
 * agent through mikro's own MCP `context` argument — so the agent reads and
 * cites instead of re-deriving the same greps on every run. Under
 * `--boundary bwrap` those facts are computed INSIDE the sandbox, after it
 * opens: every `git` runs contained over the read-only tree and `gh` is not run
 * at all (the sandbox holds no credential — `basis.gh: skipped-boundary` says
 * so in the artifact and in the ledger row).
 *
 * Each attempt is appended to `<repo>/.mikro/runs/<agent>.jsonl` and
 * posted to Phoenix (project cc-mikro) so the bill is visible where the Opus
 * turns it replaces are. Exit 0 with the result JSON on stdout when the final
 * attempt is ok; exit 1 otherwise (the result JSON still names every error).
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { ZodTypeAny } from 'zod';
import { BoundaryError, type BoundaryMode, type BoundarySession, isBoundaryMode, openBoundary } from './boundary';
import { type FactsGhSource, type FactsRunner, buildFacts, inferFactsMode, renderFacts } from './facts';
import { postRunSpan } from './phoenix';
import { AGENT_NAMES, SCHEMAS, isAgentName } from './schemas';
import { type StatusGate, makeAncestorCheck, statusLedgerRow, verifyStatus } from './status';
import {
  AGENT_DIR_NAME,
  MIKRO_CONFIG_FILES,
  type MaterializedAgents,
  gitProbeEnv,
  materializeAgent,
  readTrustedBlob,
  refFormatError,
  resolveTrustedRef,
} from './trusted-source';

// The git-environment strip lives with the rest of the trusted-source probes now; it stays
// exported here because it is part of this module's surface (`call.test.ts` reads it).
export { gitProbeEnv };

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
    set = new Set(
      Bun.spawnSync(['git', 'ls-files'], { cwd: dir, env: gitProbeEnv() })
        .stdout.toString()
        .split('\n')
        .filter(Boolean),
    );
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
    env: gitProbeEnv(),
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
    const out = Bun.spawnSync(['git', 'ls-files'], { cwd: dir, env: gitProbeEnv() }).stdout.toString();
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
  const check = (path: string, line: number | null, deletedOk: boolean, declaredNew = false) => {
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
      // A PLAN may name a file that does not exist yet: the prompts allow a `plan.files`
      // entry whose `reason` starts with `NEW:` under a directory the agent printed. It
      // is a proposal, never evidence — so it passes only without a line, only under a
      // directory that exists and holds tracked content, and a `path:line` citation of
      // the same file elsewhere in the answer still fails on its own.
      if (declaredNew && line === null) {
        const parent = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
        const parentOk = parent === '' || (existsSync(resolve(dir, parent)) && isTracked(dir, parent));
        seen.set(key, {
          path,
          line,
          ok: parentOk,
          reason: parentOk
            ? 'new file (declared NEW: under a tracked directory)'
            : `declared NEW:, but ${parent}/ is not a tracked directory${hint(clean)}`,
        });
        return;
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
  // Only a `plan.files` record may carry the marker: a `NEW:` reason anywhere else is prose.
  const plan = (parsed as { plan?: { files?: unknown } } | null)?.plan?.files;
  const planned = new Set<unknown>(Array.isArray(plan) ? plan : []);
  walk(parsed, (p, ctx) => {
    const bare = p.split(':')[0];
    if (/\s/.test(bare)) return; // a command or a sentence, not a path
    const declaredNew = planned.has(ctx) && typeof ctx.reason === 'string' && ctx.reason.startsWith('NEW:');
    check(bare, null, ctx.change === 'deleted', declaredNew);
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
  /**
   * Where the raw text of a FAILED attempt was retained, so a caller whose
   * stdout is gone can still read it. Absent when nothing was written (an ok
   * attempt, an empty answer, `ledger: false`, or a failed write). Named
   * `rawFile` because `raw` here is already the text; the ledger row, which
   * carries no text, calls the same value `raw`.
   */
  rawFile?: RawArtifact;
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
  /**
   * Which source won the agent files — `flag`, `repo@<ref>`, or `shipped`. Reported so a
   * silent fallback cannot hide a repository agent that failed to resolve. Absent
   * only when no source resolved at all.
   */
  agentSource?: string;
  /**
   * Why that source won: which ref was trusted, or why the repository's own agent could
   * not be used (no `origin/HEAD`, no agent at the ref, an archive that did not match the
   * ref). Absent on the flag path, where the operator named the directory.
   */
  agentSourceReason?: string;
}

export interface RunOptions {
  agent: string;
  prompt: string;
  dir?: string;
  /**
   * Where the agent.yaml folders live. Given, it is operator trust and decides the
   * trusted root too; omitted, `resolveAgentsDir` decides — the INVOKING checkout's
   * `.mikro/agents`, then the shipped default. Never derived from `--dir`, which is
   * the tree under review.
   */
  agentsDir?: string;
  /**
   * The ref in the INVOKING checkout whose `.mikro/` content this run trusts. Omitted, it
   * is the base branch that checkout's `origin/HEAD` names (Decision 8). Never resolved
   * in `dir`, which is the tree under review.
   */
  agentsRef?: string;
  /** The invoking checkout to resolve agents and the trusted root from; defaults to `process.cwd()`. Never `dir`. */
  cwd?: string;
  /** Where the shipped default agents live; defaults to `$GENIE_HOME` or `~/.genie`. */
  genieHome?: string;
  timeoutMs?: number;
  retries?: number;
  tags?: Record<string, string>;
  traceId?: string;
  phoenix?: boolean;
  ledger?: boolean;
  schema?: ZodTypeAny | null;
  /**
   * `'auto'` precomputes the deterministic facts for whatever mode this prompt
   * implies; any other value is a path to a facts file to hand over as-is.
   * Defaults to `MIKRO_FACTS`, which is how `bench.ts` turns facts on without
   * a flag of its own.
   */
  facts?: string;
  /** Where the runtime runs: `none` (the default, and the control arm) or `bwrap` (scripts/mikro/boundary.ts). */
  boundary?: BoundaryMode;
  /** Extra paths bound READ-WRITE inside the boundary — the bench's canary root, so an executed side effect stays observable. */
  boundaryWritable?: string[];
  /**
   * How the boundary is opened. Defaults to `openBoundary`, and exists for one reason:
   * the ORDER this function establishes — boundary first, facts computed inside it — is
   * otherwise unprovable without a real bubblewrap host and a real provider key.
   */
  openBoundary?: typeof openBoundary;
}

// ─── Facts ───────────────────────────────────────────────

export interface FactsHandoff {
  /** The JSON artifact, beside the ledger. */
  path: string;
  /** The framed Markdown the MCP `context` argument points at. */
  contextPath: string;
  candidates: number;
  ms: number;
  /**
   * Which `gh` half these facts got — `host`, `off`, or `skipped-boundary` when they
   * were computed inside the sandbox, which holds no GitHub credential. Absent for a
   * caller-supplied `--facts <path>`: this run did not compute that file and has
   * nothing true to say about how it was built.
   */
  gh?: FactsGhSource;
}

/**
 * Where the facts context file for this run WILL be, known before the facts exist.
 * The boundary has to bind that path read-only when it opens, and the facts are
 * computed after it opens — so the path, not the file, is what the two share.
 */
export function factsContextPath(option: string, runsDir: string, runId: string): string {
  return option === 'auto' ? join(runsDir, `facts-${runId}.md`) : resolve(option);
}

/**
 * The runner `buildFacts` gets under a boundary: every argv is wrapped in the open
 * session, so `git` reads the untrusted tree from inside the read-only sandbox with
 * no credential and no network of its own. `canRunGh: false` is the whole point —
 * a host `gh` here would be a credentialed call outside the boundary and outside
 * the egress ledger, which is exactly what the boundary exists to prevent.
 *
 * Spawned SYNCHRONOUSLY, like the host runner it replaces: the egress proxy runs on
 * this process's event loop, and a contained `git` needs no network at all, so there
 * is nothing for a blocked accept loop to starve. The runner's `dir` argument is
 * ignored because the sandbox `--chdir`s to `spec.dir`, which IS the `--dir` these
 * facts are computed over.
 */
export function boundaryFactsRunner(boundary: BoundarySession): FactsRunner {
  return {
    canRunGh: false,
    run(argv) {
      try {
        const p = Bun.spawnSync(boundary.argv(argv), { stdout: 'pipe', stderr: 'pipe', env: boundary.env });
        return { ok: p.exitCode === 0, out: p.stdout.toString() };
      } catch {
        // the sandbox could not run it: this source contributes nothing
        return { ok: false, out: '' };
      }
    },
  };
}

/**
 * The facts a microagent would otherwise re-discover with grep, computed once
 * with no model and handed over as MCP `context`.
 *
 * mikro's agent tool declares a `context` property (`src/mcp/server.ts`,
 * `CONTEXT_PROPERTY`) — a path it loads and externalizes into the REPL as the
 * Python `context` variable, with only its metadata in the message history.
 * That is the right channel and not merely the available one: the agents' third
 * rule is that a path they did not print is a path they may not cite, and a
 * `print(context)` in their own REPL satisfies it. A prompt-appended block
 * would not.
 *
 * The file handed over is Markdown, not the raw JSON, so that the metadata
 * preview mikro puts in the message history is the data frame itself — the
 * agent learns the facts exist without spending a REPL block to find out.
 */
export function prepareFacts(
  option: string,
  prompt: string,
  dir: string,
  runsDir: string,
  runId: string,
  runner?: FactsRunner,
): FactsHandoff | null {
  const t0 = Date.now();
  if (option !== 'auto') {
    const path = factsContextPath(option, runsDir, runId);
    if (!existsSync(path)) return null;
    let candidates = 0;
    try {
      candidates = (JSON.parse(readFileSync(path, 'utf8')) as { candidates?: unknown[] }).candidates?.length ?? 0;
    } catch {
      // a facts file the caller built by hand does not have to be our JSON
    }
    return { path, contextPath: path, candidates, ms: Date.now() - t0 };
  }
  const mode = inferFactsMode(prompt);
  if (!mode) return null; // a `Prepare the review of PR #n` prompt names no base: no facts beats a guessed range
  const facts = buildFacts({ dir, ...mode, runner });
  mkdirSync(runsDir, { recursive: true });
  const path = join(runsDir, `facts-${runId}.json`);
  const contextPath = factsContextPath(option, runsDir, runId);
  writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`);
  writeFileSync(contextPath, renderFacts(facts));
  return { path, contextPath, candidates: facts.candidates.length, ms: Date.now() - t0, gh: facts.basis.gh };
}

// ─── Retained raw ────────────────────────────────────────

/** What a retained raw answer is worth in a row: where it is, how big, and whether it is whole. */
export interface RawArtifact {
  path: string;
  bytes: number;
  /** sha256 of the bytes ON DISK, so `sha256sum <path>` verifies the row. */
  sha256: string;
  truncated: boolean;
}

/** One answer is never worth more than this on disk; a failing agent can emit a very long one. */
export const RAW_CAP_BYTES = 1024 * 1024;
export const RAW_TRUNCATION_MARKER = `\n[truncated by scripts/mikro/call.ts at ${RAW_CAP_BYTES} bytes]\n`;

/**
 * Keep the raw MCP text of a FAILED attempt beside the ledger.
 *
 * Inside a `wish.js` workflow the caller's stdout is gone, so `--raw` retains
 * nothing and a failure class like "no JSON object in the answer" is
 * undiagnosable after the fact — the one thing that would name it (what the
 * model actually said) lived only in memory. This writes it next to the row
 * that reports the failure.
 *
 * The text is UNTRUSTED model output: it is written as bytes and never parsed,
 * executed, or fed anywhere the loop does not already feed it. A write that
 * fails is reported and swallowed — the ledger accelerates diagnosis, it is
 * not a gate on the run.
 */
export function persistFailedRaw(
  runsDir: string,
  runId: string,
  attempt: number,
  raw: string,
): RawArtifact | undefined {
  if (!raw) return undefined;
  try {
    const marker = Buffer.from(RAW_TRUNCATION_MARKER, 'utf8');
    const full = Buffer.from(raw, 'utf8');
    const truncated = full.length > RAW_CAP_BYTES;
    const bytes = truncated ? Buffer.concat([full.subarray(0, RAW_CAP_BYTES - marker.length), marker]) : full;
    mkdirSync(runsDir, { recursive: true });
    const path = join(runsDir, `raw-${runId}-${attempt}.txt`);
    writeFileSync(path, bytes);
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), truncated };
  } catch (error) {
    process.stderr.write(`raw: not retained (${error instanceof Error ? error.message : String(error)})\n`);
    return undefined;
  }
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

/**
 * What carries over from the host into a CONTAINED runtime. The boundary supplies its own
 * PATH/HOME/TMPDIR (the host's name paths the sandbox does not have), so only three things
 * cross: the provider key, a gh token, and `MIKRO_*`.
 *
 * Both key sources are consulted on purpose. `providerKeyEnv()` returns `{}` when the caller's
 * own environment already holds `DEEPSEEK_API_KEY` — on the uncontained path `serverEnv()`
 * carries it, so nothing is lost; reading only `providerKeyEnv()` here would have dropped the
 * key for exactly the callers who export it themselves.
 *
 * This slice does NOT take credentials out of the REPL. Terminating TLS at the proxy and
 * injecting them host-side is the next slice, named in the README's residuals.
 */
export function containedEnv(args: { timeoutMs: number; agentsDir: string }): Record<string, string> {
  const host = serverEnv();
  const carried: Record<string, string> = {};
  for (const [key, value] of Object.entries(host))
    if (key.startsWith('MIKRO_') || key === 'DEEPSEEK_API_KEY') carried[key] = value;
  return {
    ...carried,
    ...providerKeyEnv(),
    ...ghTokenEnv(),
    MIKRO_MCP_RUN_TIMEOUT_MS: String(args.timeoutMs),
    MIKRO_AGENTS_DIR: args.agentsDir,
  };
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

/** The operator's way out of every refusal below, named in each of them. */
const AGENTS_DIR_ESCAPE = 'pass --agents-dir <checkout>/.mikro/agents';

/**
 * What one compared path IS on disk, decided with `lstat` and never by following anything.
 *
 * A compared path that is not a regular file — a directory named `.mikro/TOOLS.md`, a
 * symlink (dangling or not) — is neither absent nor comparable: reading it throws (EISDIR)
 * or reads somewhere else entirely, so it is a refusal of its own. `existsSync` alone
 * answered `false` for a dangling symlink and `true` for a directory it then tried to read.
 */
function comparedFile(path: string): 'absent' | 'file' | 'irregular' {
  try {
    return lstatSync(path).isFile() ? 'file' : 'irregular';
  } catch {
    return 'absent';
  }
}

const irregular = (path: string, why: string): string =>
  `${path} is not a regular file: refusing to run an agent under configuration that cannot be compared ${why} — ${AGENTS_DIR_ESCAPE}`;

/**
 * mikro loads its configuration from the directory it is pointed at
 * ({@link MIKRO_CONFIG_FILES}, mirrored from the runtime's loader) — a project provider
 * entry beats the global one, and TOOLS.md is Python injected into the REPL. A --dir that
 * is the tree under review (an executor worktree cut from a PR) must therefore never
 * supply that config.
 *
 * This is the DIRECTORY comparison, and after the fail-closed amendment to Decision 8 it
 * is used on exactly two paths: an operator-typed `--agents-dir` (operator trust,
 * semantics unchanged — the same-directory exemption included, because that directory IS
 * the operator's authoring tree), and Decision 8's explicit non-git carve-out, where the
 * invoking cwd is no checkout at all and only `--dir` = cwd is accepted with
 * configuration. A run INSIDE a git repository that resolved no ref does NOT land here —
 * it fails closed through {@link unverifiableConfig}.
 */
export function untrustedConfig(dir: string, trustedRoot: string): string | null {
  if (resolve(dir) === resolve(trustedRoot)) return null;
  for (const rel of MIKRO_CONFIG_FILES) {
    const theirs = join(dir, rel);
    const kind = comparedFile(theirs);
    if (kind === 'absent') continue;
    if (kind === 'irregular') return irregular(theirs, 'against the invoking checkout');
    const ours = join(trustedRoot, rel);
    if (comparedFile(ours) !== 'file' || readFileSync(theirs, 'utf8') !== readFileSync(ours, 'utf8'))
      return `${theirs} differs from the invoking checkout's ${rel}: refusing to run an agent under configuration taken from the tree under review`;
  }
  return null;
}

/**
 * The same rule against the TRUSTED REF instead of a directory — the no-flag path, for
 * EVERY `--dir` (the invoking checkout included) and on every agent source (`shipped`
 * included).
 *
 * There is deliberately no same-directory exemption here: a session started inside a PR
 * checkout must not trust that checkout's `TOOLS.md` just because the process happens to
 * have been launched in it. The consequence is stated rather than hidden — an UNCOMMITTED
 * edit to one of the compared files refuses every no-flag call — so the message names the
 * escape, which is the operator-typed flag whose semantics are unchanged.
 */
export function untrustedConfigAtRef(
  dir: string,
  invokingRoot: string,
  ref: string,
  readBlob: typeof readTrustedBlob = readTrustedBlob,
): string | null {
  for (const rel of MIKRO_CONFIG_FILES) {
    const theirs = join(dir, rel);
    const kind = comparedFile(theirs);
    if (kind === 'absent') continue;
    if (kind === 'irregular') return irregular(theirs, `against ${ref}`);
    const trusted = readBlob(invokingRoot, ref, rel);
    if (trusted === null || readFileSync(theirs, 'utf8') !== trusted)
      return `${theirs} ${trusted === null ? 'is absent at' : 'differs from'} ${ref} in the invoking checkout: refusing to run an agent under configuration the trusted ref does not carry — to run with your own working tree instead, ${AGENTS_DIR_ESCAPE}`;
  }
  return null;
}

/**
 * The fail-closed path: the invoking cwd IS a git repository, and no trusted ref resolved.
 *
 * Falling back to the directory comparison here was the hole Decision 8 exists to close —
 * its same-directory exemption meant a session started inside a PR checkout trusted that
 * PR's own `TOOLS.md`, and three ordinary states reach it: a checkout with no
 * `refs/remotes/origin/HEAD` (a CI checkout, a `git init` + `fetch`, a worktree of either),
 * a STALE `origin/HEAD` after a default-branch rename, and a well-formed `--agents-ref`
 * that names no commit. The agent degrades to the shipped default in all three (it is
 * genie's own payload, not the tree under review); the CONFIGURATION cannot degrade,
 * because nothing can vouch for it. So any compared file present in `--dir` — the invoking
 * checkout included — refuses the run at zero cost, and the message names all three
 * remedies. A `--dir` carrying none of them still runs.
 */
export function unverifiableConfig(dir: string, refReason: string): string | null {
  for (const rel of MIKRO_CONFIG_FILES) {
    const theirs = join(dir, rel);
    if (comparedFile(theirs) === 'absent') continue;
    return `${theirs} cannot be verified: the invoking checkout resolved no trusted ref (${refReason}), so nothing can vouch for this configuration — name one with --agents-ref <ref>, give the checkout a base with git remote set-head origin -a, or ${AGENTS_DIR_ESCAPE}`;
  }
  return null;
}

// ─── Where the agent files and the ledger live ───────────

/**
 * Global genie state root — `$GENIE_HOME` or `~/.genie`, the same rule
 * `src/lib/genie-home.ts` applies. Restated here rather than imported: this
 * module is the runtime `src/term-commands/mikro.ts` imports, never the other
 * way round, and one `join(homedir(), '.genie')` is not worth a cycle.
 */
export function resolveMikroGenieHome(): string {
  return process.env.GENIE_HOME || join(homedir(), '.genie');
}

/** The default agents this release ships, converged into `<GENIE_HOME>/templates` by install and update. */
export function shippedAgentsRoot(genieHome: string): string {
  return join(genieHome, 'templates', 'mikro', 'agents');
}

/** stdout of one git probe, or null when git did not answer — no git binary, no repository, an unreadable index. */
function gitProbe(args: string[]): string | null {
  try {
    const probe = Bun.spawnSync(['git', ...args], { env: gitProbeEnv() });
    return probe.exitCode === 0 ? probe.stdout.toString() : null;
  } catch {
    return null;
  }
}

/** The git toplevel of `cwd`, or null outside a checkout. */
export function gitToplevel(cwd: string): string | null {
  const out = gitProbe(['-C', cwd, 'rev-parse', '--show-toplevel'])?.trim() ?? '';
  return out ? resolve(out) : null;
}

const hasAgent = (root: string, agent: string): boolean => existsSync(join(root, agent, 'agent.yaml'));

export interface ResolvedAgents {
  dir: string;
  trustedRoot: string;
  source: 'flag' | 'repo' | 'shipped';
  /**
   * The trusted ref this run compares `<dir>/.mikro/` against, and the ref a `repo`
   * agent was materialized from. Absent on the flag path (where the operator's
   * directory is the trust) and when no ref could be resolved at all.
   */
  ref?: string;
  /** Why this source won — reported whenever the repository's own agent was not used. */
  reason?: string;
  /**
   * The git toplevel of the invoking cwd, when there is one. Absent means the process was
   * started outside any checkout — Decision 8's non-git carve-out, and the ONLY state in
   * which a missing trusted ref falls back to the directory comparison rather than failing
   * closed. Not set on the flag path, which never consults a ref.
   */
  invokingRoot?: string;
  /** Removes materialized temp material. Absent unless something was materialized. */
  dispose?: () => void;
}

/**
 * Where this agent's files are read from, and what its `.mikro/` configuration is
 * trusted against. The registry decides the NAME (`schemas.ts`); this decides only WHERE.
 *
 * Order: the operator-typed `--agents-dir` → the invoking checkout's own
 * `.mikro/agents/<agent>` AT THE TRUSTED REF → the shipped default under
 * `<GENIE_HOME>/templates`. The repository's WORKING TREE is never consulted on the
 * no-flag path: that tree is what a pull request controls, and this is the one lookup a
 * pull request must not be able to reach. `import.meta.url` is not consulted either —
 * inside a compiled binary it resolves under `/$bunfs`, which holds no agent at all.
 *
 * The trusted root is the invoking checkout for every source that is not the flag —
 * never `<GENIE_HOME>/templates`, which is genie's payload rather than a repository.
 * With the flag it stays what it has always been: two levels above the agents dir.
 */
export function resolveAgentsDir(options: {
  agentsDir?: string;
  agentsRef?: string;
  cwd: string;
  genieHome: string;
  agent: string;
}): ResolvedAgents | null {
  if (options.agentsDir) {
    const dir = resolve(options.agentsDir);
    return { dir, trustedRoot: resolve(dir, '..', '..'), source: 'flag' };
  }
  if (!AGENT_DIR_NAME.test(options.agent)) return null;
  const repoRoot = gitToplevel(options.cwd);
  const trustedRoot = repoRoot ?? resolve(options.cwd);
  const trusted = repoRoot
    ? resolveTrustedRef(repoRoot, options.agentsRef)
    : { ref: null, reason: `${trustedRoot} is no git checkout, so it carries no trusted ref` };
  const invoking = repoRoot ? { invokingRoot: repoRoot } : {};
  let material: MaterializedAgents | null = null;
  /** Why the SHIPPED agent won, if it does: the ref that could not be resolved, or the agent that could not be materialized from it. */
  let shippedReason = trusted.reason;
  if (repoRoot && trusted.ref) {
    material = materializeAgent(repoRoot, trusted.ref, options.agent, (why) => {
      shippedReason = why;
    });
  }
  if (material)
    return {
      dir: material.agentsDir,
      trustedRoot,
      source: 'repo',
      ref: trusted.ref ?? undefined,
      reason: trusted.reason,
      ...invoking,
      dispose: material.dispose,
    };
  const shipped = shippedAgentsRoot(options.genieHome);
  if (hasAgent(shipped, options.agent))
    return {
      dir: shipped,
      trustedRoot,
      source: 'shipped',
      ref: trusted.ref ?? undefined,
      reason: shippedReason,
      ...invoking,
    };
  return null;
}

/**
 * A repository opted into mikro when it carries a `.mikro/` directory git tracks —
 * or when it is no git checkout at all, where nothing CAN be tracked and the
 * directory's presence is the whole signal.
 *
 * When `ls-files` cannot answer, the fallback is deliberately asymmetric: a tree that
 * IS a checkout (a readable toplevel, an unreadable index) gets the `<GENIE_HOME>`
 * ledger, because growing an untracked directory inside somebody's repository is the
 * worse failure of the two.
 */
function optedIntoMikro(root: string): boolean {
  if (!existsSync(join(root, '.mikro'))) return false;
  const tracked = gitProbe(['-C', root, 'ls-files', '--', '.mikro']);
  if (tracked !== null) return tracked.trim().length > 0;
  return gitToplevel(root) === null;
}

/**
 * Where the run ledger, the facts artifacts and the retained raw answers go.
 * A repository that never opted into mikro must not grow untracked files, so its
 * rows live under `<GENIE_HOME>/mikro/runs/<basename>-<sha256(root)[:8]>` instead —
 * the hash, not the name, is what keeps two checkouts of the same repository apart.
 */
export function resolveRunsDir(trustedRoot: string, genieHome: string): string {
  if (optedIntoMikro(trustedRoot)) return join(trustedRoot, '.mikro', 'runs');
  const slug = `${basename(trustedRoot) || 'root'}-${createHash('sha256').update(trustedRoot).digest('hex').slice(0, 8)}`;
  return join(genieHome, 'mikro', 'runs', slug);
}

/**
 * The one failure that is not the agent's: the `mikro` runtime is not runnable on
 * this host. Classified by the spawn error's `code`, never by its message — Node
 * says `spawn mikro ENOENT` and Bun says `Executable not found in $PATH: "mikro"`,
 * and only the code is the same under both.
 */
export function unavailableReason(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== 'ENOENT' && code !== 'EACCES') return null;
  return `unavailable: the mikro runtime is not runnable on this host (${String(code)}) — install mikro and put it on PATH; nothing was billed`;
}

export async function runAgent(options: RunOptions): Promise<RunResult> {
  const dir = resolve(options.dir ?? process.cwd());
  const genieHome = options.genieHome ?? resolveMikroGenieHome();
  const resolvedAgents = resolveAgentsDir({
    agentsDir: options.agentsDir,
    agentsRef: options.agentsRef,
    cwd: resolve(options.cwd ?? process.cwd()),
    genieHome,
    agent: options.agent,
  });
  const timeoutMs = options.timeoutMs ?? 600_000;
  const retries = options.retries ?? 1;
  const tags = options.tags ?? {};
  const runId = randomUUID();
  const traceId = options.traceId ?? runId;
  const schema =
    options.schema === undefined ? (isAgentName(options.agent) ? SCHEMAS[options.agent] : null) : options.schema;
  const attempts: Attempt[] = [];
  const started = Date.now();
  const boundaryMode: BoundaryMode = options.boundary ?? 'none';
  /** One refusal, before anything is spawned or billed: the run never started. */
  const refused = (error: string, agentSource?: string, agentSourceReason?: string): RunResult => ({
    ok: false,
    agent: options.agent,
    runId,
    traceId,
    dir,
    answer: undefined,
    attempts: [{ attempt: 0, ok: false, errors: [error], footer: null, citations: [], elapsedMs: 0, raw: '' }],
    elapsedMs: 0,
    costUsd: 0,
    tags,
    boundary: boundaryMode,
    egress: null,
    agentSource,
    agentSourceReason,
  });
  if (!resolvedAgents)
    return refused(
      `no agent: ${options.agent} is at neither the invoking checkout's trusted ref nor ${shippedAgentsRoot(genieHome)} — run genie update, or pass --agents-dir`,
    );
  const { dir: agentsDir, trustedRoot, ref: trustedRef, reason: agentSourceReason } = resolvedAgents;
  /** `repo@<ref>` names WHICH ref answered: a repository agent that failed to resolve cannot hide behind a silent fallback. */
  const agentSource = resolvedAgents.source === 'repo' ? `repo@${trustedRef}` : resolvedAgents.source;
  let boundary: BoundarySession | null = null;
  let prompt = options.prompt;
  let answer: unknown;
  let ok = false;
  let cost = 0;
  /** A runtime that is not installed will not appear between two attempts: retrying it buys nothing. */
  let runtimeMissing = false;

  // The materialized agent tree is removed on EVERY exit path — a finished run, a failed
  // one, a refusal, and a throw from anything below — which is why the CONFIGURATION
  // COMPARISON and the boundary open are both inside this try. The comparison sat outside
  // it once: a compared path that was a directory threw EISDIR out of `runAgent` and the
  // 0700 temp tree leaked.
  try {
    // Three states, and only three. The flag is operator trust and keeps the directory
    // comparison, same-directory exemption included. With a trusted ref, `<dir>`'s
    // configuration is compared against that ref — every `--dir`, the invoking checkout
    // included, on every source. IN a git checkout with no resolvable ref there is nothing
    // that can vouch for the configuration, so it fails closed; only Decision 8's non-git
    // carve-out (no checkout at all) still falls back to the directory comparison.
    const untrusted =
      resolvedAgents.source === 'flag'
        ? untrustedConfig(dir, trustedRoot)
        : trustedRef
          ? untrustedConfigAtRef(dir, trustedRoot, trustedRef)
          : resolvedAgents.invokingRoot
            ? unverifiableConfig(dir, agentSourceReason ?? 'no ref resolved')
            : untrustedConfig(dir, trustedRoot);
    if (untrusted) return refused(`config: ${untrusted}`, agentSource, agentSourceReason);
    const runsDir = resolveRunsDir(trustedRoot, genieHome);
    const factsOption = options.facts ?? process.env.MIKRO_FACTS;
    // The status gate's two proofs, built once per run: the ancestor probe caches per ref
    // and `verifyCitations` caches the tracked set per dir. `citationOk` re-enters the
    // citation gate through its own regex — an extension it does not recognize yields no
    // citation at all, which reads as unverifiable, which is the fail-closed direction.
    const statusGate: StatusGate = {
      isAncestor: makeAncestorCheck(dir),
      citationOk: (path, line) =>
        verifyCitations({ cite: `${path}:${line}` }, dir).some((c) => c.ok && c.line === line),
    };
    // The sandbox is opened ONCE for the whole run (both attempts and the facts scan share
    // one proxy and one egress ledger) and closed on every exit path. A failure to open is
    // fatal by design: `bwrap` mode never silently downgrades to `none` — the rollback is
    // `--boundary none`.
    //
    // It opens BEFORE the facts are computed, and that order is the security property, not a
    // detail: `facts.ts` runs `git` over the tree under `--dir` and `gh` with the host's
    // credential, so computing them first put a credentialed GitHub call and a git run over
    // an untrusted tree on the bare host — outside the sandbox and outside the egress ledger,
    // which is precisely the traffic the boundary exists to contain.
    boundary =
      boundaryMode === 'bwrap'
        ? await (options.openBoundary ?? openBoundary)({
            dir,
            agentsDir,
            runId,
            ledgerDir: runsDir,
            writable: options.boundaryWritable,
            // The facts file lives under the TRUSTED root, which is not `dir` when `--dir` is a
            // worktree; without this bind the agent is handed a `context:` path it cannot read.
            readable: factsOption ? [factsContextPath(factsOption, runsDir, runId)] : [],
            env: containedEnv({ timeoutMs, agentsDir }),
          })
        : null;
    // Computed once, inside the boundary when there is one, before the loop: a retry
    // re-reads the same facts rather than paying for a second identical scan.
    let facts: FactsHandoff | null = null;
    if (factsOption) {
      try {
        facts = prepareFacts(
          factsOption,
          options.prompt,
          dir,
          runsDir,
          runId,
          boundary ? boundaryFactsRunner(boundary) : undefined,
        );
      } catch (error) {
        // facts are an accelerator, never a gate: a tree they cannot be computed
        // over (no git history, an unreadable CLAUDE.md) still gets its run.
        process.stderr.write(`facts: skipped (${error instanceof Error ? error.message : String(error)})\n`);
      }
    }
    const factsRow = facts ? { path: facts.path, candidates: facts.candidates, ms: facts.ms, gh: facts.gh } : undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const t0 = Date.now();
      const errors: string[] = [];
      let raw = '';
      let footer: Footer | null = null;
      let citations: Citation[] = [];
      let statusRow: ReturnType<typeof statusLedgerRow>;
      let client: McpClient | null = null;
      try {
        client = new McpClient(
          dir,
          {
            ...serverEnv(),
            ...providerKeyEnv(),
            MIKRO_MCP_RUN_TIMEOUT_MS: String(timeoutMs),
            MIKRO_AGENTS_DIR: agentsDir,
          },
          boundary,
        );
        await client.request(
          'initialize',
          { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'genie-mikro-call', version: '1' } },
          30_000,
        );
        client.notify('notifications/initialized');
        const result = (await client.request(
          'tools/call',
          { name: toolName(options.agent), arguments: facts ? { prompt, context: facts.contextPath } : { prompt } },
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
            // Two silent post-validation rewrites, in order: the citation paths the verifier
            // resolved, then the status gate's own verdict. Neither is an error, neither retries.
            answer = verifyStatus(applyResolutions(parsed.data, citations), statusGate);
            statusRow = statusLedgerRow(answer);
            for (const c of citations.filter((x) => !x.ok))
              errors.push(`citation: ${c.path}${c.line ? `:${c.line}` : ''} — ${c.reason}`);
          }
        } else {
          citations = verifyCitations(extracted.value, dir);
          answer = verifyStatus(applyResolutions(extracted.value, citations), statusGate);
          statusRow = statusLedgerRow(answer);
          for (const c of citations.filter((x) => !x.ok))
            errors.push(`citation: ${c.path}${c.line ? `:${c.line}` : ''} — ${c.reason}`);
        }
      } catch (error) {
        // A runtime that is not installed is not an agent failure: it is named as
        // `unavailable:` so a caller can tell "mikro is missing" from "the agent was wrong".
        const unavailable = unavailableReason(error);
        if (unavailable) runtimeMissing = true;
        errors.push(unavailable ?? `run: ${error instanceof Error ? error.message : String(error)}`);
        const tail = client?.stderr.slice(-3).join(' / ') ?? '';
        if (tail) errors.push(`stderr: ${tail.slice(0, 300)}`);
      } finally {
        client?.close();
      }
      const elapsedMs = Date.now() - t0;
      const attemptOk = errors.length === 0;
      // Retained for failures only, and only where the ledger itself is on: the
      // file is the row's evidence, so the two live and die together.
      const rawFile =
        !attemptOk && options.ledger !== false ? persistFailedRaw(runsDir, runId, attempt, raw) : undefined;
      attempts.push({ attempt, ok: attemptOk, errors, footer, citations, elapsedMs, raw, rawFile });
      if (options.ledger !== false) {
        mkdirSync(runsDir, { recursive: true });
        appendFileSync(
          join(runsDir, `${options.agent}.jsonl`),
          `${JSON.stringify({ runId, traceId, ts: new Date(t0).toISOString(), agent: options.agent, agentSource, dir, mikro: mikroVersion(), priceBasis: PRICE_BASIS, attempt, ok: attemptOk, errors, footer, citations: citations.filter((c) => !c.ok), status: statusRow, elapsedMs, promptSha: sha(options.prompt), facts: factsRow, tags, boundary: boundaryMode, egress: boundary ? boundary.counts() : null, raw: rawFile })}\n`,
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
          factsCandidates: facts?.candidates,
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
      if (runtimeMissing) break;
      if (attempt < retries) {
        prompt = `${options.prompt}\n\nYOUR PREVIOUS ATTEMPT FAILED VALIDATION. Do the work again from the starter block and return the complete JSON, fixing every point below:\n${errors.map((e) => `- ${e}`).join('\n')}`;
      }
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
      agentSource,
      agentSourceReason,
    };
  } finally {
    await boundary?.close();
    resolvedAgents.dispose?.();
  }
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

export const CALL_USAGE = `usage: genie mikro call <${AGENT_NAMES.join('|')}> --prompt "<text>" [--prompt-file f] [--dir repo] [--agents-dir dir] [--agents-ref ref] [--facts auto|<path>] [--timeout-ms n] [--retries n] [--tag k=v] [--trace id] [--boundary none|bwrap] [--no-phoenix] [--no-ledger] [--raw]
       (inside this checkout the same code runs as: bun scripts/mikro/call.ts <agent> …)
`;

function usage(reason?: string): number {
  if (reason) process.stderr.write(`${reason}\n`);
  process.stderr.write(CALL_USAGE);
  return 2;
}

/**
 * The `call` CLI, exported so `genie mikro call` and `bun scripts/mikro/call.ts`
 * are one code path rather than two that drift. It returns the exit code — 0 ok,
 * 1 not ok, 2 usage — and never calls `process.exit` itself, because inside the
 * genie binary this runs as one command of a longer-lived process.
 *
 * The argv it takes is the flag vocabulary above, forwarded untouched: the
 * genie command declares no options of its own, so a flag added here needs no
 * second edit in `src/term-commands/mikro.ts`.
 */
export async function runCallCli(argv: string[]): Promise<number> {
  const agent = argv[0];
  if (!agent || agent.startsWith('--')) return usage();
  // The registry decides the agent NAME; a directory or a ref decides only where its
  // files are read from. An unregistered name has no answer schema, so it is a usage
  // error rather than a run that could only fail after it was billed.
  if (!isAgentName(agent)) return usage(`unknown agent: ${agent}`);
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
  if (!prompt) return usage('--prompt or --prompt-file is required');
  // A malformed ref is a usage refusal, checked before anything is spawned: the token is
  // joined into a git command line, so `-anything` never reaches git as an argument. A
  // well-formed ref that names no commit is NOT refused here — it degrades to the shipped
  // agents with its reason, so a repository with no `origin/<base>` still gets a run.
  const agentsRef = opt('--agents-ref');
  if (agentsRef !== undefined) {
    const bad = refFormatError(agentsRef);
    if (bad) return usage(`--agents-ref ${bad}`);
  }
  let boundary: ReturnType<typeof parseBoundaryFlag>;
  try {
    boundary = parseBoundaryFlag(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let result: RunResult;
  try {
    result = await runAgent({
      agent,
      prompt,
      boundary,
      dir: opt('--dir'),
      agentsDir: opt('--agents-dir'),
      agentsRef,
      facts: opt('--facts'),
      timeoutMs: opt('--timeout-ms') ? Number(opt('--timeout-ms')) : undefined,
      retries: opt('--retries') ? Number(opt('--retries')) : undefined,
      tags,
      traceId: opt('--trace'),
      phoenix: !has('--no-phoenix'),
      ledger: !has('--no-ledger'),
    });
  } catch (error) {
    // A boundary that cannot be established aborts the run; it never downgrades to `none`.
    if (error instanceof BoundaryError) {
      process.stderr.write(`boundary (${error.failure}): ${error.message}\nrollback: re-run with --boundary none\n`);
      return 1;
    }
    throw error;
  }
  if (has('--raw')) {
    for (const a of result.attempts)
      process.stdout.write(`--- attempt ${a.attempt} (${a.ok ? 'ok' : 'failed'}) ---\n${a.raw}\n`);
  } else {
    const { attempts, ...rest } = result;
    process.stdout.write(
      `${JSON.stringify({ ...rest, attempts: attempts.map(({ raw, ...a }) => ({ ...a, rawChars: raw.length })) }, null, 2)}\n`,
    );
  }
  return result.ok ? 0 : 1;
}

// No top-level `await`: this module is imported by the genie CLI, where
// `import.meta.main` is false and nothing below must run.
if (import.meta.main) {
  void runCallCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
