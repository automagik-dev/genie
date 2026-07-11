/**
 * Omni runner — the one resident process (`genie omni serve`).
 *
 * Owns the NATS transport and the two-way bridge between the phone and the
 * global approval queue:
 *   - subscribes `omni.message.{instance}.>` — both text replies AND reactions
 *     arrive here. A WhatsApp reaction reaches genie as a `message.received`
 *     whose content is `[Reaction: <emoji> on message <targetId>]` (the target
 *     id is also the top-level `messageId`); the legacy `omni.event.>` subject
 *     has zero publishers in this Omni build, so it is retired (SPIKE finding a);
 *   - on each new pending approval row, SENDS an approval-request over the Omni
 *     HTTP API (an id-returning send) and tags the row with the REAL Omni
 *     message id (the WhatsApp stanza id) the send returns — so an inbound
 *     reaction can be correlated to the exact approval it targets, rather than
 *     the old self-referential `genId()` ref that matched nothing (SPIKE b);
 *   - matches inbound replies/reactions against the approve/deny vocabulary and
 *     resolves the correlated approval (reaction → the stored stanza id; bare
 *     text → oldest-pending fallback);
 *   - records and atomically claims every inbound message in the inbox. One-shot
 *     agent spawning on inbound is Group 4 — this group only stores.
 *
 * The hook handler never touches NATS: it enqueues a row and polls the DB. This
 * runner is the only NATS client, so `genie --help`/`task`/`board` never
 * initialize the transport (proven by the {@link natsConnectionCount} marker).
 *
 * NATS is injected behind {@link NatsLike} so tests drive a fake with zero
 * network. The real transport is a dynamic `import('nats')` — never a top-level
 * import — so merely loading this module costs nothing.
 */

import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OmniRoute, OmniRuntimeConfig } from './omni-config.js';
import { matchReaction, matchTextToken } from './omni-matching.js';
import { signOmniRequest } from './omni-signature.js';
import { resolveTrustedExecutable } from './trusted-executable.js';
import {
  acquireServiceLeaseEpoch,
  clearAgentSessionIfCurrent,
  getAgentSession,
  insertAgentSessionIfAbsent,
  releaseServiceLease,
  renewServiceLease,
  replaceAgentSessionIfCurrent,
} from './v5/global-db.js';
import {
  ApprovalConflictError,
  type ApprovalDecision,
  type DurableClaimIdentity,
  type InboundClaimResult,
  type InboundPreparedDelivery,
  claimApprovalAnnouncementWithLease,
  expireStale,
  finalizeApprovalAnnouncement,
  listApprovalsNeedingStatusAck,
  listPendingApprovals,
  listRecoverableInbound,
  markApprovalAnnouncementAmbiguous,
  markApprovalAnnouncementSending,
  markInboundDeliveryFlushed,
  markInboundHandledIfClaimed,
  prepareInboundDelivery,
  recordAndClaimInboundDelivery,
  recordStatusGlyph,
  releaseApprovalAnnouncementWithLease,
  releaseInboundClaim,
  resolveApproval,
} from './v5/omni-queue.js';

// ============================================================================
// Injectable NATS surface
// ============================================================================

export interface NatsInboundMsg {
  subject: string;
  data: Uint8Array;
}

export interface NatsSubscription extends AsyncIterable<NatsInboundMsg> {
  unsubscribe(): void;
}

export interface NatsLike {
  subscribe(subject: string): NatsSubscription;
  publish(subject: string, payload: string): void;
  /** Await until all locally buffered publishes have crossed the NATS protocol
   * flush boundary. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type NatsFactory = (opts: { servers: string }) => Promise<NatsLike>;

/** Process-lifetime count of real NATS connections opened. Stays 0 unless
 *  `omni serve` actually runs — the "transport not initialized" marker. */
let natsConnections = 0;
export function natsConnectionCount(): number {
  return natsConnections;
}

// ============================================================================
// Injectable one-shot `claude -p` spawn surface
// ============================================================================

export interface SpawnClaudeOpts {
  /** The inbound message text, passed as the `claude -p "<message>"` prompt. */
  message: string;
  /** Working directory of the child — the mapped route's absolute repo dir. */
  cwd: string;
  /** Aborted when the run exceeds its budget; the child MUST be killed on abort. */
  signal: AbortSignal;
  /**
   * Absolute path to a persona / AGENTS.md file appended to Claude Code's system
   * prompt (`--append-system-prompt-file`). Absent → no persona is appended.
   */
  personaFile?: string;
  /**
   * Stable `--session-id` (UUID) so a conversation RESUMES across messages. The
   * runner derives it deterministically from (instance, chat); if a caller omits
   * it the executor generates a fresh one defensively.
   */
  sessionId?: string;
}

export interface SpawnClaudeResult {
  /**
   * The FINAL assistant reply text — already parsed out of Claude's stream-json
   * stdout (truncated to the reply cap before publishing). See
   * {@link extractStreamJsonReply}.
   */
  stdout: string;
  /**
   * The child's captured stderr, verbatim. Surfaced (tail-bounded) in the
   * failure notice on a non-zero exit — a claude crash explains itself on
   * stderr, not in the stream-json stdout. Optional so fake executors that
   * never fail can omit it.
   */
  stderr?: string;
  /** Process exit code; non-zero is surfaced as a bounded error notice. */
  exitCode: number;
  /**
   * True when the turn is a SOFT failure despite exit 0: the terminal stream-json
   * result was `is_error` / a non-success subtype / an empty result. `runOneShot`
   * treats `(exitCode !== 0 || isError)` as failure so such a turn gets an error
   * notice + ❌ instead of publishing the (possibly raw NDJSON) blob tagged ✅.
   */
  isError?: boolean;
}

/** Bounded one-shot `claude -p` executor. Injectable so tests never fork claude. */
export type SpawnClaude = (opts: SpawnClaudeOpts) => Promise<SpawnClaudeResult>;

/**
 * Which session flag to spawn with. `claude --session-id <id>` CREATES a session
 * (and errors "already in use" if the id exists); `claude --resume <id>` CONTINUES
 * an existing one. {@link runClaudeSession} tries `resume` first and only falls
 * back to `create` when the session does not exist yet — verified against claude
 * 2.1.201.
 */
export type ClaudeSessionMode = 'create' | 'resume';

/**
 * Build the `claude` argv for one bounded one-shot run (Model A). Streams the
 * turn as NDJSON (`--output-format stream-json`, which requires `-p`/`--print`
 * AND `--verbose`), binds the stable session id via `--resume` (continue) or
 * `--session-id` (create), and appends the persona to the system prompt when one
 * is resolved. The message positional is always preceded by `--` (commander's
 * option terminator, verified live against `claude -p -- '-ping'`) so a
 * hyphen-leading inbound (e.g. `--version`) is passed as the prompt, never
 * parsed as a flag. Pure + exported so the arg contract is unit-tested without
 * forking.
 */
export function buildClaudeArgs(opts: {
  message: string;
  sessionId: string;
  personaFile?: string;
  mode: ClaudeSessionMode;
}): string[] {
  const sessionFlag = opts.mode === 'resume' ? ['--resume', opts.sessionId] : ['--session-id', opts.sessionId];
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    ...sessionFlag,
    ...(opts.personaFile ? ['--append-system-prompt-file', opts.personaFile] : []),
    '--',
    opts.message,
  ];
}

/** Parsed final reply + whether the turn ended in an error (soft or hard). */
export interface ParsedReply {
  reply: string;
  isError: boolean;
}

/** One decoded `stream-json` NDJSON event (fields are all optional/loose). */
type StreamJsonEvent = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  message?: { content?: unknown };
};

/** Parse NDJSON stdout into its JSON-object events, skipping blank/non-JSON lines. */
function parseNdjsonEvents(raw: string): StreamJsonEvent[] {
  const events: StreamJsonEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt && typeof evt === 'object') events.push(evt as StreamJsonEvent);
    } catch {
      // skip a non-JSON line (log noise / partial frame)
    }
  }
  return events;
}

/** Concatenate the `text` blocks of one `assistant` event's message content. */
function assistantEventText(o: StreamJsonEvent): string {
  if (!o.message || !Array.isArray(o.message.content)) return '';
  let text = '';
  for (const block of o.message.content as Array<{ type?: string; text?: string }>) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

/**
 * Extract the final assistant reply from Claude's `stream-json` stdout (NDJSON,
 * one JSON event per line). Preference order:
 *   1. the terminal `{"type":"result","subtype":"success","is_error":false,
 *      "result":"<text>"}` event with a NON-EMPTY result — the canonical answer;
 *   2. a terminal result that is `is_error` / a non-success subtype / an empty
 *      result → `{ isError: true }` with whatever text it carried (or the
 *      accumulated assistant text), so the caller surfaces ❌ and NEVER publishes
 *      the raw NDJSON blob as a reply;
 *   3. no terminal result but some `assistant` text blocks → that text (a partial
 *      but non-error turn still yields what it produced);
 *   4. total parse failure (stdout is not stream-json at all) → the raw stdout
 *      verbatim — never lose the reply just because the wire format shifted.
 */
export function extractStreamJsonReply(raw: string): ParsedReply {
  let assistantText = '';
  let sawErrorResult = false;
  let errorResultText = '';
  for (const o of parseNdjsonEvents(raw)) {
    if (o.type === 'result') {
      const result = typeof o.result === 'string' ? o.result : '';
      if (o.subtype === 'success' && o.is_error !== true && result.length > 0) return { reply: result, isError: false };
      sawErrorResult = true; // error subtype, is_error, or empty success
      errorResultText = result;
      continue;
    }
    if (o.type === 'assistant') assistantText += assistantEventText(o);
  }
  if (sawErrorResult) return { reply: errorResultText || assistantText, isError: true };
  if (assistantText) return { reply: assistantText, isError: false };
  return { reply: raw, isError: false }; // not stream-json at all — last-resort passthrough
}

/**
 * Derive a STABLE session-id UUID from (instance, chat) so every message on a
 * conversation resumes the same Claude session. Deterministic (sha256 of the
 * pair, shaped into a v5-style UUID) — no state to persist, and two hosts
 * serving the same route converge on the same id.
 */
export function deterministicSessionId(instance: string, chat: string): string {
  const h = createHash('sha256').update(`omni-session:${instance}:${chat}`).digest('hex').slice(0, 32).split('');
  h[12] = '5'; // version 5 (name-based)
  h[16] = ((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16); // variant 10xx → 8/9/a/b
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Raw stdout/stderr/exit of ONE `claude` invocation. */
export interface RawClaudeRun {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Fork ONE `claude` process with the given argv. Injectable so the resume/create
 *  orchestration in {@link runClaudeSession} is tested without a real fork. */
export type RawClaudeSpawn = (args: string[], opts: { cwd: string; signal: AbortSignal }) => Promise<RawClaudeRun>;

const CHILD_TERM_GRACE_MS = 1_000;
const AGENT_STDOUT_MAX_BYTES = 1024 * 1024;
const AGENT_STDERR_MAX_BYTES = 64 * 1024;
const SAFE_AGENT_ENV_KEYS = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
]);

/** Minimal environment for mapped route agents. Omni/provider/cloud secrets are
 * never inherited. File-backed credentials still make full isolation
 * impossible, which is why production mapped execution is separately opt-in. */
export function buildMappedAgentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_AGENT_ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && !value.includes('\0')) safe[key] = value;
  }
  return safe;
}

const SENSITIVE_ENV_NAME =
  /(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTHORIZATION|CREDENTIAL|SESSION|COOKIE)/i;

/** Redact known ambient secret values plus common credential shapes before any
 * child-controlled success or failure text crosses the Omni transport. */
export function redactOmniOutbound(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let safe = text;
  const values = Object.entries(env)
    .filter(([name, value]) => SENSITIVE_ENV_NAME.test(name) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  for (const value of values) safe = safe.split(value).join('[REDACTED]');
  return safe
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, '[REDACTED]')
    .replace(/(\b(?:Proxy-Authorization|Authorization)\s*[:=]\s*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bBasic\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Basic [REDACTED]')
    .replace(/(\b(?:Set-Cookie|Cookie)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|npm_)[A-Za-z0-9._-]{8,}/gi, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      /(\b[A-Z0-9_-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|AUTHORIZATION|CREDENTIAL|SESSION|COOKIE)[A-Z0-9_-]*\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /("[^"]*(?:password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization|credential|session|cookie)[^"]*"\s*:\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}]+)/gi,
      '$1"[REDACTED]"',
    )
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@/gi, '$1[REDACTED]@');
}

interface KillableChild {
  pid?: number;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  exited: Promise<number>;
}

/** Own abort semantics instead of relying on Bun's soft SIGTERM-only signal. */
export function superviseChild(
  child: KillableChild,
  signal: AbortSignal,
  graceMs = CHILD_TERM_GRACE_MS,
  processGroup = false,
) {
  let exited = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let forceDone: (() => void) | undefined;
  const forceSettled = new Promise<void>((resolve) => {
    forceDone = resolve;
  });
  const signalTree = (childSignal: 'SIGTERM' | 'SIGKILL') => {
    if (processGroup && process.platform !== 'win32' && Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0) {
      try {
        process.kill(-(child.pid as number), childSignal);
        return;
      } catch {
        // The group leader may have exited while a descendant still drains.
      }
    }
    child.kill(childSignal);
  };
  const terminate = () => {
    if ((exited && !processGroup) || forceTimer) return;
    try {
      signalTree('SIGTERM');
    } catch {
      // The child may have exited between the guard and kill.
    }
    forceTimer = setTimeout(() => {
      if (!exited || processGroup) {
        try {
          signalTree('SIGKILL');
        } catch {
          // Already gone.
        }
      }
      forceDone?.();
    }, graceMs);
    if (!processGroup && typeof forceTimer.unref === 'function') forceTimer.unref();
  };
  const abort = () => terminate();
  if (signal.aborted) terminate();
  else signal.addEventListener('abort', abort, { once: true });
  const exitedPromise = child.exited.then(async (code) => {
    exited = true;
    // Mapped agents may not daemonize helpers. If the direct parent exits while
    // its detached group still has descendants, begin the same bounded reap
    // even without an external abort.
    if (processGroup && !forceTimer) terminate();
    // A direct parent can exit on TERM while a resistant grandchild remains in
    // the detached group. For group supervision, wait through the escalation
    // before reporting settlement; direct-child supervision can finish now.
    let groupStillAlive = false;
    if (forceTimer && processGroup && Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0) {
      try {
        process.kill(-(child.pid as number), 0);
        groupStillAlive = true;
      } catch {
        // No process remains in the group; there is nothing to escalate.
      }
    }
    if (groupStillAlive) await forceSettled;
    else {
      if (forceTimer) clearTimeout(forceTimer);
      forceDone?.();
    }
    signal.removeEventListener('abort', abort);
    return code;
  });
  return { exited: exitedPromise, terminate };
}

/**
 * Does this stderr mean "the session id you tried to resume does not exist"? Claude
 * 2.1.201 says `No conversation found with session ID: <id>` (verified live);
 * older/other phrasings say `No such session` / `session not found`. Each
 * alternative is SESSION-scoped on purpose — a bare `not found` would also match an
 * unrelated failure (e.g. "model not found", an MCP "… not found") on a turn whose
 * session actually exists, wasting a `--session-id` create that then errors
 * "already in use". Only a genuinely missing session triggers the create fallback;
 * any other resume failure is surfaced as-is.
 */
const NO_SESSION_RE = /no conversation found|no such session|session not found/i;

function toSpawnResult(run: RawClaudeRun): SpawnClaudeResult {
  const { reply, isError } = extractStreamJsonReply(run.stdout);
  return { stdout: reply, stderr: run.stderr, exitCode: run.exitCode, isError };
}

/**
 * Run one Model A turn with RESUME-FIRST session continuity.
 *
 * `claude --session-id <id>` CREATES a session and fails "already in use" on the
 * SECOND message — the CRITICAL that broke every turn after the first. So we
 * attempt `--resume <id>` first (continues the existing session in ONE spawn for
 * turn 2..N AND across `omni serve` restarts, since the session persists on disk)
 * and only when that reports a MISSING session ({@link NO_SESSION_RE}) do we fall
 * back to `--session-id <id>` to create it. Net cost: only the very first turn of
 * a conversation pays the extra (fast, no-op) resume spawn. A resume failure for
 * any OTHER reason, or an abort, is returned as-is (no create fallback).
 */
export async function runClaudeSession(opts: SpawnClaudeOpts, rawSpawn: RawClaudeSpawn): Promise<SpawnClaudeResult> {
  const base = { message: opts.message, sessionId: opts.sessionId ?? randomUUID(), personaFile: opts.personaFile };
  const spawnOpts = { cwd: opts.cwd, signal: opts.signal };
  const resumed = await rawSpawn(buildClaudeArgs({ ...base, mode: 'resume' }), spawnOpts);
  if (resumed.exitCode === 0 || opts.signal.aborted || !NO_SESSION_RE.test(resumed.stderr)) {
    return toSpawnResult(resumed);
  }
  // Session does not exist yet → create it (this spawn processes the message).
  const created = await rawSpawn(buildClaudeArgs({ ...base, mode: 'create' }), spawnOpts);
  return toSpawnResult(created);
}

/** Default raw fork of one `claude` process. stdin is closed (`ignore`) so claude
 *  never waits ~3s for piped input in headless one-shot mode. */
const defaultRawSpawn: RawClaudeSpawn = async (args, { cwd, signal }) => {
  const command = resolveTrustedHostExecutable('claude', cwd);
  const proc = Bun.spawn([command, ...args], {
    cwd,
    env: buildMappedAgentEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: process.platform !== 'win32',
  });
  const supervised = superviseChild(proc, signal, CHILD_TERM_GRACE_MS, process.platform !== 'win32');
  const [stdout, stderr, exitCode] = await Promise.all([
    readBoundedText(proc.stdout, AGENT_STDOUT_MAX_BYTES, supervised.terminate, signal),
    readBoundedText(proc.stderr, AGENT_STDERR_MAX_BYTES, undefined, signal),
    supervised.exited,
  ]);
  return { stdout: stdout.text, stderr: stderr.text, exitCode };
};

/**
 * Default executor — a real Model A `claude -p` run bounded by the caller's abort
 * signal, resume-first (see {@link runClaudeSession}), streaming stream-json and
 * parsing out the final reply. Never imported at module top-level cost; only
 * invoked once an inbound message actually matches a configured route.
 */
export const defaultSpawnClaude: SpawnClaude = (opts) => runClaudeSession(opts, defaultRawSpawn);

// ============================================================================
// Provider-neutral execution + Codex JSONL
// ============================================================================

export type AgentProvider = 'claude' | 'codex';

export interface AgentExecutionOpts extends SpawnClaudeOpts {
  provider: AgentProvider;
  /** Persisted Codex thread id. Claude continues to use sessionId. */
  threadId?: string;
}

export interface AgentExecutionResult extends SpawnClaudeResult {
  threadId?: string;
  /** Validated message from a top-level Codex `error` / `turn.failed` event. */
  codexErrorDetail?: string;
  /** Stable machine-readable code from a top-level Codex failure event. */
  codexErrorCode?: string;
  /**
   * A successful fresh turn created this thread after the persisted thread was
   * confirmed missing. The runner conditionally replaces only this exact stale
   * value, so another process cannot have a newer route overwritten.
   */
  replacesThreadId?: string;
  /**
   * A persisted thread was confirmed missing and the single fresh retry failed.
   * The runner conditionally clears only this exact value so the next inbound
   * can retry fresh instead of repeatedly resuming a known-dead thread.
   */
  clearThreadId?: string;
}

export type AgentExecutor = (opts: AgentExecutionOpts) => Promise<AgentExecutionResult>;

export function resolveTrustedHostExecutable(
  name: string,
  childCwd: string,
  which: (command: string) => string | null = (command) => Bun.which(command),
): string {
  return resolveTrustedExecutable(name, childCwd, which);
}

export function isSafeCodexThreadId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

export function buildCodexArgs(opts: { message: string; threadId?: string }): string[] {
  if (opts.threadId) {
    if (!isSafeCodexThreadId(opts.threadId)) throw new Error('Refusing unsafe persisted Codex thread id');
    return ['exec', 'resume', '--json', '-c', 'sandbox_mode="workspace-write"', '--', opts.threadId, opts.message];
  }
  return ['exec', '--json', '--sandbox', 'workspace-write', '--', opts.message];
}

const CODEX_STDOUT_MAX_BYTES = 1024 * 1024;
const CODEX_STDERR_MAX_BYTES = 64 * 1024;
const CODEX_JSONL_MAX_CHARS = CODEX_STDOUT_MAX_BYTES;
const CODEX_JSONL_MAX_LINE_CHARS = 256 * 1024;
const CODEX_JSONL_MAX_EVENTS = 10_000;
const CODEX_ERROR_DETAIL_MAX_CHARS = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const boundedCodexDetail = (value: string): string =>
  value.length <= CODEX_ERROR_DETAIL_MAX_CHARS ? value : `${value.slice(0, CODEX_ERROR_DETAIL_MAX_CHARS - 1)}…`;

const codexJsonlError = (detail: string, threadId?: string): AgentExecutionResult => ({
  stdout: `Codex JSONL was incomplete or unsupported (${boundedCodexDetail(detail)}); retry the message.`,
  exitCode: 0,
  isError: true,
  threadId,
});

function codexEventError(event: Record<string, unknown>): string | undefined {
  const direct = nonEmptyString(event.message);
  if (direct) return direct;
  if (isRecord(event.error)) return nonEmptyString(event.error.message);
  return undefined;
}

function codexEventErrorCode(event: Record<string, unknown>): string | undefined {
  const direct = nonEmptyString(event.code);
  if (direct) return direct;
  if (isRecord(event.error)) return nonEmptyString(event.error.code);
  return undefined;
}

interface CodexJsonlState {
  threadId?: string;
  reply: string;
  sawTurnCompleted: boolean;
  failure?: string;
  failureCode?: string;
}

function consumeCodexEvent(value: unknown, lineNumber: number, state: CodexJsonlState): string | undefined {
  if (!isRecord(value)) return `line ${lineNumber} is not an event object`;
  const type = nonEmptyString(value.type);
  if (!type) return `line ${lineNumber} has no event type`;

  switch (type) {
    case 'thread.started': {
      const startedThread = nonEmptyString(value.thread_id);
      if (!startedThread) return 'thread.started has no thread_id';
      if (!isSafeCodexThreadId(startedThread)) return 'thread.started emitted an unsafe thread_id';
      if (state.threadId && state.threadId !== startedThread) return 'multiple different thread ids were emitted';
      state.threadId = startedThread;
      return undefined;
    }
    case 'turn.started':
      return undefined;
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      if (!isRecord(value.item)) return `${type} has no item object`;
      const itemType = nonEmptyString(value.item.type);
      if (!itemType) return `${type} item has no type`;
      const text = nonEmptyString(value.item.text);
      if (type === 'item.completed' && itemType === 'agent_message' && text) state.reply = text;
      return undefined;
    }
    case 'turn.completed':
      if (state.sawTurnCompleted) return 'multiple turn.completed events were emitted';
      if (!state.reply.trim()) return 'turn.completed was emitted before a non-empty agent reply';
      state.sawTurnCompleted = true;
      return undefined;
    case 'turn.failed':
    case 'error':
      state.failure = boundedCodexDetail(codexEventError(value) ?? `${type} did not include an error message`);
      state.failureCode = codexEventErrorCode(value);
      return undefined;
    default:
      return `unknown event type ${JSON.stringify(type)}`;
  }
}

export function extractCodexJsonlReply(raw: string): AgentExecutionResult {
  if (raw.length === 0 || raw.trim().length === 0) return codexJsonlError('empty output');
  if (raw.length > CODEX_JSONL_MAX_CHARS) {
    return codexJsonlError(`output exceeded ${CODEX_JSONL_MAX_CHARS} characters`);
  }

  const state: CodexJsonlState = { reply: '', sawTurnCompleted: false };
  let eventCount = 0;
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (state.sawTurnCompleted) {
      return codexJsonlError(`line ${index + 1} contains content after turn.completed`, state.threadId);
    }
    eventCount++;
    if (eventCount > CODEX_JSONL_MAX_EVENTS) {
      return codexJsonlError(`event count exceeded ${CODEX_JSONL_MAX_EVENTS}`, state.threadId);
    }
    if (line.length > CODEX_JSONL_MAX_LINE_CHARS) {
      return codexJsonlError(`line ${index + 1} exceeded ${CODEX_JSONL_MAX_LINE_CHARS} characters`, state.threadId);
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return codexJsonlError(`line ${index + 1} is not complete JSON`, state.threadId);
    }
    const schemaError = consumeCodexEvent(value, index + 1, state);
    if (schemaError) return codexJsonlError(schemaError, state.threadId);
    if (state.failure) {
      return {
        stdout: `Codex turn failed (${state.failure}); retry the message.`,
        exitCode: 0,
        isError: true,
        threadId: state.threadId,
        codexErrorDetail: state.failure,
        codexErrorCode: state.failureCode,
      };
    }
  }

  if (!state.sawTurnCompleted) return codexJsonlError('turn.completed was not emitted', state.threadId);
  if (!state.reply.trim()) return codexJsonlError('no non-empty agent reply was emitted', state.threadId);
  return { stdout: state.reply, exitCode: 0, isError: false, threadId: state.threadId };
}

export interface RawCodexRun extends RawClaudeRun {
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export type RawCodexSpawn = (args: string[], opts: { cwd: string; signal: AbortSignal }) => Promise<RawCodexRun>;

const MISSING_CODEX_THREAD_CODES = new Set([
  'thread_not_found',
  'session_not_found',
  'conversation_not_found',
  'rollout_not_found',
]);

function parseCodexRun(run: RawCodexRun): AgentExecutionResult {
  const stderrWasTruncated = run.stderrTruncated || run.stderr.length > CODEX_STDERR_MAX_BYTES;
  const stderr = stderrWasTruncated ? `…${run.stderr.slice(-(CODEX_STDERR_MAX_BYTES - 1))}` : run.stderr;
  if (run.stdoutTruncated) {
    return {
      stdout: `Codex JSONL exceeded ${CODEX_STDOUT_MAX_BYTES} bytes and was truncated; retry with a smaller task.`,
      stderr,
      exitCode: run.exitCode,
      isError: true,
    };
  }
  const parsed = extractCodexJsonlReply(run.stdout);
  return { ...parsed, stderr, exitCode: run.exitCode, isError: parsed.isError || run.exitCode !== 0 };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Retry only stable machine codes or exact, whole-line CLI diagnostics. Broad
 * proximity matching can replay a mutating prompt after an unrelated error. */
const codexThreadIsMissing = (parsed: AgentExecutionResult, staleThreadId: string): boolean => {
  if (parsed.codexErrorCode && MISSING_CODEX_THREAD_CODES.has(parsed.codexErrorCode.toLowerCase())) return true;
  const stale = escapeRegExp(staleThreadId);
  const exact = [
    new RegExp(`^Thread not found(?::\\s*${stale})?$`, 'i'),
    new RegExp(`^Conversation not found(?::\\s*${stale})?$`, 'i'),
    new RegExp(`^No conversation found with (?:session|thread) ID:\\s*${stale}$`, 'i'),
    new RegExp(`^No such (?:thread|session|conversation)(?::\\s*${stale})?$`, 'i'),
    /^Session expired$/i,
    /^No saved (?:thread|session|conversation)$/i,
  ];
  const lines = `${parsed.stderr ?? ''}\n${parsed.codexErrorDetail ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.some((line) => exact.some((pattern) => pattern.test(line)));
};

function freshCodexFailure(result: AgentExecutionResult, staleThreadId: string): AgentExecutionResult {
  const detail = boundedCodexDetail(result.stderr?.trim() || result.stdout.trim() || `exit code ${result.exitCode}`);
  const message = `Saved Codex thread is missing and the one-time fresh retry failed (${detail}); send the message again to retry.`;
  return {
    ...result,
    stdout: message,
    stderr: result.exitCode === 0 ? result.stderr : message,
    isError: true,
    threadId: undefined,
    clearThreadId: staleThreadId,
  };
}

export async function runCodexSession(
  opts: AgentExecutionOpts,
  rawSpawn: RawCodexSpawn,
): Promise<AgentExecutionResult> {
  const persona = opts.personaFile && existsSync(opts.personaFile) ? readFileSync(opts.personaFile, 'utf8') : '';
  const message = persona ? `<persona>\n${persona}\n</persona>\n\n${opts.message}` : opts.message;
  const spawnOpts = {
    cwd: opts.cwd,
    signal: opts.signal,
  };
  const run = await rawSpawn(buildCodexArgs({ message, threadId: opts.threadId }), spawnOpts);
  const parsed = parseCodexRun(run);

  if (!opts.threadId) {
    if (parsed.exitCode === 0 && !parsed.isError && !parsed.threadId) {
      return {
        ...parsed,
        stdout: 'Codex completed a fresh turn without returning a thread id; send the message again to retry.',
        isError: true,
      };
    }
    return parsed;
  }

  const resumeFailed = parsed.exitCode !== 0 || parsed.isError;
  if (!resumeFailed) {
    if (parsed.threadId && parsed.threadId !== opts.threadId) {
      return {
        ...parsed,
        stdout:
          'Codex resume returned a different thread id; stored session state was left unchanged. Retry the message.',
        isError: true,
        threadId: undefined,
      };
    }
    return { ...parsed, threadId: opts.threadId };
  }
  if (opts.signal.aborted || run.stdoutTruncated || !codexThreadIsMissing(parsed, opts.threadId)) return parsed;

  // A confirmed missing resume gets exactly one fresh attempt. The caller
  // conditionally swaps the persisted id only after this attempt has a complete,
  // non-empty reply and a new thread id.
  const freshRun = await rawSpawn(buildCodexArgs({ message }), spawnOpts);
  const fresh = parseCodexRun(freshRun);
  if (fresh.exitCode !== 0 || fresh.isError) return freshCodexFailure(fresh, opts.threadId);
  if (!fresh.threadId) {
    return freshCodexFailure(
      {
        ...fresh,
        stdout: 'Codex completed the fresh retry without returning a thread id.',
        isError: true,
      },
      opts.threadId,
    );
  }
  return { ...fresh, replacesThreadId: opts.threadId };
}

interface BoundedText {
  text: string;
  truncated: boolean;
}

export async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow?: () => void,
  signal?: AbortSignal,
): Promise<BoundedText> {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder();
  let text = '';
  let retained = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - retained;
      if (remaining > 0) {
        const kept = value.subarray(0, remaining);
        retained += kept.byteLength;
        text += decoder.decode(kept, { stream: true });
      }
      if (value.byteLength > Math.max(remaining, 0)) {
        truncated = true;
        onOverflow?.();
        await reader.cancel();
        break;
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  text += decoder.decode();
  return { text, truncated };
}

const defaultRawCodexSpawn: RawCodexSpawn = async (args, { cwd, signal }) => {
  const command = resolveTrustedHostExecutable('codex', cwd);
  const proc = Bun.spawn([command, ...args], {
    cwd,
    env: buildMappedAgentEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: process.platform !== 'win32',
  });
  const supervised = superviseChild(proc, signal, CHILD_TERM_GRACE_MS, process.platform !== 'win32');
  const [stdout, stderr, exitCode] = await Promise.all([
    readBoundedText(proc.stdout, CODEX_STDOUT_MAX_BYTES, supervised.terminate, signal),
    readBoundedText(proc.stderr, CODEX_STDERR_MAX_BYTES, undefined, signal),
    supervised.exited,
  ]);
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
};

export const defaultAgentExecutor: AgentExecutor = (opts) =>
  opts.provider === 'codex' ? runCodexSession(opts, defaultRawCodexSpawn) : defaultSpawnClaude(opts);

// ============================================================================
// Injectable id-returning Omni send (approval announce)
// ============================================================================

/**
 * Result of an id-returning Omni send. `messageId` is the correlatable id — the
 * WhatsApp stanza id / externalId (SPIKE finding (b)) — that an inbound reaction
 * later references. Absent on a failed send (the row stays un-tagged and is
 * retried on the next tick).
 */
export interface OmniSendResult {
  messageId?: string;
  success?: boolean;
  error?: string;
}

export interface OmniSendOpts {
  instance: string;
  chat: string;
  text: string;
  signal?: AbortSignal;
}

/**
 * Send an approval-request message and RETURN the id it was assigned. Injectable
 * so tests drive a fake (zero network); the default posts to the Omni HTTP send
 * API. This replaces the fire-and-forget NATS `omni.reply.*` publish whose id
 * Omni's `onReply` discarded — capturing the real Omni message id is what makes
 * a reaction correlatable to the exact approval it targets.
 */
export type OmniSend = (opts: OmniSendOpts) => Promise<OmniSendResult>;

/**
 * Default id-returning send — POSTs the approval message to Omni's HTTP send
 * route, signed exactly like {@link registerAgentInOmni} (bearer + optional
 * ed25519). Returns the message id from the response so `announce()` can store
 * the correlatable stanza id. Degrades to an error result (silent retry, never a
 * throw) when the Omni API URL is unconfigured.
 *
 * NOTE: the exact send route + response field that surface the WhatsApp *stanza
 * id* (vs the persisted Omni UUID) are documented in SPIKE (b) but not yet
 * exercised against the live hub — the injectable seam above is what the test
 * suite proves; G3's `--live` round-trip confirms this default's wire format.
 */
export function makeDefaultOmniSend(config: OmniRuntimeConfig): OmniSend {
  return async ({ instance, chat, text, signal }) => {
    const apiUrl = config.apiUrl;
    if (!apiUrl) return { success: false, error: 'omni apiUrl not configured' };
    const path = '/api/v2/messages';
    const bodyJson = JSON.stringify({ instanceId: instance, chatId: chat, text });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const sig = signOmniRequest('POST', path, bodyJson);
    if (sig) Object.assign(headers, sig);
    const res = await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: bodyJson,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    // SendResult ({ success, messageId, ... }) may be top-level or `{ data }`-wrapped.
    const json = (await res.json()) as { messageId?: string; data?: { messageId?: string } };
    const messageId = json.messageId ?? json.data?.messageId;
    return { success: Boolean(messageId), messageId };
  };
}

// ============================================================================
// Injectable outbound set-reaction (⏳→✅/❌ status ack)
// ============================================================================

export interface OmniSetReactionResult {
  success?: boolean;
  error?: string;
}

export interface OmniSetReactionOpts {
  instance: string;
  chat: string;
  /** The WhatsApp stanza id of the message to react to (genie's own approval). */
  messageId: string;
  /** The status emoji to set (⏳/✅/❌). A new emoji SWAPS the prior one in place. */
  emoji: string;
  signal?: AbortSignal;
}

/**
 * Set (or swap) genie's OWN status reaction on a message it sent. Injectable so
 * tests drive a fake (zero network); the default POSTs the Omni `--reaction`
 * HTTP path. WhatsApp allows one reaction per sender per message, so setting a
 * new emoji on the same stanza id replaces the prior one — that is how the
 * ⏳→✅/❌ ack swaps in place.
 *
 * This is the seam the SPIKE-documented fallback swaps behind: if a later
 * `--live` QA shows the in-place reaction swap does not RENDER, replace this
 * default impl with a message-edit (prepend a status glyph) or a status-reply
 * variant — the runner calls this one seam, so the fallback is an impl swap, not
 * a rewrite.
 */
export type OmniSetReaction = (opts: OmniSetReactionOpts) => Promise<OmniSetReactionResult>;

/**
 * Default set-reaction — POSTs to Omni's HTTP reaction route, signed exactly
 * like {@link makeDefaultOmniSend}. Uses the `--reaction` path (correct
 * `fromMe` for genie's own message), NOT the bare `react` verb. Degrades to an
 * error result (never a throw) when the Omni API URL is unconfigured.
 *
 * NOTE: like {@link makeDefaultOmniSend}, the exact reaction-route body shape is
 * documented in SPIKE (c) but not yet exercised against the live hub — the
 * injectable seam above is what the test suite proves; G3's `--live` round-trip
 * confirms this default's wire format (and whether the in-place swap renders).
 */
export function makeDefaultOmniSetReaction(config: OmniRuntimeConfig): OmniSetReaction {
  return async ({ instance, chat, messageId, emoji, signal }) => {
    const apiUrl = config.apiUrl;
    if (!apiUrl) return { success: false, error: 'omni apiUrl not configured' };
    const path = '/api/v2/messages/send/reaction';
    const bodyJson = JSON.stringify({ instanceId: instance, to: chat, messageId, emoji });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const sig = signOmniRequest('POST', path, bodyJson);
    if (sig) Object.assign(headers, sig);
    const res = await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers,
      body: bodyJson,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
    return { success: true };
  };
}

/** Default factory — dynamically imports `nats`. Only invoked by `omni serve`. */
export const defaultNatsFactory: NatsFactory = async ({ servers }) => {
  const nats = await import('nats');
  const nc = await nats.connect({ servers });
  natsConnections++;
  const enc = new TextEncoder();
  return {
    subscribe(subject: string): NatsSubscription {
      const sub = nc.subscribe(subject);
      return {
        unsubscribe: () => sub.unsubscribe(),
        async *[Symbol.asyncIterator]() {
          for await (const m of sub) yield { subject: m.subject, data: m.data };
        },
      };
    },
    publish: (subject, payload) => nc.publish(subject, enc.encode(payload)),
    flush: () => nc.flush(),
    close: () => nc.close(),
  };
};

// ============================================================================
// Inbound payload shapes (loose — omni fields vary by channel)
// ============================================================================

interface InboundMessagePayload {
  content?: string;
  sender?: string;
  instanceId?: string;
  chatId?: string;
  /**
   * For a reaction `message.received`, the reacted-to message's stanza id (also
   * embedded in `content` as `[Reaction: <emoji> on message <messageId>]`). Used
   * to correlate the reaction to the exact approval it targets (SPIKE a).
   */
  messageId?: string;
}

const MAX_INBOUND_FRAME_BYTES = 128 * 1024;
const MAX_INBOUND_CONTENT_BYTES = 64 * 1024;
const MAX_INBOUND_ID_CHARS = 512;
const hasUnsafeTransportControl = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f;
  });

function inboundFieldError(parsed: Record<string, unknown>): string | undefined {
  for (const field of ['content', 'sender', 'instanceId', 'chatId', 'messageId'] as const) {
    const value = parsed[field];
    if (value !== undefined && typeof value !== 'string') return `${field} must be a string`;
    if (typeof value === 'string' && hasUnsafeTransportControl(value)) {
      return `${field} contains unsafe control characters`;
    }
    if (field !== 'content' && typeof value === 'string' && value.length > MAX_INBOUND_ID_CHARS) {
      return `${field} is too long`;
    }
  }
  const content = parsed.content;
  return typeof content === 'string' && Buffer.byteLength(content, 'utf8') > MAX_INBOUND_CONTENT_BYTES
    ? 'content exceeded the safety limit'
    : undefined;
}

// ============================================================================
// Runner
// ============================================================================

export interface OmniRunnerDeps {
  db: Database;
  config: OmniRuntimeConfig;
  /** Outbound NATS publish. */
  publish: (subject: string, payload: string) => void;
  /** Awaited after publish and before SQLite session/handled commit. */
  flush?: () => Promise<void>;
  /** Resident lease identity. Production always supplies the machine-wide
   * fencing epoch; direct unit runners get a private epoch-zero identity. */
  claimOwner?: { ownerId: string; epoch: number };
  /** Structured log sink (stdout in serve; captured in tests). */
  log?: (line: string) => void;
  /** Injectable clock. */
  now?: () => number;
  /** Injectable correlation-id generator (tagged onto routed one-shot replies). */
  genCorrelationId?: () => string;
  /**
   * Injectable one-shot executor. Defaults to a real `claude -p`; tests pass a
   * fake so no real claude is ever forked.
   */
  spawnClaude?: SpawnClaude;
  /** Provider-neutral executor. When absent, legacy spawnClaude remains valid for Claude routes. */
  spawnAgent?: AgentExecutor;
  /**
   * Injectable id-returning approval send. Defaults to the Omni HTTP send
   * ({@link makeDefaultOmniSend}); tests pass a fake that returns a known stanza
   * id so `announce()` is exercised with zero network.
   */
  sendApproval?: OmniSend;
  /**
   * Injectable outbound set-reaction for the ⏳→✅/❌ status ack. Defaults to the
   * Omni HTTP reaction path ({@link makeDefaultOmniSetReaction}); tests pass a
   * fake that records the (target id, emoji) so the status lifecycle is asserted
   * with zero network. The seam the SPIKE fallback (message-edit / status-reply)
   * swaps behind if the in-place reaction swap does not render live.
   */
  setReaction?: OmniSetReaction;
  /** Explicitly enable mapped workspace-writing agent runs. Production defaults
   * off because child authentication may remain file-backed outside env control. */
  allowMappedAgentExecution?: boolean;
  /** Maximum time shutdown/idle drains may wait on injected network/child work. */
  drainTimeoutMs?: number;
}

export interface OmniRunner {
  /** Send any un-announced pending approvals + expire stale rows. */
  tick(): void;
  /**
   * Handle one inbound `omni.message.*` frame — a text reply OR a reaction (both
   * arrive on this subject in this Omni build).
   */
  handleMessage(subject: string, data: string): void;
  /**
   * Resolve once every in-flight one-shot run has settled. Test seam — the serve
   * loop never awaits it (runs are fire-and-forget), but tests use it to observe
   * the mapped round-trip deterministically.
   */
  whenIdle(): Promise<void>;
  /** Stop intake, abort active route children, and drain all owned work. */
  stop(): Promise<void>;
}

const OMITTED_APPROVAL_PREVIEW = JSON.stringify({ version: 1, legacyPreviewOmitted: true });
const SAFE_APPROVAL_TOOL = /^[A-Za-z0-9_.:-]{1,128}$/;
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });

function safeSummaryPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240 || hasControlCharacter(value)) {
    return undefined;
  }
  return redactOmniOutbound(value);
}

function boundedApprovalPreview(value: Record<string, unknown>): string {
  const preview = JSON.stringify(value);
  return preview.length > 200 ? JSON.stringify({ version: 1, kind: value.kind, previewTruncated: true }) : preview;
}

/** Every durable row is compatibility input, not trusted producer output. Only
 * the current version and allowlisted fields are reconstructed for transport. */
function safeApprovalPreview(tool: string, inputSummary: string): string {
  try {
    const parsed: unknown = JSON.parse(inputSummary);
    if (!isRecord(parsed) || parsed.version !== 1) return OMITTED_APPROVAL_PREVIEW;
    if (parsed.kind === 'empty') return JSON.stringify({ version: 1, kind: 'empty' });
    if (tool === 'Bash' && parsed.kind === 'Bash' && Array.isArray(parsed.commands)) {
      const commands = parsed.commands.slice(0, 8).flatMap((value) => {
        if (!isRecord(value) || typeof value.executable !== 'string') return [];
        const executable =
          /^[A-Za-z][A-Za-z0-9._+-]{0,63}$/.test(value.executable) &&
          !/(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)/i.test(value.executable) &&
          !/^(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|npm_|AKIA|ASIA|AIza)/i.test(value.executable)
            ? value.executable
            : '[command]';
        const options = Array.isArray(value.options)
          ? value.options
              .filter(
                (option): option is string =>
                  typeof option === 'string' && /^--?[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(option),
              )
              .slice(0, 12)
          : [];
        const env = Array.isArray(value.env)
          ? value.env
              .filter((name): name is string => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))
              .slice(0, 12)
          : [];
        const argumentCount =
          typeof value.argumentCount === 'number' &&
          Number.isSafeInteger(value.argumentCount) &&
          value.argumentCount >= 0
            ? Math.min(value.argumentCount, 10_000)
            : 0;
        return [{ executable, options, env, argumentCount }];
      });
      return boundedApprovalPreview({ version: 1, kind: 'Bash', commands, truncated: parsed.truncated === true });
    }
    if ((tool === 'Write' || tool === 'Edit' || tool === 'apply_patch') && parsed.kind === tool) {
      const paths = Array.isArray(parsed.paths)
        ? parsed.paths
            .flatMap((value) => {
              const safe = safeSummaryPath(value);
              return safe ? [safe] : [];
            })
            .slice(0, 10)
        : [];
      return boundedApprovalPreview({ version: 1, kind: tool, paths });
    }
    if (tool === 'NotebookEdit' && parsed.kind === 'NotebookEdit') {
      const paths = Array.isArray(parsed.paths)
        ? parsed.paths
            .flatMap((value) => {
              const safe = safeSummaryPath(value);
              return safe ? [safe] : [];
            })
            .slice(0, 10)
        : [];
      const cellId = safeSummaryPath(parsed.cellId);
      return boundedApprovalPreview({ version: 1, kind: 'NotebookEdit', paths, ...(cellId ? { cellId } : {}) });
    }
    if (parsed.kind === 'other' && typeof parsed.inputFieldCount === 'number') {
      const inputFieldCount = Number.isSafeInteger(parsed.inputFieldCount)
        ? Math.max(0, Math.min(parsed.inputFieldCount, 10_000))
        : 0;
      return JSON.stringify({ version: 1, kind: 'other', inputFieldCount });
    }
    if (parsed.previewTruncated === true && typeof parsed.kind === 'string') {
      return JSON.stringify({ version: 1, kind: parsed.kind.slice(0, 40), previewTruncated: true });
    }
    return OMITTED_APPROVAL_PREVIEW;
  } catch {
    return OMITTED_APPROVAL_PREVIEW;
  }
}

function formatApprovalMessage(tool: string, inputSummary: string): string {
  const safeTool = SAFE_APPROVAL_TOOL.test(tool) ? tool : 'unknown';
  const preview = safeApprovalPreview(safeTool, inputSummary);
  return [
    '\u{1F514} *Approval Required*',
    '',
    `Tool: \`${safeTool}\``,
    `Preview: ${preview}`,
    '',
    'Reply *y* to approve or *n* to deny',
    'Or react \u{1F44D} / \u{1F44E}',
  ].join('\n');
}

/**
 * Parse a reaction `message.received` content — `[Reaction: <emoji> on message
 * <id>]`, optionally prefixed by `[<displayName>]: ` — into its emoji + target
 * stanza id. Returns null for ordinary text so the caller falls through to the
 * text-token path. This is the sole reaction shape genie treats as a decision;
 * the dual-emit bare-emoji echo (SPIKE a) is deliberately NOT matched here, so
 * it can never double-resolve.
 */
const REACTION_RE = /\[Reaction:\s*(.+?)\s+on message\s+(.+?)\]/;
function parseReaction(content: string): { emoji: string; targetId: string } | null {
  const m = REACTION_RE.exec(content);
  return m ? { emoji: m[1].trim(), targetId: m[2].trim() } : null;
}

/** Authoritative identity carried by `omni.message.{instance}.{chat...}`. */
function identityFromSubject(subject: string): { instance: string; chat: string } | undefined {
  const parts = subject.split('.');
  if (parts.length < 4 || parts[0] !== 'omni' || parts[1] !== 'message' || !parts[2]) return undefined;
  const chat = parts.slice(3).join('.');
  return chat ? { instance: parts[2], chat } : undefined;
}

type ParsedInboundFrame = {
  ok: true;
  msg: InboundMessagePayload;
  instance: string;
  chat: string;
  sender: string;
  body: string;
};
type RejectedInboundFrame = { ok: false; reason?: string };

/** Parse and scope-check the NATS envelope before any durable side effect. */
function parseInboundFrame(
  subject: string,
  data: string,
  configuredInstance: string | undefined,
): ParsedInboundFrame | RejectedInboundFrame {
  const identity = identityFromSubject(subject);
  if (!identity || (configuredInstance && identity.instance !== configuredInstance)) {
    return { ok: false, reason: `out-of-scope subject ${subject}` };
  }
  if (
    identity.instance.length > MAX_INBOUND_ID_CHARS ||
    identity.chat.length > MAX_INBOUND_ID_CHARS ||
    hasUnsafeTransportControl(identity.instance) ||
    hasUnsafeTransportControl(identity.chat)
  ) {
    return { ok: false, reason: 'invalid subject identity' };
  }
  if (Buffer.byteLength(data, 'utf8') > MAX_INBOUND_FRAME_BYTES) {
    return { ok: false, reason: 'frame exceeded the safety limit' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'frame must be a JSON object' };
  const fieldError = inboundFieldError(parsed);
  if (fieldError) return { ok: false, reason: fieldError };
  const msg = parsed as InboundMessagePayload;
  if (
    (msg.instanceId !== undefined && msg.instanceId !== identity.instance) ||
    (msg.chatId !== undefined && msg.chatId !== identity.chat)
  ) {
    return { ok: false, reason: `identity mismatch on ${subject}` };
  }
  return {
    ok: true,
    msg,
    instance: identity.instance,
    chat: identity.chat,
    sender: msg.sender?.trim() || 'whatsapp-user',
    body: msg.content ?? '',
  };
}

function inboundEventKey(subject: string, data: string): string {
  return createHash('sha256').update('omni-inbound\0').update(subject).update('\0').update(data).digest('hex');
}

/**
 * Outbound reply payload for a routed one-shot, addressed at the exact
 * (instance, chat) the inbound arrived on (NOT the approval chat). Mirrors the
 * origin/v4 omni-bridge reply shape so the omni side deserializes it uniformly.
 */
function buildRoutedReplyPayload(
  instance: string,
  chat: string,
  content: string,
  correlationId: string,
  nowMs: number,
): string {
  return JSON.stringify({
    content,
    agent: 'genie',
    chat_id: chat,
    instance_id: instance,
    request_id: correlationId,
    timestamp: new Date(nowMs).toISOString(),
  });
}

/** Cap a reply to `max` chars, replacing the tail with a single ellipsis. */
function truncateReply(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Keep the LAST `max` chars of a diagnostic, replacing the head with a single
 *  ellipsis — the inverse of {@link truncateReply}, because a crashing child's
 *  cause is at the END of its stderr, not the start. */
function tailOf(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return `…${text.slice(-(max - 1))}`;
}

/** Dropped-because-busy notice (Decision 10 — one in-flight run per route). */
const BUSY_NOTICE = '\u{1F6D1} busy — one at a time. Your message was stored; try again shortly.';
const INTERRUPTED_NOTICE =
  '⚠️ the previous resident stopped during this run. Genie did not replay the workspace action; please review state and retry explicitly.';
/** Fired when a one-shot exceeds its budget and is killed. */
const timeoutNotice = (ms: number): string => `\u{23F1}\u{FE0F} timed out after ${ms}ms — the run was cancelled.`;
/** Max chars of failure detail carried into an error notice — wide enough for
 *  the {@link exitDetail} exit-code prefix plus its full stderr tail. */
const ERROR_DETAIL_MAX = 600;
/** Fired on a non-zero exit or a child crash; the underlying error is bounded. */
const errorNotice = (detail: string): string =>
  `\u{26A0}\u{FE0F} agent run failed: ${truncateReply(detail, ERROR_DETAIL_MAX)}`;

/** Max chars of child stderr/stdout tail surfaced in the exit-code detail. */
const EXIT_DIAG_TAIL_CHARS = 500;
/** Failure detail for a non-zero exit: the code plus the TAIL of the child's
 *  stderr (a crash explains itself at the end of the stream), falling back to
 *  stdout when stderr is empty. Bare `exit code N` only when both are blank. */
const exitDetail = (code: number, stderr: string | undefined, stdout: string): string => {
  // Child streams are already byte-bounded. Redact that complete bounded
  // diagnostic before tail selection so truncation cannot discard an auth
  // label while retaining its opaque credential.
  const diag = tailOf(redactOmniOutbound((stderr ?? '').trim() || stdout.trim()), EXIT_DIAG_TAIL_CHARS);
  return diag ? `exit code ${code} — ${diag}` : `exit code ${code}`;
};

/** Compact message for an unknown thrown value. */
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function oneShotResultContent(result: AgentExecutionResult, ok: boolean, maxReplyChars: number): string {
  if (ok) return truncateReply(redactOmniOutbound(result.stdout), maxReplyChars);
  const detail = result.exitCode !== 0 ? exitDetail(result.exitCode, result.stderr, result.stdout) : result.stdout;
  return errorNotice(redactOmniOutbound(detail || 'agent returned an error'));
}

function oneShotFailureContent(error: unknown, timeoutMs: number): string {
  if (error instanceof OneShotTimeoutError) return timeoutNotice(timeoutMs);
  if (error instanceof OneShotStoppedError) return '⏹️ cancelled because Omni serve stopped.';
  return errorNotice(redactOmniOutbound(errText(error)));
}

function currentCodexThread(db: Database, route: OmniRoute): string | undefined {
  return (route.agent ?? 'claude') === 'codex' ? getAgentSession(db, 'codex', route.instance, route.chat) : undefined;
}

interface DurableDeliveryMeta {
  version: 1;
  ok: boolean;
  threadId?: string;
  replacesThreadId?: string;
  clearThreadId?: string;
}

function encodeDeliveryMeta(result: AgentExecutionResult, ok: boolean): string {
  return JSON.stringify({
    version: 1,
    ok,
    ...(result.threadId ? { threadId: result.threadId } : {}),
    ...(result.replacesThreadId ? { replacesThreadId: result.replacesThreadId } : {}),
    ...(result.clearThreadId ? { clearThreadId: result.clearThreadId } : {}),
  } satisfies DurableDeliveryMeta);
}

function decodeDeliveryMeta(raw: string): { result: AgentExecutionResult; ok: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Durable Omni delivery metadata is not valid JSON');
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.ok !== 'boolean') {
    throw new Error('Durable Omni delivery metadata has an unsupported shape');
  }
  for (const field of ['threadId', 'replacesThreadId', 'clearThreadId'] as const) {
    const value = parsed[field];
    if (value !== undefined && (typeof value !== 'string' || !isSafeCodexThreadId(value))) {
      throw new Error(`Durable Omni delivery metadata has an unsafe ${field}`);
    }
  }
  return {
    ok: parsed.ok,
    result: {
      stdout: '',
      exitCode: parsed.ok ? 0 : 1,
      ...(typeof parsed.threadId === 'string' ? { threadId: parsed.threadId } : {}),
      ...(typeof parsed.replacesThreadId === 'string' ? { replacesThreadId: parsed.replacesThreadId } : {}),
      ...(typeof parsed.clearThreadId === 'string' ? { clearThreadId: parsed.clearThreadId } : {}),
    },
  };
}

function commitPublishedInbound(
  db: Database,
  route: OmniRoute,
  result: AgentExecutionResult,
  ok: boolean,
  inboundId: string,
  claimToken: string,
  nowMs: number,
  log: (line: string) => void,
  identity: DurableClaimIdentity,
): void {
  const commit = db.transaction(() => {
    persistCodexSessionResult(db, route, result, ok, nowMs, log);
    if (!markInboundHandledIfClaimed(db, inboundId, claimToken, nowMs, identity, 'flushed')) {
      throw new Error(`Inbound claim ${inboundId} changed before completion`);
    }
  });
  commit.immediate();
}

function persistCodexSessionResult(
  db: Database,
  route: OmniRoute,
  result: AgentExecutionResult,
  succeeded: boolean,
  nowMs: number,
  log: (line: string) => void,
): void {
  if ((route.agent ?? 'claude') !== 'codex') return;
  if (succeeded && result.threadId) {
    if (!result.replacesThreadId) {
      const current = getAgentSession(db, 'codex', route.instance, route.chat);
      if (current === result.threadId) return;
      if (current !== undefined) {
        throw new Error('Codex session state changed during execution; the reply was not acknowledged. Retry.');
      }
      if (!insertAgentSessionIfAbsent(db, 'codex', route.instance, route.chat, result.threadId, nowMs)) {
        throw new Error('Codex session state changed during execution; the reply was not acknowledged. Retry.');
      }
      return;
    }
    if (
      !replaceAgentSessionIfCurrent(
        db,
        'codex',
        route.instance,
        route.chat,
        result.replacesThreadId,
        result.threadId,
        nowMs,
      )
    ) {
      throw new Error('Codex session state changed during recovery; the reply was not acknowledged. Retry.');
    }
    return;
  }
  if (!result.clearThreadId) return;
  try {
    clearAgentSessionIfCurrent(db, 'codex', route.instance, route.chat, result.clearThreadId);
  } catch (err) {
    // Retaining the stale id is safe (the next message performs the same bounded
    // recovery) and preferable to hiding the actionable child failure behind a
    // secondary state-cleanup error.
    log(`[omni] could not clear stale Codex thread: ${errText(err)}`);
  }
}

/**
 * Status-ack glyphs for genie's OWN swapping reaction on the approval message.
 * ⏳ on announce (awaiting you), ✅ once approved, ❌ once denied or expired. All
 * three are outside the approve/deny vocab and are set with `fromMe=true`, so
 * they never dual-emit and never self-resolve an approval (SPIKE c).
 */
const STATUS_PENDING = '\u{23F3}'; // ⏳
const STATUS_APPROVED = '\u{2705}'; // ✅
const STATUS_DENIED = '\u{274C}'; // ❌ (denied and expired both land here)
/** The two glyphs that mean "done" — a row whose recorded glyph is one of these
 *  needs no further status ack (the reconciliation pass skips it). */
const TERMINAL_STATUS_GLYPHS = [STATUS_APPROVED, STATUS_DENIED];

/**
 * How far back the reconciliation pass looks for a row still needing a terminal
 * ack (24h). Generous on purpose: a row resolved/expired while `omni serve` was
 * briefly down must still get its ✅/❌ when serve returns, so this must exceed
 * any realistic downtime — it is ~785× the default 110s pollBudget. Older closed
 * rows are presumed already acked (or too stale to matter) and are left alone, so
 * per-tick reconciliation work is bounded and history is never swept.
 */
const RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Distinguishes a budget-driven abort from a genuine child crash in the catch. */
class OneShotTimeoutError extends Error {
  constructor() {
    super('one-shot timed out');
    this.name = 'OneShotTimeoutError';
  }
}

class OneShotStoppedError extends Error {
  constructor() {
    super('omni serve stopped');
    this.name = 'OneShotStoppedError';
  }
}

export function createOmniRunner(deps: OmniRunnerDeps): OmniRunner {
  const { db, config, publish } = deps;
  const flush = deps.flush ?? (async () => {});
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => Date.now());
  const genId =
    deps.genCorrelationId ?? (() => `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  const claimOwner = deps.claimOwner ?? { ownerId: `in-process:${randomUUID()}`, epoch: 0 };
  const claimIdentity = () => ({ ...claimOwner, now: now() });
  const spawnClaude = deps.spawnClaude ?? defaultSpawnClaude;
  const spawnAgent: AgentExecutor =
    deps.spawnAgent ?? ((opts) => (opts.provider === 'claude' ? spawnClaude(opts) : defaultAgentExecutor(opts)));
  const allowMappedAgentExecution =
    deps.allowMappedAgentExecution ??
    (deps.spawnAgent !== undefined ||
      deps.spawnClaude !== undefined ||
      /^(?:1|true|yes|on)$/i.test(process.env.GENIE_OMNI_MAPPED_AGENT_EXECUTION?.trim() ?? ''));
  // Default exceeds the owned HTTP deadline; shutdown aborts requests first,
  // then drains their settlement before the caller may close SQLite/NATS.
  const drainTimeoutMs = Math.max(1, Math.min(deps.drainTimeoutMs ?? 12_000, 30_000));
  const sendApproval = deps.sendApproval ?? makeDefaultOmniSend(config);
  const setReaction = deps.setReaction ?? makeDefaultOmniSetReaction(config);
  const vocab = {
    approveTokens: config.approveTokens,
    denyTokens: config.denyTokens,
    approveReactions: config.approveReactions,
    denyReactions: config.denyReactions,
  };

  // Inbound one-shot routing state (Decision 10 — one in-flight run per route).
  const routes = config.routes ?? [];
  const timeoutMs = config.inboundTimeoutMs ?? 120_000;
  const maxReplyChars = config.inboundMaxReplyChars ?? 4_000;
  /** Routes with a run currently in flight — a second message on one is dropped. */
  const inFlight = new Set<string>();
  /** Live one-shot promises, so `whenIdle` (tests) can await completion. */
  const pending = new Set<Promise<void>>();
  /** Approval ids with an announce send in flight — guards against a second tick
   *  re-sending a row whose `omni_message_id` is not yet stored. */
  const announcing = new Set<string>();
  /** Live announce-send promises, drained by `whenIdle` alongside `pending`. */
  const inFlightSends = new Set<Promise<void>>();
  /** Live status-reaction promises (⏳→✅/❌), also drained by `whenIdle`. */
  const inFlightReactions = new Set<Promise<void>>();
  /** Omni message ids with a status-ack HTTP call currently in flight — guards
   *  the reconciliation pass (every tick) from double-firing an ack whose glyph
   *  the prior emit has not yet recorded. Keyed by the stanza id. */
  const ackInFlight = new Set<string>();
  const activeControllers = new Set<AbortController>();
  const activeHttpControllers = new Set<AbortController>();
  const unroutableRecoveryLogged = new Set<string>();
  let stopped = false;
  const routeKey = (instance: string, chat: string): string => `${instance}\0${chat}`;
  const findRoute = (instance: string, chat: string): OmniRoute | undefined =>
    routes.find((r) => r.instance === instance && r.chat === chat);

  /**
   * Drive one bounded `claude -p` for a mapped inbound. Owns the timeout (races
   * the spawn against an abort), the output cap, and the reply publish. Every
   * exit path publishes exactly one reply, marks the inbound handled, and clears
   * the in-flight flag — a child crash NEVER escapes this function.
   */
  async function runOneShot(
    route: OmniRoute,
    inboundId: string,
    claimToken: string,
    message: string,
    replySubject: string,
    messageId?: string,
  ): Promise<void> {
    const controller = new AbortController();
    activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(new OneShotTimeoutError()), timeoutMs);
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new OneShotTimeoutError()),
        { once: true },
      );
    });
    // ⏳ on the inbound message right before the spawn (route-scoped, no-op if the
    // inbound carried no stanza id) — the first half of the run's ⏳→✅/❌ ack. The
    // settlement promise (always fulfilled — emit errors are swallowed inside) is
    // kept so the final ✅/❌ can be chained AFTER the ⏳ HTTP call has landed: a run
    // that finishes before the ⏳ reaches the API must never leave ✅→⏳ reordered.
    const pendingAck = emitRouteReaction(route, messageId, STATUS_PENDING);
    let spawned: Promise<AgentExecutionResult> | undefined;
    try {
      // Wrap so a SYNCHRONOUS throw from the executor becomes a rejection the
      // race can observe — and so `aborted` always gets a handler attached
      // (else a late finally-abort would surface as an unhandled rejection).
      spawned = Promise.resolve().then(() =>
        spawnAgent({
          provider: route.agent ?? 'claude',
          message,
          cwd: route.repo,
          signal: controller.signal,
          personaFile: resolvePersonaFile(route),
          sessionId: deterministicSessionId(route.instance, route.chat),
          threadId: currentCodexThread(db, route),
        }),
      );
      let result: AgentExecutionResult;
      let ok: boolean;
      let content: string;
      try {
        result = await Promise.race([spawned, aborted]);
        // A non-zero exit OR a soft-error terminal result (is_error / non-success /
        // empty) is a failure — never publish the raw NDJSON blob as a happy reply.
        ok = result.exitCode === 0 && !result.isError;
        content = oneShotResultContent(result, ok, maxReplyChars);
      } catch (error) {
        result = { stdout: '', exitCode: 1, isError: true };
        ok = false;
        content = oneShotFailureContent(error, timeoutMs);
      }
      await prepareAndDeliverInbound(route, inboundId, claimToken, replySubject, content, result, ok);
      // ✅ once a genuine reply is published; ❌ on a non-zero exit or soft error.
      // Chained on the ⏳ emit's settlement (fulfilled even when it failed) so the
      // pair reaches the API in order; still fire-and-forget for this run.
      pendingAck.finally(() => emitRouteReaction(route, messageId, ok ? STATUS_APPROVED : STATUS_DENIED));
    } catch (err) {
      // The durable prepared/flushed phase is preserved while ownership is
      // released. A successor epoch can retry the same stable request id rather
      // than re-running the workspace-writing agent.
      releaseInboundClaim(db, inboundId, claimToken, claimIdentity());
      log(`[omni] reply delivery/state commit failed for ${inboundId}: ${errText(err)}`);
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort(new OneShotStoppedError());
      // The executor contract requires abort to settle the child. Wait for that
      // cleanup before any DB/NATS owner is allowed to close.
      if (spawned) await Promise.allSettled([spawned]);
      activeControllers.delete(controller);
      inFlight.delete(routeKey(route.instance, route.chat));
    }
  }

  async function deliverPreparedInbound(
    route: OmniRoute,
    inboundId: string,
    claimToken: string,
    delivery: InboundPreparedDelivery,
  ): Promise<boolean> {
    if (delivery.phase === 'prepared') {
      publish(delivery.subject, delivery.payload);
      await flush();
      if (!markInboundDeliveryFlushed(db, inboundId, claimToken, claimIdentity())) {
        throw new Error(`Inbound claim ${inboundId} changed before flush commit`);
      }
    }
    const decoded = decodeDeliveryMeta(delivery.meta);
    commitPublishedInbound(db, route, decoded.result, decoded.ok, inboundId, claimToken, now(), log, claimIdentity());
    return decoded.ok;
  }

  async function prepareAndDeliverInbound(
    route: OmniRoute,
    inboundId: string,
    claimToken: string,
    subject: string,
    content: string,
    result: AgentExecutionResult,
    ok: boolean,
  ): Promise<void> {
    const eventId = genId();
    const delivery: InboundPreparedDelivery = {
      phase: 'prepared',
      eventId,
      subject,
      payload: buildRoutedReplyPayload(route.instance, route.chat, content, eventId, now()),
      meta: encodeDeliveryMeta(result, ok),
    };
    if (!prepareInboundDelivery(db, inboundId, claimToken, claimIdentity(), delivery)) {
      throw new Error(`Inbound claim ${inboundId} changed before delivery preparation`);
    }
    await deliverPreparedInbound(route, inboundId, claimToken, delivery);
  }

  /**
   * Spawn (or drop-with-notice) a one-shot for a mapped inbound. Adds the route
   * to `inFlight` SYNCHRONOUSLY before any await so a second message racing the
   * first sees it busy. Fire-and-forget: the serve loop never awaits the run.
   */
  function startRoutedRun(
    route: OmniRoute,
    inboundId: string,
    claimToken: string,
    message: string,
    messageId?: string,
  ): void {
    if (stopped) return;
    const replySubject = `omni.reply.${route.instance}.${route.chat}`;
    const key = routeKey(route.instance, route.chat);
    if (inFlight.has(key)) {
      const busy = prepareAndDeliverInbound(
        route,
        inboundId,
        claimToken,
        replySubject,
        BUSY_NOTICE,
        { stdout: '', exitCode: 1, isError: true },
        false,
      )
        .then(() => log(`[omni] route ${key} busy — dropped inbound ${inboundId} with notice`))
        .catch((err) => {
          releaseInboundClaim(db, inboundId, claimToken, claimIdentity());
          log(`[omni] busy notice delivery/state commit failed for ${inboundId}: ${errText(err)}`);
        })
        .finally(() => pending.delete(busy));
      pending.add(busy);
      return;
    }
    inFlight.add(key);
    const run = runOneShot(route, inboundId, claimToken, message, replySubject, messageId)
      .catch((err) => log(`[omni] one-shot crashed unexpectedly: ${errText(err)}`))
      .finally(() => pending.delete(run));
    pending.add(run);
  }

  function startRoutedRecovery(
    route: OmniRoute,
    inboundId: string,
    claimToken: string,
    claim: InboundClaimResult,
    messageId?: string,
  ): void {
    const key = routeKey(route.instance, route.chat);
    inFlight.add(key);
    const replySubject = `omni.reply.${route.instance}.${route.chat}`;
    const recovery = (
      claim.mode === 'resume-delivery' && claim.delivery
        ? deliverPreparedInbound(route, inboundId, claimToken, claim.delivery)
        : prepareAndDeliverInbound(
            route,
            inboundId,
            claimToken,
            replySubject,
            INTERRUPTED_NOTICE,
            { stdout: '', exitCode: 1, isError: true },
            false,
          ).then(() => false)
    )
      .then((ok) => {
        emitRouteReaction(route, messageId, ok ? STATUS_APPROVED : STATUS_DENIED);
      })
      .catch((error) => {
        releaseInboundClaim(db, inboundId, claimToken, claimIdentity());
        log(`[omni] durable delivery recovery failed for ${inboundId}: ${errText(error)}`);
      })
      .finally(() => {
        inFlight.delete(key);
        pending.delete(recovery);
      });
    pending.add(recovery);
  }

  function recoverAbandonedInbound(): void {
    for (const event of listRecoverableInbound(db, claimOwner.epoch)) {
      const route = findRoute(event.instance, event.chat);
      if (!route) {
        if (!unroutableRecoveryLogged.has(event.eventKey)) {
          unroutableRecoveryLogged.add(event.eventKey);
          log(`[omni] durable inbound ${event.eventKey} needs recovery but its route is no longer configured`);
        }
        continue;
      }
      if (inFlight.has(routeKey(route.instance, route.chat))) continue;
      const claimToken = randomUUID();
      const claim = recordAndClaimInboundDelivery(db, {
        instance: event.instance,
        chat: event.chat,
        sender: event.sender,
        body: event.body,
        eventKey: event.eventKey,
        claimToken,
        claimOwnerId: claimOwner.ownerId,
        claimEpoch: claimOwner.epoch,
        now: now(),
      });
      if (claim) startRoutedRecovery(route, claim.id, claimToken, claim);
    }
  }

  /**
   * Set (or swap) genie's OWN status reaction (⏳/✅/❌) on the approval message.
   * Fire-and-forget behind the injectable {@link setReaction} seam and drained by
   * `whenIdle`, so the resolve/announce hot paths never block on the HTTP call. A
   * missing target id (send failed → row un-tagged) is a no-op, as is a target
   * whose ack is already in flight (the reconciliation guard).
   *
   * The glyph is recorded (via {@link recordStatusGlyph}) ONLY on a confirmed
   * successful set: a dropped/failed react leaves `last_status_glyph` unchanged so
   * the reconciliation pass retries it next tick. Never throws — a failed status
   * reaction is logged and the approval decision still stands.
   *
   * Returns the emit's SETTLEMENT promise (always fulfilled — rejections are
   * swallowed above; no-op emits resolve immediately) so a caller can sequence a
   * follow-up ack after this one without ever awaiting it on the hot path.
   */
  function emitReaction(params: {
    instance: string;
    chat: string;
    targetId: string | null | undefined;
    emoji: string;
    /** Persist the glyph on `last_status_glyph` (approval rows only). */
    recordGlyph: boolean;
    /** Apply the `ackInFlight` double-fire guard (approval reconciliation only). */
    guard: boolean;
  }): Promise<void> {
    const { instance, chat, targetId, emoji, recordGlyph, guard } = params;
    if (stopped || !targetId) return Promise.resolve();
    if (guard && ackInFlight.has(targetId)) return Promise.resolve();
    if (guard) ackInFlight.add(targetId);
    const controller = new AbortController();
    activeHttpControllers.add(controller);
    const react = setReaction({ instance, chat, messageId: targetId, emoji, signal: controller.signal })
      .then((res) => {
        if (stopped) return;
        if (res && res.success === false) {
          log(`[omni] status ${emoji} on ${targetId} failed${res.error ? ` (${redactOmniOutbound(res.error)})` : ''}`);
          return;
        }
        if (recordGlyph) recordStatusGlyph(db, targetId, emoji); // persist only on confirmed success
      })
      .catch((err) => log(`[omni] status ${emoji} on ${targetId} failed: ${redactOmniOutbound(errText(err))}`))
      .finally(() => {
        activeHttpControllers.delete(controller);
        if (guard) ackInFlight.delete(targetId);
        inFlightReactions.delete(react);
      });
    inFlightReactions.add(react);
    return react;
  }

  /** Approval-scoped ⏳/✅/❌ ack: scoped to the approval chat, glyph-recorded and
   *  reconciliation-guarded. Unchanged behaviour from before the route path. */
  function emitStatusReaction(targetId: string | null | undefined, emoji: string): void {
    emitReaction({
      instance: config.instance ?? '',
      chat: config.approvalChat ?? '',
      targetId,
      emoji,
      recordGlyph: true,
      guard: true,
    });
  }

  /**
   * Route-scoped run ack: ⏳ before the spawn, ✅ once a reply is published, ❌ on
   * failure/timeout — set on the INBOUND user message (`messageId`), scoped to the
   * route's own (instance, chat), NOT the approval chat. No glyph is recorded (a
   * plain inbound has no approval row) and no reconciliation guard applies (the
   * ⏳→✅/❌ pair fires exactly once, sequentially, per run). A missing messageId is
   * a no-op. Fire-and-forget, drained by `whenIdle`; never blocks the run. Returns
   * the emit's settlement promise so {@link runOneShot} can chain the final ✅/❌
   * after the ⏳ has landed (else a fast run could get its acks reordered at the API).
   */
  function emitRouteReaction(route: OmniRoute, messageId: string | undefined, emoji: string): Promise<void> {
    return emitReaction({
      instance: route.instance,
      chat: route.chat,
      targetId: messageId,
      emoji,
      recordGlyph: false,
      guard: false,
    });
  }

  /**
   * Resolve the persona file for a route: the explicit `route.persona` if set,
   * else `<repo>/AGENTS.md`. BOTH candidates are existence-checked — a typo'd
   * `route.persona` would otherwise make claude exit 1 on every run, so a missing
   * explicit path is logged and dropped rather than passed through.
   */
  function resolvePersonaFile(route: OmniRoute): string | undefined {
    const candidate = route.persona ?? join(route.repo, 'AGENTS.md');
    if (existsSync(candidate)) return candidate;
    if (route.persona) log(`[omni] route ${route.instance} ${route.chat}: persona file not found: ${route.persona}`);
    return undefined;
  }

  /**
   * Announce a single pending approval via the id-returning send and tag the row
   * with the REAL Omni message id (the stanza id) the send returns — so an
   * inbound reaction correlates to THIS approval. Tags only on a successful send;
   * a confirmed id-less failure releases the claim for retry, while a thrown
   * in-flight transport result becomes explicit ambiguous state so a successor
   * cannot duplicate a possibly accepted prompt. On a successful tag it sets the
   * current status reaction (including an immediate terminal glyph when the row
   * resolved during send). Never throws.
   */
  async function sendAnnounce(
    appr: { id: string; tool: string; inputSummary: string },
    claimToken: string,
  ): Promise<void> {
    const text = formatApprovalMessage(appr.tool, appr.inputSummary);
    const controller = new AbortController();
    activeHttpControllers.add(controller);
    try {
      if (!markApprovalAnnouncementSending(db, appr.id, claimToken, claimIdentity())) {
        log(`[omni] announce ${appr.id}: durable claim changed before send`);
        return;
      }
      const result = await sendApproval({
        instance: config.instance ?? '',
        chat: config.approvalChat ?? '',
        text,
        signal: controller.signal,
      });
      if (!result.messageId) {
        log(
          `[omni] announce ${appr.id}: send returned no messageId${result.error ? ` (${redactOmniOutbound(result.error)})` : ''} — will retry`,
        );
        releaseApprovalAnnouncementWithLease(db, appr.id, claimToken, claimIdentity());
        return;
      }
      const completion = finalizeApprovalAnnouncement(db, appr.id, claimToken, result.messageId, claimIdentity());
      if (!completion.attached) {
        log(`[omni] announce ${appr.id}: durable claim was lost; external id was not overwritten`);
        return;
      }
      log(`[omni] announced approval ${appr.id} (omni ${result.messageId})`);
      const glyph =
        completion.status === 'pending'
          ? STATUS_PENDING
          : completion.status === 'approved'
            ? STATUS_APPROVED
            : STATUS_DENIED;
      emitStatusReaction(result.messageId, glyph);
    } catch (err) {
      // Once HTTP starts, a thrown transport error cannot prove whether Omni
      // accepted the prompt. Preserve an explicit ambiguous phase rather than
      // silently issuing a duplicate prompt from the next resident.
      markApprovalAnnouncementAmbiguous(db, appr.id, claimToken, claimIdentity());
      if (!stopped) {
        log(`[omni] announce ${appr.id} failed: ${redactOmniOutbound(errText(err))}`);
      }
    } finally {
      activeHttpControllers.delete(controller);
    }
  }

  /**
   * Send every un-announced pending approval. Fire-and-forget per row (the tick
   * loop never blocks on a slow HTTP send), guarded by `announcing` so a second
   * tick before the first send settles does not double-send.
   */
  function announce(): void {
    for (const appr of listPendingApprovals(db)) {
      if (appr.omniMessageId) continue; // already announced
      if (announcing.has(appr.id)) continue; // send in flight
      const claimToken = randomUUID();
      const outcome = claimApprovalAnnouncementWithLease(db, appr.id, claimToken, claimIdentity());
      if (outcome === 'ambiguous') {
        log(`[omni] approval ${appr.id} has an ambiguous prior send; refusing to duplicate the prompt`);
        continue;
      }
      if (outcome !== 'claimed') continue;
      announcing.add(appr.id);
      const send = sendAnnounce(appr, claimToken).finally(() => {
        announcing.delete(appr.id);
        inFlightSends.delete(send);
      });
      inFlightSends.add(send);
    }
  }

  function resolveOldest(decision: ApprovalDecision, resolvedBy: string, note: string): boolean {
    const pending = listPendingApprovals(db);
    if (pending.length === 0) return false;
    return tryResolve(pending[0].id, decision, resolvedBy, note);
  }

  function tryResolve(id: string, decision: ApprovalDecision, resolvedBy: string, note: string): boolean {
    try {
      // Stamp resolved_at with the runner clock so the reconciliation recency
      // window (which reads now() from the same dep) lines up deterministically.
      const row = resolveApproval(db, id, decision, resolvedBy, now());
      log(`[omni] resolved ${id} → ${decision} by ${resolvedBy} (${note})`);
      // Swap the ⏳ status reaction to ✅ (approved) / ❌ (denied) — the row is
      // now closed, so this is the second half of the ⏳→✅/❌ ack.
      emitStatusReaction(row.omniMessageId, decision === 'approved' ? STATUS_APPROVED : STATUS_DENIED);
      return true;
    } catch (err) {
      // Lost the race to another resolver — benign under concurrency.
      if (err instanceof ApprovalConflictError) return false;
      throw err;
    }
  }

  /**
   * Resolve an approval from an inbound reaction. Correlates by the stored real
   * Omni message id (the reaction's target stanza id, from the `[Reaction: … on
   * message <id>]` content or the top-level `messageId`). An EXPLICIT target that
   * matches no pending row is a NO-OP (logged, ignored) — NOT an oldest fallback:
   * a reaction on an already-resolved / unknown message must never resolve some
   * unrelated pending approval (the concurrency hazard this wish exists to kill).
   * Oldest fallback is reserved for the no-target-id case; reactions always carry
   * a target id, so this branch is defensive. Non-vocabulary emoji are ignored.
   */
  function resolveReaction(emoji: string, targetId: string | undefined, sender: string): boolean {
    const decision = matchReaction(emoji, vocab);
    if (!decision) return false;
    if (targetId) {
      const match = listPendingApprovals(db).find((a) => a.omniMessageId === targetId);
      if (match) {
        tryResolve(match.id, decision, sender, `reaction ${emoji}`);
      } else {
        log(`[omni] reaction ${emoji} targets unknown/resolved id ${targetId} — ignored (no oldest fallback)`);
      }
      return true;
    }
    resolveOldest(decision, sender, `reaction ${emoji} (fallback)`);
    return true;
  }

  function handleApprovalBody(body: string, messageId: string | undefined, sender: string): boolean {
    if (!body) return false;
    const reaction = parseReaction(body);
    if (reaction) return resolveReaction(reaction.emoji, reaction.targetId || messageId, sender);
    const decision = matchTextToken(body, vocab);
    if (!decision) return false;
    resolveOldest(decision, sender, `text:"${body.trim().toLowerCase()}"`);
    return true;
  }

  /**
   * Reconcile the status reaction on every DONE-but-not-terminally-acked row:
   * swap its ⏳ (or missing) glyph to ✅ (approved) / ❌ (denied or expired). This
   * makes the RUNNER the authoritative acker regardless of WHO closed the row —
   * closing the hook-fork-expiry race (the hook's `expireOwnRow` expires the row
   * but sets no reaction, so a ⏳ would otherwise stick on the phone forever) AND
   * any transport-dropped swap (a failed resolve/announce react left the glyph
   * non-terminal). Idempotent: {@link emitStatusReaction} records the terminal
   * glyph on success, so the next tick's query no longer returns the row; the
   * `ackInFlight` guard stops a slow ack re-firing before its glyph is recorded.
   */
  function reconcileStatusAcks(): void {
    for (const row of listApprovalsNeedingStatusAck(db, TERMINAL_STATUS_GLYPHS, now(), RECONCILE_WINDOW_MS)) {
      emitStatusReaction(row.omniMessageId, row.status === 'approved' ? STATUS_APPROVED : STATUS_DENIED);
    }
  }

  async function drain(): Promise<void> {
    const deadline = Date.now() + drainTimeoutMs;
    while (pending.size > 0 || inFlightSends.size > 0 || inFlightReactions.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Omni drain exceeded ${drainTimeoutMs}ms`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timedOut = await Promise.race([
          Promise.allSettled([...pending, ...inFlightSends, ...inFlightReactions]).then(() => false),
          new Promise<true>((resolve) => {
            timer = setTimeout(() => resolve(true), remaining);
            if (typeof timer.unref === 'function') timer.unref();
          }),
        ]);
        if (timedOut) throw new Error(`Omni drain exceeded ${drainTimeoutMs}ms`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  return {
    tick(): void {
      if (stopped) return;
      recoverAbandonedInbound();
      // Expire stale rows, then let reconciliation set the terminal ✅/❌ on any
      // row closed here OR by the hook fork's own self-timeout expiry.
      expireStale(db, config.approvals.pollBudgetMs, now());
      reconcileStatusAcks();
      announce();
    },

    handleMessage(subject: string, data: string): void {
      if (stopped) return;
      const frame = parseInboundFrame(subject, data, config.instance);
      if (!frame.ok) {
        if (frame.reason) log(`[omni] rejected inbound with ${frame.reason}`);
        return;
      }
      const { msg, instance, chat, sender, body } = frame;

      // Insert + claim one stable transport event. NATS is at-least-once, so an
      // exact redelivery (including one seen by a second runner) must not spawn,
      // reply, announce, or resolve twice.
      const claimToken = randomUUID();
      const claim = recordAndClaimInboundDelivery(db, {
        instance,
        chat,
        sender,
        body,
        eventKey: inboundEventKey(subject, data),
        claimToken,
        claimOwnerId: claimOwner.ownerId,
        claimEpoch: claimOwner.epoch,
        now: now(),
      });
      if (!claim) return;
      const inboundId = claim.id;
      let routed = false;
      const finishSynchronous = (handled: boolean) => {
        if (routed) return;
        if (handled) markInboundHandledIfClaimed(db, inboundId, claimToken, now(), claimIdentity());
        else releaseInboundClaim(db, inboundId, claimToken, claimIdentity());
      };

      // Mapped (instance, chat) → spawn a bounded one-shot; unmapped is store-only.
      // Thread the inbound WhatsApp stanza id so the run can ⏳→✅/❌ react on it.
      // A reaction frame must NOT start a run: its body is `[Reaction: …]` (a
      // nonsense prompt) and its `messageId` is the REACTED-TO message, so the
      // run's ⏳→✅/❌ ack would mutate that prior message. Skip it — and an
      // empty/whitespace body — with no ack and no reply (the inbound is already
      // stored above, and the approval-chat reaction path below still runs).
      const route = findRoute(instance, chat);
      const routeActionable = Boolean(route) && !parseReaction(body) && body.trim().length > 0;
      if (routeActionable) {
        if (allowMappedAgentExecution) {
          routed = true;
          if (claim.mode === 'fresh') {
            startRoutedRun(route as OmniRoute, inboundId, claimToken, body, msg.messageId);
          } else {
            startRoutedRecovery(route as OmniRoute, inboundId, claimToken, claim, msg.messageId);
          }
        } else {
          log(
            `[omni] mapped execution disabled for ${routeKey(instance, chat)}; set GENIE_OMNI_MAPPED_AGENT_EXECUTION=1 only after accepting the credential boundary`,
          );
        }
      }

      // Only the approval chat can resolve approvals.
      if (chat !== config.approvalChat) {
        finishSynchronous(false);
        return;
      }
      // Reaction targets and bare text vocabulary are both handled here; the
      // dual-emit bare emoji remains unmatched and therefore cannot resolve twice.
      finishSynchronous(handleApprovalBody(body, msg.messageId, sender));
    },

    async whenIdle(): Promise<void> {
      // Drain one-shot runs, announce sends, AND status reactions in a loop: a
      // send settles by firing the ⏳ status reaction (adds to inFlightReactions
      // mid-drain), and a resolve fires ✅/❌, so the loop must keep going until
      // every set has quiesced.
      await drain();
    },

    async stop(): Promise<void> {
      if (!stopped) {
        stopped = true;
        for (const controller of activeControllers) controller.abort(new OneShotStoppedError());
        for (const controller of activeHttpControllers) controller.abort(new OneShotStoppedError());
      }
      await drain();
    },
  };
}

// ============================================================================
// Serve loop
// ============================================================================

export interface RunOmniServeOptions {
  db: Database;
  config: OmniRuntimeConfig;
  natsFactory?: NatsFactory;
  /** Abort to stop the loop (unsubscribe, clear timer, close connection). */
  signal?: AbortSignal;
  /** Fired once subscriptions + tick loop are live (tests await this). */
  onReady?: () => void;
  log?: (line: string) => void;
  /** Focused test seam for child/transport side effects; production omits it. */
  runnerDeps?: Omit<OmniRunnerDeps, 'db' | 'config' | 'publish'>;
  /** Test seam for the machine-wide resident lease. Production uses 30s. */
  leaseTtlMs?: number;
}

/** Drain one subscription into a handler, tolerating per-message failures. */
async function consume(
  sub: NatsSubscription,
  handle: (subject: string, data: string) => void,
  log: (line: string) => void,
): Promise<void> {
  const dec = new TextDecoder();
  try {
    for await (const m of sub) {
      try {
        handle(m.subject, dec.decode(m.data));
      } catch (err) {
        log(`[omni] handler error on ${m.subject}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch {
    // Subscription closed (unsubscribe / connection teardown) — normal exit.
  }
}

interface OmniServeLease {
  signal: AbortSignal;
  ownerId: string;
  epoch: number;
  release(): void;
}

function openOmniServeLease(db: Database, ttlMs: number): OmniServeLease {
  const name = 'omni-serve';
  const ownerId = `${process.pid}:${randomUUID()}`;
  const epoch = acquireServiceLeaseEpoch(db, name, ownerId, Date.now(), ttlMs);
  if (epoch === undefined) {
    throw new Error('another genie omni serve process owns the machine-wide resident lease');
  }
  const controller = new AbortController();
  const timer = setInterval(
    () => {
      try {
        if (!renewServiceLease(db, name, ownerId, Date.now(), ttlMs, epoch)) {
          controller.abort(new Error('Omni serve lost its machine-wide resident lease'));
        }
      } catch (error) {
        controller.abort(error instanceof Error ? error : new Error(String(error)));
      }
    },
    Math.max(50, Math.floor(ttlMs / 3)),
  );
  if (typeof timer.unref === 'function') timer.unref();
  let released = false;
  return {
    signal: controller.signal,
    ownerId,
    epoch,
    release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      releaseServiceLease(db, name, ownerId, epoch);
    },
  };
}

async function waitForOmniStop(external: AbortSignal | undefined, lease: AbortSignal): Promise<void> {
  if (external?.aborted) return;
  if (lease.aborted) throw lease.reason ?? new Error('Omni serve lease lost');
  await new Promise<void>((resolve, reject) => {
    external?.addEventListener('abort', () => resolve(), { once: true });
    lease.addEventListener('abort', () => reject(lease.reason ?? new Error('Omni serve lease lost')), { once: true });
  });
}

async function settleCleanupAction(
  label: string,
  action: () => void | Promise<void>,
  timeoutMs: number,
  errors: Error[],
): Promise<boolean> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
        if (typeof deadline.unref === 'function') deadline.unref();
      }),
    ]);
    return true;
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(`${label}: ${String(error)}`));
    return false;
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

async function closeOmniResources(
  runner: OmniRunner | undefined,
  subscription: NatsSubscription | undefined,
  consumeTask: Promise<void> | undefined,
  nc: NatsLike | undefined,
  timeoutMs: number,
): Promise<Error[]> {
  const errors: Error[] = [];
  const stopping = runner?.stop();
  void stopping?.catch(() => {});
  const unsubscribed = subscription
    ? await settleCleanupAction('Omni subscription unsubscribe', () => subscription.unsubscribe(), timeoutMs, errors)
    : true;
  if (stopping) await settleCleanupAction('Omni runner stop', () => stopping, timeoutMs, errors);
  if (!unsubscribed && nc) await settleCleanupAction('Omni NATS close', () => nc.close(), timeoutMs, errors);
  if (consumeTask) await settleCleanupAction('Omni subscription drain', () => consumeTask, timeoutMs, errors);
  if (unsubscribed && nc) await settleCleanupAction('Omni NATS close', () => nc.close(), timeoutMs, errors);
  return errors;
}

export async function runOmniServe(opts: RunOmniServeOptions): Promise<void> {
  const { db, config } = opts;
  const log = opts.log ?? (() => {});
  const factory = opts.natsFactory ?? defaultNatsFactory;
  const cleanupTimeoutMs = Math.max(1, Math.min((opts.runnerDeps?.drainTimeoutMs ?? 12_000) + 1_000, 31_000));
  const leaseTtlMs = Math.max(100, Math.min(opts.leaseTtlMs ?? 30_000, 300_000));
  let lease: OmniServeLease | undefined;
  let nc: NatsLike | undefined;
  let runner: OmniRunner | undefined;
  let msgSub: NatsSubscription | undefined;
  let consumeTask: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let hasPrimaryError = false;
  let primaryError: unknown;

  const cleanupErrors: Error[] = [];

  try {
    lease = openOmniServeLease(db, leaseTtlMs);

    nc = await factory({ servers: config.natsUrl });
    runner = createOmniRunner({
      ...opts.runnerDeps,
      db,
      config,
      publish: nc.publish,
      flush: () => nc?.flush() ?? Promise.resolve(),
      claimOwner: { ownerId: lease.ownerId, epoch: lease.epoch },
      log,
    });

    // Both text replies AND reactions arrive on this instance-bound subject.
    msgSub = nc.subscribe(`omni.message.${config.instance}.>`);
    consumeTask = consume(msgSub, runner.handleMessage, log);

    timer = setInterval(() => {
      try {
        runner?.tick();
      } catch (err) {
        log(`[omni] tick error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, config.approvals.pollIntervalMs);

    runner.tick();
    log(`[omni] serving — instance=${config.instance} chat=${config.approvalChat} nats=${config.natsUrl}`);
    opts.onReady?.();

    await waitForOmniStop(opts.signal, lease.signal);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    if (timer) clearInterval(timer);
    cleanupErrors.push(...(await closeOmniResources(runner, msgSub, consumeTask, nc, cleanupTimeoutMs)));
    if (lease) {
      try {
        lease.release();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(`Omni lease release: ${String(error)}`));
      }
    }

    if (cleanupErrors.length > 0 && hasPrimaryError) {
      for (const error of cleanupErrors) log(`[omni] cleanup error after primary failure: ${error.message}`);
    }
    if (nc) log('[omni] stopped');
  }
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Omni shutdown failed');
}
