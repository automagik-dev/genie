/**
 * Genie Bench — bounded native OMP capture.
 *
 * Reads one attempt's isolated OMP home, and nothing else: every path is built from the
 * `nativeHome` argument under `.omp/agent/sessions`. No environment variable, user home or
 * network is consulted. Session logs are untrusted input: a symlink is never followed, a
 * line that does not parse is counted and skipped, and the total bytes read are capped.
 *
 * Native layout: `sessions/<cwd-slug>/<session>.jsonl` is a top-level session; the sibling
 * folder `<session>/` holds the logs of the actors that session started (workers and
 * auxiliary calls). Each log opens with a `{type:'session', id, cwd, timestamp}` header and
 * continues with `{type:'message', id, parentId, timestamp, message}` entries.
 *
 * Unknown is null, never 0: a count the log does not carry stays null with an explicit
 * presence entry, and every emitted request passes the Group 1 contract parser.
 */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type EvidenceRef,
  type InputEvent,
  type NativeRequestRecord,
  type Presence,
  type Result,
  parseNativeRequestRecord,
} from './contracts';

export type SessionLinkage =
  | { match: 'isolated-home'; file: string }
  | { match: 'ambiguous'; candidates: string[] }
  | { match: 'none' };

export interface ActorRecord {
  actorId: string;
  parentActorId: string | null;
  role: 'lead' | 'worker' | 'auxiliary';
  sessionFile: string;
  pending: boolean;
}

export interface CaptureHealth {
  /** Lines that are not a JSON object, message entries without a message, and records the contract refused. */
  malformed: number;
  /** Exact repeats of an already-seen entry (same identity, revision and payload). */
  duplicate: number;
  /** Same identity and revision with a different payload; the first one seen is kept. */
  conflicting: number;
  /** Logs that could not be attributed to a session (an orphan actor folder) or could not be opened. */
  unmatched: number;
  /** Model requests whose entry carries no usage block. */
  missing: number;
  truncated: boolean;
  bytesRead: number;
}

export interface CaptureBundle {
  linkage: SessionLinkage;
  actors: ActorRecord[];
  requests: NativeRequestRecord[];
  inputs: InputEvent[];
  health: CaptureHealth;
  evidence: EvidenceRef[];
}

type Rec = Record<string, unknown>;
type TokenField = keyof NativeRequestRecord['tokens'];

const TOKEN_FIELDS: readonly TokenField[] = [
  'input',
  'cacheRead',
  'cacheWriteTotal',
  'cacheWrite5m',
  'cacheWrite1h',
  'output',
  'reasoning',
];

/**
 * The OMP usage key behind each contract token field. OMP logs one undivided `cacheWrite`
 * count, so it is the total; the 5-minute / 1-hour split does not exist in the source (null).
 */
const OMP_USAGE_KEY: Readonly<Record<TokenField, string | null>> = {
  input: 'input',
  cacheRead: 'cacheRead',
  cacheWriteTotal: 'cacheWrite',
  cacheWrite5m: null,
  cacheWrite1h: null,
  output: 'output',
  reasoning: 'reasoning',
};

/** A stop reason that ends a request without a usable answer. */
const FAILED_STOP_REASONS = new Set(['error', 'aborted']);

/** Nested actor folders deeper than this are not walked (a hostile tree cannot make the walk unbounded). */
const MAX_NESTING = 8;

interface SessionFile {
  path: string;
  /** The session file whose sibling folder holds this log; null for a top-level session. */
  owner: string | null;
}

/** One `message` entry, kept until deduplication across the whole capture is settled. */
interface MessageEntry {
  actor: ActorRecord;
  nativeSessionHeaderId: string | null;
  entryId: string | null;
  parentId: string | null;
  revision: string;
  timestamp: string | null;
  message: Rec;
  /** The whole entry as parsed, to tell an exact repeat from a conflicting one. */
  canonical: string;
  requestedModel: string | null;
  effort: string | null;
  evidence: EvidenceRef;
}

function obj(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

type Listed = { name: string; kind: 'file' | 'dir' | 'other' };

/** Directory entries by name; a symlink or special file is `other` and never followed. */
function list(dir: string): Listed[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((d): Listed => ({ name: d.name, kind: d.isFile() ? 'file' : d.isDirectory() ? 'dir' : 'other' }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

const isLog = (e: Listed): boolean => e.kind === 'file' && e.name.endsWith('.jsonl');

/** Every log under a session's sibling folder, each attributed to the session file whose folder holds it. */
function collectNested(dir: string, owner: string, depth: number, out: SessionFile[]): number {
  if (depth > MAX_NESTING) return 0;
  const entries = list(dir);
  const logs = new Set(entries.filter(isLog).map((e) => e.name));
  let unmatched = 0;
  for (const e of entries) if (isLog(e)) out.push({ path: join(dir, e.name), owner });
  for (const e of entries) {
    if (e.kind !== 'dir') continue;
    const sub = join(dir, e.name);
    if (logs.has(`${e.name}.jsonl`)) unmatched += collectNested(sub, join(dir, `${e.name}.jsonl`), depth + 1, out);
    else unmatched += list(sub).filter(isLog).length;
  }
  return unmatched;
}

/**
 * The sessions tree in read order: each top-level session, then its actors. Top-level logs sit
 * directly in `sessions/` or one `<cwd-slug>/` level below it.
 */
function listSessions(root: string): { leads: string[]; files: SessionFile[]; unmatched: number } {
  const leads: string[] = [];
  const files: SessionFile[] = [];
  let unmatched = 0;
  const scan = (dir: string, depth: number): void => {
    const entries = list(dir);
    const logs = new Set(entries.filter(isLog).map((e) => e.name));
    const dirs = new Set(entries.filter((e) => e.kind === 'dir').map((e) => e.name));
    for (const e of entries) {
      if (!isLog(e)) continue;
      const path = join(dir, e.name);
      const stem = e.name.slice(0, -'.jsonl'.length);
      leads.push(path);
      files.push({ path, owner: null });
      if (dirs.has(stem)) unmatched += collectNested(join(dir, stem), path, 1, files);
    }
    for (const e of entries) {
      if (e.kind !== 'dir' || logs.has(`${e.name}.jsonl`)) continue;
      if (depth === 0) scan(join(dir, e.name), 1);
      else unmatched += list(join(dir, e.name)).filter(isLog).length;
    }
  };
  scan(root, 0);
  return { leads, files, unmatched };
}

/** Reads at most `budget` bytes of a regular file without following a symlink; null when it cannot be opened. */
function readBounded(path: string, budget: number): { bytes: Buffer; truncated: boolean } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const want = Math.min(stat.size, budget);
    const buffer = Buffer.alloc(want);
    let offset = 0;
    while (offset < want) {
      const n = readSync(fd, buffer, offset, want - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return { bytes: buffer.subarray(0, offset), truncated: want < stat.size };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The sessions root under `nativeHome`, refusing any symlinked component; null when it does not exist. */
function sessionsRoot(home: string): Result<string | null> {
  let dir = home;
  for (const part of ['.omp', 'agent', 'sessions']) {
    dir = join(dir, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(dir);
    } catch {
      return { ok: true, value: null };
    }
    if (!stat.isDirectory())
      return { ok: false, issues: [`${relative(home, dir)}: not a directory (symlinks refused)`] };
  }
  return { ok: true, value: dir };
}

/** Whether `next` is a later revision than `prev`: by timestamp when both parse, else by file order. */
function isLater(next: string, prev: string): boolean {
  const a = Date.parse(next);
  const b = Date.parse(prev);
  return Number.isFinite(a) && Number.isFinite(b) ? a > b : true;
}

function buildTokens(usage: Rec | null): { tokens: NativeRequestRecord['tokens']; presence: Record<string, Presence> } {
  const tokens = {} as NativeRequestRecord['tokens'];
  const presence: Record<string, Presence> = {};
  for (const field of TOKEN_FIELDS) {
    const key = OMP_USAGE_KEY[field];
    const value = usage && key !== null ? usage[key] : undefined;
    tokens[field] = isCount(value) ? value : null;
    presence[`tokens.${field}`] = isCount(value) ? 'observed' : usage && key === null ? 'unsupported' : 'absent';
  }
  return { tokens, presence };
}

function buildRequest(
  entry: MessageEntry,
  nativeSessionId: string | null,
  retryOf: string | null,
): { record: unknown; failed: boolean | null } {
  const { message } = entry;
  const usage = obj(message.usage);
  const { tokens, presence } = buildTokens(usage);
  const stopReason = str(message.stopReason);
  const failed = stopReason === null ? null : FAILED_STOP_REASONS.has(stopReason);
  const responseId = str(message.responseId);
  const observedModel = str(message.model);
  const has = (value: unknown): Presence => (value === null ? 'absent' : 'observed');
  presence.failed = has(failed);
  presence.responseId = has(responseId);
  presence.observedModel = has(observedModel);
  presence.requestedModel = has(entry.requestedModel);
  presence.effort = has(entry.effort);
  // OMP logs no per-request duration.
  presence.durationMs = 'unsupported';
  // OMP counts reasoning inside its output; an observed reasoning count is that subset.
  presence.reasoningIncludedInOutput = has(tokens.reasoning);
  const record: NativeRequestRecord = {
    requestId: entry.entryId,
    responseId,
    revision: entry.revision,
    actorId: entry.actor.actorId,
    parentActorId: entry.actor.parentActorId,
    role: entry.actor.role,
    nativeSessionId,
    requestedModel: entry.requestedModel,
    observedModel,
    effort: entry.effort,
    tokens,
    reasoningIncludedInOutput: tokens.reasoning === null ? null : true,
    durationMs: null,
    failed,
    retryOf,
    presence,
  };
  return { record, failed };
}

interface FileScan {
  actor: ActorRecord;
  headerId: string | null;
  entries: MessageEntry[];
  malformed: number;
}

/** Parses one log's complete lines into its actor and message entries. */
function scanLog(
  file: SessionFile,
  text: string,
  truncated: boolean,
  root: string,
  ownerActor: ActorRecord | null,
  evidence: EvidenceRef,
): FileScan {
  const lines = text.split('\n');
  // A cut-off read ends mid-line: the tail is not a record and is not counted as malformed.
  if (truncated) lines.pop();
  const actor: ActorRecord = {
    actorId: relative(root, file.path),
    parentActorId: ownerActor ? ownerActor.actorId : null,
    role: ownerActor ? 'worker' : 'lead',
    sessionFile: file.path,
    pending: false,
  };
  const scan: FileScan = { actor, headerId: null, entries: [], malformed: 0 };
  let requestedModel: string | null = null;
  let effort: string | null = null;
  let last: { role: string | null; stopReason: string | null } | null = null;
  let headerSeen = false;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let record: Rec | null = null;
    try {
      record = obj(JSON.parse(line));
    } catch {
      record = null;
    }
    const type = record ? str(record.type) : null;
    if (!record || type === null) {
      scan.malformed++;
      continue;
    }
    if (type === 'session' && !headerSeen) {
      headerSeen = true;
      scan.headerId = str(record.id);
      if (scan.headerId !== null) actor.actorId = scan.headerId;
      if (ownerActor && record.role === 'auxiliary') actor.role = 'auxiliary';
      continue;
    }
    if (type === 'model_change') requestedModel = str(record.modelId) ?? requestedModel;
    if (type === 'thinking_level_change') effort = str(record.thinkingLevel) ?? effort;
    if (type !== 'message') continue;
    const message = obj(record.message);
    if (!message || str(message.role) === null) {
      scan.malformed++;
      continue;
    }
    last = { role: str(message.role), stopReason: str(message.stopReason) };
    const timestamp = str(record.timestamp);
    scan.entries.push({
      actor,
      nativeSessionHeaderId: scan.headerId,
      entryId: str(record.id),
      parentId: str(record.parentId),
      revision: timestamp ?? 'unrevised',
      timestamp,
      message,
      canonical: JSON.stringify(record),
      requestedModel,
      effort,
      evidence,
    });
  }
  // Pending: the actor's last entry still waits on a model turn or on a tool it asked for.
  actor.pending =
    last !== null &&
    (last.role === 'user' ||
      last.role === 'toolResult' ||
      (last.role === 'assistant' && last.stopReason === 'toolUse'));
  return scan;
}

export function captureOmpAttempt(nativeHome: string, opts: { maxBytes: number }): Result<CaptureBundle> {
  if (typeof nativeHome !== 'string' || nativeHome.length === 0) {
    return { ok: false, issues: ['nativeHome: expected a non-empty path'] };
  }
  if (!Number.isInteger(opts?.maxBytes) || opts.maxBytes <= 0) {
    return { ok: false, issues: ['opts.maxBytes: expected a positive integer'] };
  }
  let home: string;
  try {
    home = realpathSync(nativeHome);
  } catch {
    return { ok: false, issues: ['nativeHome: does not exist'] };
  }
  const located = sessionsRoot(home);
  if (!located.ok) return located;
  const root = located.value;

  const health: CaptureHealth = {
    malformed: 0,
    duplicate: 0,
    conflicting: 0,
    unmatched: 0,
    missing: 0,
    truncated: false,
    bytesRead: 0,
  };
  const listing = root ? listSessions(root) : { leads: [], files: [], unmatched: 0 };
  health.unmatched += listing.unmatched;
  const linkage: SessionLinkage =
    listing.leads.length === 0
      ? { match: 'none' }
      : listing.leads.length === 1
        ? { match: 'isolated-home', file: listing.leads[0] }
        : { match: 'ambiguous', candidates: [...listing.leads] };

  const actors: ActorRecord[] = [];
  const actorByFile = new Map<string, ActorRecord>();
  const evidence: EvidenceRef[] = [];
  const slots = new Map<string, MessageEntry>();
  const order: string[] = [];
  let leadHeaderId: string | null = null;

  for (const file of listing.files) {
    const budget = opts.maxBytes - health.bytesRead;
    if (budget <= 0) {
      health.truncated = true;
      break;
    }
    const read = readBounded(file.path, budget);
    if (!read) {
      health.unmatched++;
      continue;
    }
    health.bytesRead += read.bytes.length;
    if (read.truncated) health.truncated = true;
    const ref: EvidenceRef = {
      kind: 'omp-session',
      path: file.path,
      sha256: createHash('sha256').update(read.bytes).digest('hex'),
      bytes: read.bytes.length,
    };
    evidence.push(ref);
    const owner = file.owner === null ? null : (actorByFile.get(file.owner) ?? null);
    const scan = scanLog(file, read.bytes.toString('utf8'), read.truncated, root ?? home, owner, ref);
    health.malformed += scan.malformed;
    actors.push(scan.actor);
    actorByFile.set(file.path, scan.actor);
    if (linkage.match === 'isolated-home' && file.path === linkage.file) leadHeaderId = scan.headerId;

    for (const entry of scan.entries) {
      // Native identity: the actor plus the entry id; an entry without an id cannot be deduplicated.
      const key = `${entry.actor.actorId}\u0000${entry.entryId ?? `unidentified ${order.length}`}`;
      const seen = slots.get(key);
      if (!seen) {
        slots.set(key, entry);
        order.push(key);
      } else if (seen.revision === entry.revision) {
        if (seen.canonical === entry.canonical) health.duplicate++;
        else health.conflicting++;
      } else if (isLater(entry.revision, seen.revision)) {
        // A later streaming revision replaces the earlier one; it is never a second request.
        slots.set(key, entry);
      }
    }
    if (read.truncated) break;
  }

  const nativeSessionId = linkage.match === 'isolated-home' ? leadHeaderId : null;
  const requests: NativeRequestRecord[] = [];
  const inputs: InputEvent[] = [];
  /** Per actor: parent entry id -> the last failed request answering it, for retry linkage. */
  const failedByParent = new Map<ActorRecord, Map<string, string>>();
  /** Lead actors whose first user-role message has been seen. */
  const tasked = new Set<ActorRecord>();

  for (const key of order) {
    const entry = slots.get(key) as MessageEntry;
    const role = str(entry.message.role);
    if (role === 'assistant') {
      let failures = failedByParent.get(entry.actor);
      if (!failures) {
        failures = new Map();
        failedByParent.set(entry.actor, failures);
      }
      const retryOf = entry.parentId !== null ? (failures.get(entry.parentId) ?? null) : null;
      const built = buildRequest(entry, nativeSessionId, retryOf);
      const parsed = parseNativeRequestRecord(built.record);
      if (!parsed.ok) {
        health.malformed++;
        continue;
      }
      requests.push(parsed.value);
      if (!obj(entry.message.usage)) health.missing++;
      if (entry.parentId !== null) {
        if (built.failed === true && entry.entryId !== null) failures.set(entry.parentId, entry.entryId);
        else failures.delete(entry.parentId);
      }
    } else if (role === 'user') {
      const lead = entry.actor.role === 'lead';
      const kind = lead && !tasked.has(entry.actor) ? 'initial-task' : 'message';
      if (lead) tasked.add(entry.actor);
      inputs.push({
        eventId: `${entry.actor.actorId}:${entry.entryId ?? key}`,
        at: entry.timestamp ?? entry.revision,
        origin: lead ? 'unknown' : 'automated',
        kind,
        evidence: [entry.evidence],
        basis: lead
          ? 'OMP logs no submission provenance for a user-role message; a person, the runner or a peer may have written it'
          : 'user-role message inside a nested actor log, written by the actor that started it',
      });
    }
  }

  return { ok: true, value: { linkage, actors, requests, inputs, health, evidence } };
}
