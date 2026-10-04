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
import { join } from 'node:path';
import { resolveGenieHome } from './genie-home.js';
import { VERSION } from './version.js';

/** Bumped on any change to the shape of an `events.jsonl` line. */
export const CAPTURE_SCHEMA_VERSION = 1;

/** `GENIE_METRICS=off` disables capture for one process even when enabled. Env may only disable. */
const DISABLE_ENV = 'GENIE_METRICS';

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
  if (env[DISABLE_ENV] === 'off') return false;
  try {
    return statSync(captureSignalPath()).isFile();
  } catch {
    return false;
  }
}

export type SessionSource = 'claude-code' | 'codex' | 'pi';

export interface RuntimeSession {
  /** The runtime's own session id, as its session log names it; null when no runtime marker is present. */
  id: string | null;
  source: SessionSource | null;
  /** The session log path when the runtime exports it (pi/OMP `PI_SESSION_FILE`). */
  file: string | null;
}

/**
 * Read the runtime session id the runtime itself exports to its tool shells.
 * Verified 2026-10-04: Claude Code `CLAUDE_CODE_SESSION_ID`; Codex
 * `CODEX_THREAD_ID` (equal to the rollout's `session_meta.session_id`); pi/OMP
 * `PI_SESSION_ID` plus `PI_SESSION_FILE`. No marker → all null, never a guess.
 */
export function resolveRuntimeSession(env: NodeJS.ProcessEnv = process.env): RuntimeSession {
  if (env.CLAUDE_CODE_SESSION_ID) return { id: env.CLAUDE_CODE_SESSION_ID, source: 'claude-code', file: null };
  if (env.CODEX_THREAD_ID) return { id: env.CODEX_THREAD_ID, source: 'codex', file: null };
  if (env.PI_SESSION_ID || env.PI_SESSION_FILE) {
    return { id: env.PI_SESSION_ID || null, source: 'pi', file: env.PI_SESSION_FILE || null };
  }
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
  genie: string;
  pid: number;
}

export function buildCaptureLine(input: LifecycleEventInput, env: NodeJS.ProcessEnv = process.env): CaptureLine {
  return {
    v: CAPTURE_SCHEMA_VERSION,
    source: 'task_event',
    db: input.db,
    task: input.taskId,
    event: input.eventId,
    kind: input.kind,
    authorKind: input.authorKind,
    at: input.createdAt,
    session: resolveRuntimeSession(env),
    genie: VERSION,
    pid: process.pid,
  };
}

/**
 * Append one line for a just-written card event, when capture is enabled.
 * One O_APPEND write of one line: concurrent writers from many worktrees never
 * tear it (measured: 16 × 5,000 appends, 0 torn, at ~200 B and ~3.8 KB). A line
 * whose transaction later rolls back has no `task_events` row to join and is
 * reported unmatched by the export, never invented.
 */
export function recordLifecycleEvent(input: LifecycleEventInput, env: NodeJS.ProcessEnv = process.env): void {
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
    disabledByEnv: env[DISABLE_ENV] === 'off',
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
  rmSync(captureSignalPath(), { force: true });
  return true;
}
