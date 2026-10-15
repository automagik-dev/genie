/**
 * Genie Bench — durable attempt journal and campaign registration.
 *
 * Layout under the operator-named `--root` (no default location exists):
 *
 *   <root>/supervisor.lock                              O_EXCL lock: holder pid + start time
 *   <root>/campaigns/<experimentId>/schedule.jsonl      one AttemptIdentity per line, the denominator
 *   <root>/attempts/<attemptId>/journal.jsonl           line 1 the identity header, then one JournalEntry per line
 *
 * Directories are created 0700 and files 0600. A journal is created only by
 * registration, so a transition for an unregistered attempt is a refusal. Every
 * accepted transition is ONE newline-terminated line appended and fsync'd before
 * the call returns. Reads never write: a torn trailing line or a corrupt middle
 * line is reported in `corrupt[]` with its raw text, and the state is derived
 * from the good entries only. Recovery appends; it never rewrites a journal,
 * never touches the schedule, and never relaunches a scored solver.
 *
 * No genie.db, no daemon, no environment value is ever written into a record.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ATTEMPT_TRANSITIONS,
  type AttemptIdentity,
  type AttemptState,
  BENCH_SCHEMA_VERSION,
  type Disposition,
  type EvidenceRef,
  type Result,
} from './contracts';

export interface JournalEntry {
  seq: number;
  at: string;
  monotonicNs: string;
  state: AttemptState;
  disposition?: Disposition;
  evidence: EvidenceRef[];
  note?: string;
}

export interface JournalRead {
  identity: AttemptIdentity;
  entries: JournalEntry[];
  state: AttemptState;
  /** One row per line that is not a good entry; `raw` is the line's text exactly as stored. */
  corrupt: Array<{ line: number; reason: string; raw: string }>;
}

export type RecoveryAction = 'none' | 'record-interrupted' | 'verify-collected-artifact' | 'seal-capture';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** The state set is the transition map's key set — never a second list. */
const STATES = Object.keys(ATTEMPT_TRANSITIONS) as AttemptState[];

const DISPOSITIONS = [
  'accepted',
  'rejected',
  'timeout',
  'setup-failure',
  'provider-failure',
  'infra-failure',
  'interrupted',
  'abandoned',
] as const satisfies readonly Disposition[];
// Compile-time exhaustiveness: a Disposition added in contracts.ts without a row here fails typecheck.
const _dispositionsExhaustive: [Disposition] extends [(typeof DISPOSITIONS)[number]] ? true : never = true;
void _dispositionsExhaustive;

/** Canonical key order of a stored identity, so identical content is byte-identical on disk. */
const IDENTITY_KEYS = [
  'experimentId',
  'pairId',
  'manifestId',
  'taskKey',
  'configId',
  'arm',
  'repeat',
  'attemptId',
  'scheduledIndex',
  'kind',
] as const satisfies readonly (keyof AttemptIdentity)[];

const ENTRY_KEYS = new Set(['seq', 'at', 'monotonicNs', 'state', 'disposition', 'evidence', 'note']);
const EVIDENCE_KEYS = new Set(['kind', 'path', 'sha256', 'bytes']);
const HEADER_KEYS = new Set(['schemaVersion', 'identity']);

/** A path segment that cannot climb or hide: no separator, no leading dot. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const refuse = <T>(...issues: string[]): Result<T> => ({ ok: false, issues });

const lockPath = (root: string): string => join(root, 'supervisor.lock');
const campaignDir = (root: string, experimentId: string): string => join(root, 'campaigns', experimentId);
const schedulePath = (root: string, experimentId: string): string =>
  join(campaignDir(root, experimentId), 'schedule.jsonl');
const attemptDir = (root: string, attemptId: string): string => join(root, 'attempts', attemptId);
const journalPath = (root: string, attemptId: string): string => join(attemptDir(root, attemptId), 'journal.jsonl');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/** Make a directory entry durable: fsync the directory itself (works on Linux and macOS). */
function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Create `path` exclusively ('wx'), write `text`, fsync, close. Throws EEXIST when the path exists. */
function writeExclusive(path: string, text: string): void {
  const fd = openSync(path, 'wx', FILE_MODE);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function errorCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === 'string' ? err.code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function identityIssues(raw: unknown, where: string): string[] {
  if (!isRecord(raw)) return [`${where}: identity is not an object`];
  const issues: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!(IDENTITY_KEYS as readonly string[]).includes(key)) issues.push(`${where}: unknown identity key '${key}'`);
  }
  for (const key of ['experimentId', 'pairId', 'manifestId', 'taskKey', 'configId', 'arm', 'attemptId'] as const) {
    if (!isNonEmptyString(raw[key])) issues.push(`${where}: '${key}' must be a non-empty string`);
  }
  for (const key of ['repeat', 'scheduledIndex'] as const) {
    if (!isIndex(raw[key])) issues.push(`${where}: '${key}' must be a non-negative integer`);
  }
  if (raw.kind !== 'smoke' && raw.kind !== 'scored') issues.push(`${where}: 'kind' must be 'smoke' or 'scored'`);
  if (isNonEmptyString(raw.experimentId) && !SAFE_SEGMENT.test(raw.experimentId)) {
    issues.push(`${where}: experimentId '${raw.experimentId}' is not a safe path segment`);
  }
  if (isNonEmptyString(raw.attemptId) && !SAFE_SEGMENT.test(raw.attemptId)) {
    issues.push(`${where}: attemptId '${raw.attemptId}' is not a safe path segment`);
  }
  return issues;
}

/** Re-key an identity in canonical order so equal content serializes to equal bytes. */
function canonicalIdentity(identity: AttemptIdentity): AttemptIdentity {
  const out: Record<string, unknown> = {};
  for (const key of IDENTITY_KEYS) out[key] = identity[key];
  return out as unknown as AttemptIdentity;
}

const headerLine = (identity: AttemptIdentity): string =>
  `${JSON.stringify({ schemaVersion: BENCH_SCHEMA_VERSION, identity: canonicalIdentity(identity) })}\n`;

const scheduleText = (schedule: AttemptIdentity[]): string =>
  schedule.map((identity) => `${JSON.stringify(canonicalIdentity(identity))}\n`).join('');

// ---------------------------------------------------------------------------
// Supervisor lock
// ---------------------------------------------------------------------------

interface LockRecord {
  pid: number;
  startedAt: string;
}

function describeHolder(path: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return `refused: supervisor lock ${path} already exists but its holder is unreadable (${errorText(err)}); it was left untouched`;
  }
  if (!isRecord(parsed) || !isIndex(parsed.pid)) {
    return `refused: supervisor lock ${path} already exists but names no holder pid; it was left untouched`;
  }
  const pid = parsed.pid;
  const started = typeof parsed.startedAt === 'string' ? parsed.startedAt : 'unknown';
  let live = true;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM: the process exists under another user. ESRCH: no such process.
    live = errorCode(err) !== 'ESRCH';
  }
  const status = live
    ? 'the holder is live'
    : 'the lock is STALE (no process has that pid); confirm no supervisor runs, then remove the lock by hand';
  return `refused: supervisor lock ${path} is held by pid ${pid} (started ${started}); ${status}. It was not stolen`;
}

export function acquireSupervisor(root: string): Result<{ release(): void }> {
  if (!isNonEmptyString(root)) return refuse('refused: a --root directory is required');
  const path = lockPath(root);
  const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() };
  const text = `${JSON.stringify(record)}\n`;
  try {
    ensureDir(root);
    writeExclusive(path, text);
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return refuse(describeHolder(path));
    return refuse(`refused: could not create supervisor lock ${path}: ${errorText(err)}`);
  }
  let released = false;
  return {
    ok: true,
    value: {
      release(): void {
        if (released) return;
        released = true;
        // Remove the lock only while it is still the one this call wrote.
        if (existsSync(path) && readFileSync(path, 'utf8') === text) unlinkSync(path);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Journal read
// ---------------------------------------------------------------------------

function evidenceIssue(raw: unknown): string | null {
  if (!Array.isArray(raw)) return "'evidence' must be an array";
  for (const ref of raw) {
    if (!isRecord(ref)) return 'an evidence ref is not an object';
    const unknownKey = Object.keys(ref).find((k) => !EVIDENCE_KEYS.has(k));
    if (unknownKey) return `unknown evidence key '${unknownKey}'`;
    if (!isNonEmptyString(ref.kind) || !isNonEmptyString(ref.path) || typeof ref.sha256 !== 'string') {
      return 'an evidence ref needs string kind, path and sha256';
    }
    if (!isIndex(ref.bytes)) return 'an evidence ref needs a non-negative integer bytes';
  }
  return null;
}

/** The structural check one entry must pass, on the read path and before an append. */
function entryIssue(raw: unknown): string | null {
  if (!isRecord(raw)) return 'entry is not an object';
  const unknownKey = Object.keys(raw).find((k) => !ENTRY_KEYS.has(k));
  if (unknownKey) return `unknown entry key '${unknownKey}'`;
  if (!isIndex(raw.seq) || raw.seq < 1) return "'seq' must be a positive integer";
  if (!isNonEmptyString(raw.at)) return "'at' must be a non-empty string";
  if (typeof raw.monotonicNs !== 'string' || !/^[0-9]+$/.test(raw.monotonicNs)) {
    return "'monotonicNs' must be a decimal string";
  }
  if (!STATES.includes(raw.state as AttemptState)) return `unknown state '${String(raw.state)}'`;
  if (raw.disposition !== undefined && !(DISPOSITIONS as readonly unknown[]).includes(raw.disposition)) {
    return `unknown disposition '${String(raw.disposition)}'`;
  }
  if (raw.note !== undefined && typeof raw.note !== 'string') return "'note' must be a string";
  return evidenceIssue(raw.evidence);
}

interface LoadedJournal {
  read: JournalRead;
  endsWithNewline: boolean;
  lastSeq: number;
}

function parseHeader(text: string, attemptId: string, path: string): Result<AttemptIdentity> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse(`journal ${path}: the identity header (line 1) is not valid JSON`);
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== BENCH_SCHEMA_VERSION) {
    return refuse(
      `journal ${path}: the identity header (line 1) is not a schemaVersion ${BENCH_SCHEMA_VERSION} header`,
    );
  }
  const unknownKey = Object.keys(parsed).find((k) => !HEADER_KEYS.has(k));
  if (unknownKey) return refuse(`journal ${path}: unknown header key '${unknownKey}'`);
  const issues = identityIssues(parsed.identity, `journal ${path}`);
  if (issues.length > 0) return { ok: false, issues };
  const identity = parsed.identity as AttemptIdentity;
  if (identity.attemptId !== attemptId) {
    return refuse(
      `refused: identity mismatch — journal ${path} holds attempt '${identity.attemptId}', not '${attemptId}'`,
    );
  }
  return { ok: true, value: identity };
}

function loadJournal(root: string, attemptId: string): Result<LoadedJournal> {
  if (!isNonEmptyString(root)) return refuse('refused: a --root directory is required');
  if (!SAFE_SEGMENT.test(attemptId)) return refuse(`refused: attemptId '${attemptId}' is not a safe path segment`);
  const path = journalPath(root, attemptId);
  if (!existsSync(path)) {
    return refuse(
      `refused: attempt '${attemptId}' is not registered (no journal at ${path}); register the campaign first`,
    );
  }
  const text = readFileSync(path, 'utf8');
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  // A newline-terminated file splits into a trailing empty string; anything else there is a torn line.
  const tail = lines.pop() ?? '';
  if (lines.length === 0) return refuse(`journal ${path}: the identity header (line 1) is torn or missing`);
  const header = parseHeader(lines[0], attemptId, path);
  if (!header.ok) return header;

  const entries: JournalEntry[] = [];
  const corrupt: JournalRead['corrupt'] = [];
  let state: AttemptState = 'registered';
  let lastSeq = 0;
  const consider = (raw: string, lineNo: number): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      corrupt.push({ line: lineNo, reason: 'not valid JSON', raw });
      return;
    }
    const issue = entryIssue(parsed);
    if (issue) {
      corrupt.push({ line: lineNo, reason: issue, raw });
      return;
    }
    const entry = parsed as JournalEntry;
    if (entry.seq <= lastSeq) {
      corrupt.push({ line: lineNo, reason: `seq ${entry.seq} does not follow seq ${lastSeq}`, raw });
      return;
    }
    if (!ATTEMPT_TRANSITIONS[state].includes(entry.state)) {
      corrupt.push({ line: lineNo, reason: `illegal transition ${state} -> ${entry.state}`, raw });
      return;
    }
    entries.push(entry);
    state = entry.state;
    lastSeq = entry.seq;
  };
  for (let i = 1; i < lines.length; i++) consider(lines[i], i + 1);
  if (tail.length > 0) {
    corrupt.push({ line: lines.length + 1, reason: 'torn trailing line (no newline terminator)', raw: tail });
  }
  return {
    ok: true,
    value: { read: { identity: header.value, entries, state, corrupt }, endsWithNewline, lastSeq },
  };
}

export function readJournal(root: string, attemptId: string): Result<JournalRead> {
  const loaded = loadJournal(root, attemptId);
  return loaded.ok ? { ok: true, value: loaded.value.read } : loaded;
}

// ---------------------------------------------------------------------------
// Journal append
// ---------------------------------------------------------------------------

export function appendTransition(
  root: string,
  attemptId: string,
  to: AttemptState,
  data: Omit<JournalEntry, 'seq' | 'state'>,
): Result<JournalEntry> {
  const loaded = loadJournal(root, attemptId);
  if (!loaded.ok) return loaded;
  const { read, endsWithNewline, lastSeq } = loaded.value;
  if (!ATTEMPT_TRANSITIONS[read.state].includes(to)) {
    return refuse(`refused: illegal transition ${read.state} -> ${to} for attempt '${attemptId}'`);
  }
  // Only the declared fields are copied, in a fixed order, so nothing else a caller carries reaches the journal.
  const entry: JournalEntry = {
    seq: lastSeq + 1,
    at: data.at,
    monotonicNs: data.monotonicNs,
    state: to,
    ...(data.disposition !== undefined ? { disposition: data.disposition } : {}),
    evidence: data.evidence,
    ...(data.note !== undefined ? { note: data.note } : {}),
  };
  const issue = entryIssue(entry);
  if (issue) return refuse(`refused: invalid transition data for attempt '${attemptId}': ${issue}`);

  // A torn trailing line stays in place as its own (corrupt) line; the new entry starts on a fresh one.
  const line = `${endsWithNewline ? '' : '\n'}${JSON.stringify(entry)}\n`;
  const fd = openSync(journalPath(root, attemptId), 'a', FILE_MODE);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { ok: true, value: entry };
}

// ---------------------------------------------------------------------------
// Campaign registration and status
// ---------------------------------------------------------------------------

function readSchedule(path: string): Result<AttemptIdentity[]> {
  const text = readFileSync(path, 'utf8');
  if (!text.endsWith('\n')) return refuse(`schedule ${path} is torn (no trailing newline); it was left untouched`);
  const identities: AttemptIdentity[] = [];
  const issues: string[] = [];
  const lines = text.slice(0, -1).split('\n');
  lines.forEach((raw, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      issues.push(`schedule ${path} line ${i + 1}: not valid JSON`);
      return;
    }
    const lineIssues = identityIssues(parsed, `schedule ${path} line ${i + 1}`);
    if (lineIssues.length > 0) issues.push(...lineIssues);
    else identities.push(parsed as AttemptIdentity);
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: identities };
}

function scheduleIssues(schedule: AttemptIdentity[]): string[] {
  if (!Array.isArray(schedule) || schedule.length === 0) return ['refused: the schedule holds no attempt identity'];
  const issues = schedule.flatMap((identity, i) => identityIssues(identity, `schedule row ${i}`));
  if (issues.length > 0) return issues;
  const experimentId = schedule[0].experimentId;
  const seen = new Set<string>();
  schedule.forEach((identity, i) => {
    if (identity.experimentId !== experimentId) {
      issues.push(`schedule row ${i}: experimentId '${identity.experimentId}' differs from '${experimentId}'`);
    }
    if (seen.has(identity.attemptId)) issues.push(`schedule row ${i}: duplicate attemptId '${identity.attemptId}'`);
    seen.add(identity.attemptId);
  });
  return issues;
}

/** An existing journal must carry exactly this identity; a missing one is created later. */
function existingJournalIssue(root: string, identity: AttemptIdentity): string | null {
  const path = journalPath(root, identity.attemptId);
  if (!existsSync(path)) return null;
  const firstLine = readFileSync(path, 'utf8').split('\n')[0] ?? '';
  if (`${firstLine}\n` === headerLine(identity)) return null;
  return `refused: identity mismatch — journal ${path} already holds a different identity for '${identity.attemptId}'; it was not overwritten`;
}

export function registerCampaign(root: string, schedule: AttemptIdentity[]): Result<{ registered: number }> {
  if (!isNonEmptyString(root)) return refuse('refused: a --root directory is required');
  const issues = scheduleIssues(schedule);
  if (issues.length > 0) return { ok: false, issues };
  const experimentId = schedule[0].experimentId;
  const path = schedulePath(root, experimentId);
  const text = scheduleText(schedule);

  if (existsSync(path) && readFileSync(path, 'utf8') !== text) {
    return refuse(
      `refused: campaign '${experimentId}' is already registered at ${path} with different content; it was not overwritten`,
    );
  }
  const journalIssues = schedule.map((identity) => existingJournalIssue(root, identity)).filter((i) => i !== null);
  if (journalIssues.length > 0) return { ok: false, issues: journalIssues };

  try {
    ensureDir(join(root, 'campaigns'));
    ensureDir(join(root, 'attempts'));
    if (!existsSync(path)) {
      const dir = campaignDir(root, experimentId);
      ensureDir(dir);
      // Written whole to a private name, then linked into place: link never clobbers, so the
      // schedule appears complete or not at all.
      const tmp = join(dir, `.schedule.jsonl.${process.pid}.tmp`);
      writeExclusive(tmp, text);
      try {
        linkSync(tmp, path);
      } finally {
        unlinkSync(tmp);
      }
      fsyncDir(dir);
    }
    for (const identity of schedule) {
      const journal = journalPath(root, identity.attemptId);
      if (existsSync(journal)) continue; // proven identical above
      const dir = attemptDir(root, identity.attemptId);
      ensureDir(dir);
      writeExclusive(journal, headerLine(identity));
      fsyncDir(dir);
    }
    fsyncDir(join(root, 'attempts'));
  } catch (err) {
    return refuse(`refused: registration of campaign '${experimentId}' failed: ${errorText(err)}`);
  }
  return { ok: true, value: { registered: schedule.length } };
}

export function planRecovery(read: JournalRead): RecoveryAction {
  switch (read.state) {
    case 'running':
      // The solver's fate is unknown: record terminal-failure/interrupted, never relaunch it.
      return 'record-interrupted';
    case 'execution-stopped':
      return 'verify-collected-artifact';
    case 'verified':
    case 'terminal-failure':
      return 'seal-capture';
    default:
      return 'none';
  }
}

export function campaignStatus(
  root: string,
  experimentId: string,
): Result<{
  scheduled: number;
  byState: Record<AttemptState, number>;
  byDisposition: Record<Disposition | 'none', number>;
}> {
  if (!isNonEmptyString(root)) return refuse('refused: a --root directory is required');
  if (!SAFE_SEGMENT.test(experimentId))
    return refuse(`refused: experimentId '${experimentId}' is not a safe path segment`);
  const path = schedulePath(root, experimentId);
  if (!existsSync(path)) return refuse(`refused: campaign '${experimentId}' is not registered (no ${path})`);
  const schedule = readSchedule(path);
  if (!schedule.ok) return schedule;

  const byState = Object.fromEntries(STATES.map((s) => [s, 0])) as Record<AttemptState, number>;
  const byDisposition = Object.fromEntries([...DISPOSITIONS, 'none'].map((d) => [d, 0])) as Record<
    Disposition | 'none',
    number
  >;
  const issues: string[] = [];
  for (const identity of schedule.value) {
    const read = readJournal(root, identity.attemptId);
    if (!read.ok) {
      issues.push(...read.issues);
      continue;
    }
    byState[read.value.state] += 1;
    let disposition: Disposition | 'none' = 'none';
    for (const entry of read.value.entries) if (entry.disposition !== undefined) disposition = entry.disposition;
    byDisposition[disposition] += 1;
  }
  if (issues.length > 0) return { ok: false, issues };
  // The denominator is the schedule's line count alone; no journal state can move it.
  return { ok: true, value: { scheduled: schedule.value.length, byState, byDisposition } };
}
