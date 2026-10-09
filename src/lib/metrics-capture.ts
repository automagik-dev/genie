/**
 * Opt-in lifecycle capture — the local ledger that lets genie measure itself
 * without adding a single agent action.
 *
 * Every card transition already lands in the per-repo `task_events` table with
 * its runtime kind and timestamp. What that table cannot carry is the RUNTIME
 * SESSION the transition happened in: `task_events` is published into the
 * git-tracked `.genie/roadmap.json`, and a session id there would leak a key
 * into private transcripts. So when — and only when — the operator ran
 * `genie metrics enable`, the same write also appends one metadata line to the
 * machine-local `<GENIE_HOME>/metrics/events.jsonl`. A later, explicit export
 * joins those lines with the runtime's own session log (Claude Code, Codex,
 * pi/OMP) to recover tokens, cache and latency per lifecycle interval.
 *
 * Off is the default and it is free: one failed `stat` on the signal file, no
 * config parse, no directory, no file, no network. Nothing here may change a
 * command's exit code or stderr — every failure is swallowed.
 *
 * Nothing is hardcoded about where the data goes: this module never talks to a
 * network endpoint. Export is a separate operator command.
 */

import { closeSync, mkdirSync, openSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { resolveGenieHome } from './genie-home.js';
import { VERSION } from './version.js';

/** Bumped on any change to the shape of an `events.jsonl` line. */
export const CAPTURE_SCHEMA_VERSION = 1;

/** `GENIE_METRICS=off` (or 0/false/no, any case) disables capture for one process even when enabled. Env may only disable. */
const DISABLE_ENV = 'GENIE_METRICS';
const DISABLE_VALUES = new Set(['off', '0', 'false', 'no']);

function disabledByEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env[DISABLE_ENV];
  return value !== undefined && DISABLE_VALUES.has(value.trim().toLowerCase());
}

export function metricsDir(): string {
  return join(resolveGenieHome(), 'metrics');
}

/** The one switch. Its existence as a regular file means capture is on. */
export function captureSignalPath(): string {
  return join(metricsDir(), 'capture.on');
}

export function captureLedgerPath(): string {
  return join(metricsDir(), 'events.jsonl');
}

export function isCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (disabledByEnv(env)) return false;
  try {
    return statSync(captureSignalPath()).isFile();
  } catch {
    return false;
  }
}

/**
 * A real per-repo database is always `<repo root>/.genie/genie.db` (`genie-db.ts`; worktrees share the
 * main checkout's). Anything else — a test's `race.db`, a scratch script's file — is not a card
 * lifecycle anyone measures, so capture skips it and the export ignores it. Where the repository lives
 * is irrelevant: a fixture repo under `/tmp` is canonical. A relative path is not: it names no
 * repository without a cwd the line does not carry, and the opener always hands over an absolute one.
 * String checks only — this runs on every card event.
 */
export function isCanonicalRepoDb(path: string): boolean {
  return isAbsolute(path) && basename(path) === 'genie.db' && basename(dirname(path)) === '.genie';
}

export type SessionSource = 'claude-code' | 'codex' | 'pi';

export interface RuntimeSession {
  /** The runtime's own session id, as its session log names it; null when no runtime marker is present. */
  id: string | null;
  source: SessionSource | null;
  /** The session log path when the runtime exports it (pi `PI_SESSION_FILE`). */
  file: string | null;
  /** Session markers of two runtimes were present (a nested shell): which is inner is unknowable, so no id is kept. */
  ambiguous?: boolean;
}

/**
 * Read the runtime session id the runtime itself exports to its tool shells.
 * Verified live 2026-10-04: Claude Code `CLAUDE_CODE_SESSION_ID`; Codex
 * `CODEX_THREAD_ID` (equal to the rollout's `session_meta.session_id`); pi
 * `PI_SESSION_ID` plus `PI_SESSION_FILE`. OMP 18.6.1 exports `OMPCODE=1` and NO
 * session id to its tool shells, so an OMP line carries `{source: 'pi', id: null}`
 * plus the capture `cwd`, and the export matches OMP's own session file by that
 * cwd and the interval's time window (labelled, never exact). No marker → all
 * null, never a guess.
 */
export function resolveRuntimeSession(env: NodeJS.ProcessEnv = process.env): RuntimeSession {
  // Presence cannot tell which of two nested runtimes is the inner one, so when the session markers of
  // two runtimes coexist no id is kept (ambiguous) rather than guessing a possibly-outer one. OMP's own
  // CLAUDECODE=1 is not a session marker, so a plain OMP shell is unambiguous; but OMP exports no
  // PI_SESSION_*, so PI_SESSION_* inside an OMP shell came from an outer pi and makes it ambiguous too.
  const omp = Boolean(env.OMPCODE);
  const pi = Boolean(env.PI_SESSION_ID || env.PI_SESSION_FILE);
  const codex = Boolean(env.CODEX_THREAD_ID);
  const claude = Boolean(env.CLAUDE_CODE_SESSION_ID);
  // The same order as resolveAuthorKind, so the event's author and its session never disagree.
  const source: SessionSource | null = omp ? 'pi' : codex ? 'codex' : pi ? 'pi' : claude ? 'claude-code' : null;
  if ([omp, pi, codex, claude].filter(Boolean).length > 1) return { id: null, source, file: null, ambiguous: true };
  if (omp) return { id: null, source: 'pi', file: null };
  if (codex) return { id: env.CODEX_THREAD_ID as string, source: 'codex', file: null };
  if (pi) return { id: env.PI_SESSION_ID || null, source: 'pi', file: env.PI_SESSION_FILE || null };
  if (claude) return { id: env.CLAUDE_CODE_SESSION_ID as string, source: 'claude-code', file: null };
  return { id: null, source: null, file: null };
}

export interface LifecycleEventInput {
  /** Absolute path of the per-repo genie.db the event was written to — the export's join key. */
  db: string;
  taskId: string;
  /** `task_events.id` of the row just written. */
  eventId: number;
  kind: string;
  authorKind: string | null;
  createdAt: number;
}

export interface CaptureLine {
  v: number;
  source: 'task_event';
  db: string;
  task: string;
  event: number;
  kind: string;
  authorKind: string | null;
  at: number;
  session: RuntimeSession;
  /** Only for a pi/OMP shell that exported no session id: the export's window join needs it. */
  cwd?: string;
  genie: string;
  pid: number;
}

export function buildCaptureLine(input: LifecycleEventInput, env: NodeJS.ProcessEnv = process.env): CaptureLine {
  const session = resolveRuntimeSession(env);
  const anonymousPi = session.source === 'pi' && session.id === null && session.file === null && !session.ambiguous;
  return {
    v: CAPTURE_SCHEMA_VERSION,
    source: 'task_event',
    db: input.db,
    task: input.taskId,
    event: input.eventId,
    kind: input.kind,
    authorKind: input.authorKind,
    at: input.createdAt,
    session,
    ...(anonymousPi ? { cwd: process.cwd() } : {}),
    genie: VERSION,
    pid: process.pid,
  };
}

/**
 * Append one line for a just-written card event, when capture is enabled.
 * One O_APPEND write of one line: concurrent writers from many worktrees never
 * tear it (measured: 16 × 5,000 appends, 0 torn, at ~200 B and ~3.8 KB).
 *
 * The line is written inside the caller's transaction, before commit. If that
 * transaction rolls back, SQLite also rolls back the AUTOINCREMENT counter and
 * the next insert REUSES the event id — so `(db, event)` alone is not a join
 * key. A consumer joins on `(db, task, event, kind, at)`: the stray line's
 * `at` (the rolled-back row's `created_at`) matches no stored row, and the line
 * is reported unmatched, never attributed.
 *
 * An event of a database that is not a per-repo one ({@link isCanonicalRepoDb}) is skipped, silently
 * like every other skip.
 */
export function recordLifecycleEvent(input: LifecycleEventInput, env: NodeJS.ProcessEnv = process.env): void {
  if (!isCanonicalRepoDb(input.db)) return;
  if (!isCaptureEnabled(env)) return;
  try {
    mkdirSync(metricsDir(), { recursive: true, mode: 0o700 });
    const fd = openSync(captureLedgerPath(), 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(buildCaptureLine(input, env))}\n`);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Capture is an observer: it never fails, slows or changes the command it observes.
  }
}

export interface CaptureStatus {
  enabled: boolean;
  disabledByEnv: boolean;
  signal: string;
  ledger: string;
  ledgerBytes: number | null;
  session: RuntimeSession;
}

export function captureStatus(env: NodeJS.ProcessEnv = process.env): CaptureStatus {
  let ledgerBytes: number | null = null;
  try {
    ledgerBytes = statSync(captureLedgerPath()).size;
  } catch {
    ledgerBytes = null;
  }
  return {
    enabled: isCaptureEnabled(env),
    disabledByEnv: disabledByEnv(env),
    signal: captureSignalPath(),
    ledger: captureLedgerPath(),
    ledgerBytes,
    session: resolveRuntimeSession(env),
  };
}

export function enableCapture(now: Date = new Date()): void {
  mkdirSync(metricsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(captureSignalPath(), `${JSON.stringify({ enabledAt: now.toISOString(), genie: VERSION })}\n`, {
    mode: 0o600,
  });
}

/** Removes only the switch. The ledger stays: deleting measurements is the operator's call. */
export function disableCapture(): boolean {
  try {
    statSync(captureSignalPath());
  } catch {
    return false;
  }
  // recursive: a directory planted where the switch belongs is removed too, never an EISDIR crash.
  rmSync(captureSignalPath(), { force: true, recursive: true });
  return true;
}
