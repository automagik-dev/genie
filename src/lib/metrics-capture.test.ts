import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPTURE_SCHEMA_VERSION,
  captureLedgerPath,
  captureSignalPath,
  captureStatus,
  disableCapture,
  enableCapture,
  isCaptureEnabled,
  metricsDir,
  recordLifecycleEvent,
  resolveRuntimeSession,
} from './metrics-capture.js';

const EVENT = { db: '/repo/.genie/genie.db', taskId: 't-1', eventId: 7, kind: 'move', authorKind: 'pi', createdAt: 1 };
const NO_RUNTIME: NodeJS.ProcessEnv = {};

let home: string;
let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.GENIE_HOME;
  home = mkdtempSync(join(tmpdir(), 'genie-metrics-'));
  process.env.GENIE_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
  else process.env.GENIE_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('off by default', () => {
  test('a fresh GENIE_HOME records nothing and creates nothing', () => {
    expect(isCaptureEnabled(NO_RUNTIME)).toBe(false);
    recordLifecycleEvent(EVENT, NO_RUNTIME);
    expect(existsSync(metricsDir())).toBe(false);
  });

  test('GENIE_METRICS=off disables an enabled host; the env can never enable', () => {
    enableCapture();
    expect(isCaptureEnabled({ GENIE_METRICS: 'off' })).toBe(false);
    recordLifecycleEvent(EVENT, { GENIE_METRICS: 'off' });
    expect(existsSync(captureLedgerPath())).toBe(false);
    for (const value of ['OFF', '0', 'false', ' No ']) expect(isCaptureEnabled({ GENIE_METRICS: value })).toBe(false);
    expect(isCaptureEnabled({ GENIE_METRICS: 'on' })).toBe(true);
    disableCapture();
    expect(isCaptureEnabled({ GENIE_METRICS: 'on' })).toBe(false);
  });

  test('a directory where the switch should be is not a switch, and disable removes it', () => {
    mkdirSync(captureSignalPath(), { recursive: true });
    expect(isCaptureEnabled(NO_RUNTIME)).toBe(false);
    expect(disableCapture()).toBe(true);
    expect(existsSync(captureSignalPath())).toBe(false);
  });
});

describe('enabled', () => {
  test('appends one schema-versioned line with the runtime session, dir 0700 and file 0600', () => {
    enableCapture();
    recordLifecycleEvent(EVENT, { CLAUDE_CODE_SESSION_ID: 'sess-1' });
    recordLifecycleEvent({ ...EVENT, eventId: 8 }, { CLAUDE_CODE_SESSION_ID: 'sess-1' });
    const lines = readFileSync(captureLedgerPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const row = JSON.parse(lines[0] as string);
    expect(row).toMatchObject({
      v: CAPTURE_SCHEMA_VERSION,
      source: 'task_event',
      db: EVENT.db,
      task: 't-1',
      event: 7,
      kind: 'move',
      authorKind: 'pi',
      at: 1,
      session: { id: 'sess-1', source: 'claude-code', file: null },
    });
    expect(typeof row.genie).toBe('string');
    expect(statSync(metricsDir()).mode & 0o777).toBe(0o700);
    expect(statSync(captureLedgerPath()).mode & 0o777).toBe(0o600);
  });

  test('only an OMP line with no session id carries its cwd (the export’s window join key)', () => {
    enableCapture();
    recordLifecycleEvent(EVENT, { OMPCODE: '1', CLAUDECODE: '1' });
    recordLifecycleEvent({ ...EVENT, eventId: 8 }, { CLAUDE_CODE_SESSION_ID: 'c' });
    const [omp, claude] = readFileSync(captureLedgerPath(), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(omp.cwd).toBe(process.cwd());
    expect(omp.session).toEqual({ id: null, source: 'pi', file: null });
    expect(claude.cwd).toBeUndefined();
  });

  test('a failing ledger never throws into the command', () => {
    enableCapture();
    mkdirSync(captureLedgerPath()); // a directory where the ledger file should be
    expect(() => recordLifecycleEvent(EVENT, NO_RUNTIME)).not.toThrow();
  });

  test('disable removes only the switch and keeps the ledger', () => {
    enableCapture();
    recordLifecycleEvent(EVENT, NO_RUNTIME);
    expect(disableCapture()).toBe(true);
    expect(disableCapture()).toBe(false);
    expect(existsSync(captureLedgerPath())).toBe(true);
    expect(isCaptureEnabled(NO_RUNTIME)).toBe(false);
  });

  test('status reports the switch, ledger size and session', () => {
    expect(captureStatus(NO_RUNTIME)).toMatchObject({ enabled: false, ledgerBytes: null });
    enableCapture();
    writeFileSync(captureLedgerPath(), 'x\n');
    expect(captureStatus({ CODEX_THREAD_ID: 'thr' })).toMatchObject({
      enabled: true,
      ledgerBytes: 2,
      session: { id: 'thr', source: 'codex' },
    });
  });
});

describe('resolveRuntimeSession', () => {
  test('reads each runtime marker and never guesses', () => {
    expect(resolveRuntimeSession({ CLAUDE_CODE_SESSION_ID: 'a' })).toEqual({
      id: 'a',
      source: 'claude-code',
      file: null,
    });
    expect(resolveRuntimeSession({ CODEX_THREAD_ID: 'b' })).toEqual({ id: 'b', source: 'codex', file: null });
    expect(resolveRuntimeSession({ PI_SESSION_ID: 'c', PI_SESSION_FILE: '/s/c.jsonl' })).toEqual({
      id: 'c',
      source: 'pi',
      file: '/s/c.jsonl',
    });
    expect(resolveRuntimeSession({ PI_SESSION_FILE: '/s/d.jsonl' })).toEqual({
      id: null,
      source: 'pi',
      file: '/s/d.jsonl',
    });
    expect(resolveRuntimeSession(NO_RUNTIME)).toEqual({ id: null, source: null, file: null });
    // OMP 18.6.1 sets OMPCODE=1 AND CLAUDECODE=1 and exports no session id; a leaked outer Claude
    // session id must not be taken for it.
    expect(resolveRuntimeSession({ OMPCODE: '1', CLAUDECODE: '1' })).toEqual({ id: null, source: 'pi', file: null });
    expect(resolveRuntimeSession({ OMPCODE: '1', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outer-claude' })).toEqual({
      id: null,
      source: 'pi',
      file: null,
      ambiguous: true,
    });
    // Two runtimes' session markers (a nested shell): which is inner is unknowable, so no id is kept.
    expect(resolveRuntimeSession({ CLAUDE_CODE_SESSION_ID: 'outer', CODEX_THREAD_ID: 'thr' })).toEqual({
      id: null,
      source: 'codex',
      file: null,
      ambiguous: true,
    });
    expect(resolveRuntimeSession({ OMPCODE: '1', CODEX_THREAD_ID: 'thr' })).toMatchObject({
      id: null,
      ambiguous: true,
    });
    // OMP exports no PI_SESSION_*: inherited outer pi ids in an OMP shell are never taken for it.
    expect(
      resolveRuntimeSession({ OMPCODE: '1', PI_SESSION_ID: 'outer-pi', PI_SESSION_FILE: '/s/outer.jsonl' }),
    ).toEqual({ id: null, source: 'pi', file: null, ambiguous: true });
    // Codex with inherited pi ids: source follows the author order (codex), and no id is kept.
    expect(resolveRuntimeSession({ CODEX_THREAD_ID: 'thr', PI_SESSION_ID: 'p' })).toMatchObject({
      source: 'codex',
      id: null,
      ambiguous: true,
    });
  });
});
