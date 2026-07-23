/**
 * Group B — host-observation-attestation: the production Codex host observation
 * and the pure authenticated-delivery-record classifier.
 *
 * Two disjoint concerns live here, both owned by Group B:
 *
 *  1. `CodexHostObservation` (deliverables 1 + 6): one immutable, typed result of
 *     ONLY facts observable from a single bounded Codex subprocess query — parsed
 *     plugin facts, a bounded sanitised advisory stderr, an optional child
 *     self-report (effective CWD / identity / PID) when the probe emits one, the
 *     cache-family witness, and a typed failure. It NEVER receives or infers the
 *     raw `thread/start.cwd` or any control-process fact — those live only in the
 *     black-box `CodexCwdEvidence` harness. The parser accepts advisory stderr
 *     ONLY with exit 0 plus exactly one schema-valid bounded JSON stdout value,
 *     and reports timeout, overflow, nonzero exit, malformed/duplicate JSON,
 *     invalid versions, duplicate registration, and unsafe cache roots as one
 *     ANSI-free typed failure.
 *
 *  2. The pure authenticated-delivery-record assessment (deliverables 4 + 7):
 *     `assessAuthenticatedDelivery` classifies a delivery record read-state against
 *     the current activation intent as `matching | absent | invalid | mismatch`,
 *     and `buildDeliveryIncompleteResult` is the stable `delivery-incomplete`
 *     result (`authority: 'none'`, exit 1, `deliveryComplete: false`). The
 *     activation protocol's inner guard (`beginActivation`) applies exactly this
 *     assessment before its first journal write.
 *
 * This module imports the evidence-owned binding codec plus the leaf
 * `codex-release-version.ts` and `runtime-integrations.ts`; it never imports
 * `codex-activation.ts`, so the activation protocol can import the assessment
 * from here with no import cycle.
 */

import { createHash } from 'node:crypto';
import { type Stats, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AuthenticatedDeliveryAssessment,
  type AuthenticatedDeliveryRecordFields,
  type AuthenticatedDeliveryRecordReadState,
  assessAuthenticatedDeliveryRecord,
} from './codex-delivery-evidence.js';
import { parseReleaseVersion, stripControl } from './codex-release-version.js';
import { type CommandResult, parseCodexPluginState } from './runtime-integrations.js';

// ============================================================================
// Production host observation (facts observable from ONE bounded query)
// ============================================================================

const DEV_INO_RE = /^\d+:\d+$/;
const DEFAULT_MAX_ADVISORY_BYTES = 4 * 1024;

/**
 * A bounded, shallow witness of the Codex plugin cache family — its `dev:ino`
 * identity plus a listing digest. Computed with filesystem access by the caller
 * and handed to the pure parser so the observation stays a pure function of one
 * subprocess result.
 */
export type HostCacheWitness =
  | { status: 'absent' }
  | { status: 'unsafe'; detail: string }
  | { status: 'present'; digest: string; identity: string };

/** Runtime/plugin registration facts parsed from the bounded query. */
export interface HostPluginFacts {
  installed: boolean;
  enabled: boolean | null;
  /** Canonical `MAJOR.YYMMDD.N` version when installed and grammar-valid; null when absent. */
  version: string | null;
}

/**
 * An optional self-report a Genie runtime probe MAY emit about ITS OWN launched
 * process. Present only when the query JSON carries a `genieRuntime` envelope
 * (e.g. a Genie self-diagnostic probe); a plain `codex plugin list --json` never
 * emits it. These are the child's own observable facts — never a control process.
 */
export interface HostChildSelfReport {
  effectiveCwd: string;
  /** `dev:ino` of the effective CWD when the probe emits it; null otherwise. */
  cwdIdentity: string | null;
  pid: number;
}

export type HostObservationFailureCode =
  | 'timeout'
  | 'output-overflow'
  | 'nonzero-exit'
  // `malformed-json` covers empty, unparseable, AND multiple concatenated values —
  // anything that is not exactly one schema-valid JSON stdout value.
  | 'malformed-json'
  | 'invalid-plugin-version'
  | 'duplicate-registration'
  | 'unsafe-cache-root';

export type CodexHostObservation =
  | {
      status: 'ok';
      plugin: HostPluginFacts;
      /** Sanitised, bounded advisory stderr retained ONLY with exit 0 + one valid JSON stdout; null when clean. */
      advisoryStderr: string | null;
      /** The child's own effective CWD when the probe self-reports it; null otherwise. */
      effectiveChildCwd: string | null;
      /** `dev:ino` of the child's effective CWD when emitted; null otherwise. */
      effectiveChildCwdIdentity: string | null;
      /** The child PID when the probe self-reports it; null otherwise. */
      childPid: number | null;
      cacheFamily: HostCacheWitness;
    }
  | { status: 'failed'; code: HostObservationFailureCode; detail: string };

export interface CodexHostObservationInput {
  /** The one bounded subprocess result (exit code, stdout, stderr, timedOut, outputOverflow). */
  result: CommandResult;
  /** The cache-family witness snapshotted around the query. */
  cacheFamily: HostCacheWitness;
  /** Cap on the retained advisory stderr (bytes). Defaults to 4 KiB. */
  maxAdvisoryBytes?: number;
}

/**
 * Parse ONE bounded Codex subprocess result into a single typed observation.
 * Pure: it performs no I/O and derives every fact from `input`.
 */
export function parseCodexHostObservation(input: CodexHostObservationInput): CodexHostObservation {
  const { result, cacheFamily } = input;
  if (result.timedOut) return failure('timeout', 'codex host observation timed out');
  if (result.outputOverflow) return failure('output-overflow', 'codex host observation exceeded the output cap');
  if (result.exitCode !== 0) return failure('nonzero-exit', `codex host observation exited ${result.exitCode}`);
  if (cacheFamily.status === 'unsafe') return failure('unsafe-cache-root', cacheFamily.detail);

  const sanitizedStdout = stripControl(result.stdout).trim();
  const single = singleJsonValue(sanitizedStdout);
  if (!single.ok) return failure(single.code, single.detail);

  const pluginFacts = extractPluginFacts(single.value);
  if (!pluginFacts.ok) return failure(pluginFacts.code, pluginFacts.detail);

  const selfReport = extractSelfReport(single.value);
  const advisoryStderr = boundedAdvisory(result.stderr, input.maxAdvisoryBytes ?? DEFAULT_MAX_ADVISORY_BYTES);
  return {
    status: 'ok',
    plugin: pluginFacts.facts,
    advisoryStderr,
    effectiveChildCwd: selfReport?.effectiveCwd ?? null,
    effectiveChildCwdIdentity: selfReport?.cwdIdentity ?? null,
    childPid: selfReport?.pid ?? null,
    cacheFamily,
  };
}

function failure(code: HostObservationFailureCode, detail: string): CodexHostObservation {
  // Sanitise the detail so every failure remains one ANSI-free typed result.
  return { status: 'failed', code, detail: stripControl(detail) };
}

/** Exactly one JSON value after sanitisation; empty, unparseable, or a second trailing value all fail. */
function singleJsonValue(
  text: string,
): { ok: true; value: unknown } | { ok: false; code: HostObservationFailureCode; detail: string } {
  if (text.length === 0) return { ok: false, code: 'malformed-json', detail: 'empty observation output' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    // A second concatenated JSON value also fails whole-string parse — both are
    // "not exactly one schema-valid JSON value".
    return { ok: false, code: 'malformed-json', detail: 'observation output was not exactly one JSON value' };
  }
}

/**
 * Extract plugin registration facts with precise typed failure codes. Duplicate
 * registrations and malformed/invalid version strings come from the canonical
 * `parseCodexPluginState`; the release-grammar check adds `invalid-plugin-version`
 * for a syntactically-safe but non-release version.
 */
function extractPluginFacts(
  value: unknown,
): { ok: true; facts: HostPluginFacts } | { ok: false; code: HostObservationFailureCode; detail: string } {
  const parsed = parseCodexPluginState(JSON.stringify(value));
  if (!parsed.ok) {
    if (/duplicate/i.test(parsed.detail)) return { ok: false, code: 'duplicate-registration', detail: parsed.detail };
    if (/version/i.test(parsed.detail)) return { ok: false, code: 'invalid-plugin-version', detail: parsed.detail };
    return { ok: false, code: 'malformed-json', detail: parsed.detail };
  }
  if (!parsed.state.installed) {
    return { ok: true, facts: { installed: false, enabled: null, version: null } };
  }
  const version = parseReleaseVersion(parsed.state.version);
  if (version === null) {
    return {
      ok: false,
      code: 'invalid-plugin-version',
      detail: `installed Codex plugin version fails the release grammar: ${parsed.state.version ?? 'null'}`,
    };
  }
  return { ok: true, facts: { installed: true, enabled: parsed.state.enabled ?? false, version: version.canonical } };
}

/**
 * When the query JSON carries a `genieRuntime` envelope, capture the child's own
 * effective CWD / identity / PID. Malformed envelopes are ignored (null) rather
 * than failing the whole observation — a self-report is optional metadata.
 */
function extractSelfReport(value: unknown): HostChildSelfReport | null {
  if (typeof value !== 'object' || value === null) return null;
  const runtime = Reflect.get(value, 'genieRuntime');
  if (typeof runtime !== 'object' || runtime === null) return null;
  const effectiveCwd = Reflect.get(runtime, 'effectiveCwd');
  const pid = Reflect.get(runtime, 'pid');
  if (typeof effectiveCwd !== 'string' || effectiveCwd.length === 0) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  const identityRaw = Reflect.get(runtime, 'cwdIdentity');
  const cwdIdentity = typeof identityRaw === 'string' && DEV_INO_RE.test(identityRaw) ? identityRaw : null;
  return { effectiveCwd, cwdIdentity, pid };
}

/** Retain advisory stderr only, sanitised of control sequences and bounded; null when empty. */
function boundedAdvisory(stderr: string, maxBytes: number): string | null {
  const sanitized = stripControl(stderr).trim();
  if (sanitized.length === 0) return null;
  const buffer = Buffer.from(sanitized, 'utf8');
  if (buffer.length <= maxBytes) return sanitized;
  return `${buffer.subarray(0, maxBytes).toString('utf8')}…`;
}

/**
 * Compute the bounded cache-family witness with filesystem access. A symlinked or
 * non-directory family is `unsafe`; an absent family is `absent`. Kept here (not
 * imported from the activation protocol) so this module never depends on it.
 */
export function witnessCodexCacheFamily(codexHome: string): HostCacheWitness {
  const familyDir = join(codexHome, 'plugins', 'cache', 'automagik', 'genie');
  let stat: Stats;
  try {
    stat = lstatSync(familyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'unsafe', detail: `cache family unreadable: ${errorText(error)}` };
  }
  if (stat.isSymbolicLink()) return { status: 'unsafe', detail: 'cache family is a symlink' };
  if (!stat.isDirectory()) return { status: 'unsafe', detail: 'cache family is not a directory' };
  const digest = createHash('sha256');
  digest.update('genie-codex-cache-family-v1\0');
  try {
    for (const name of readdirSync(familyDir).sort()) {
      const child = lstatSync(join(familyDir, name));
      digest.update(`${name}\0${familyKind(child)}\0`);
    }
  } catch (error) {
    return { status: 'unsafe', detail: `cache family listing failed: ${errorText(error)}` };
  }
  return { status: 'present', digest: digest.digest('hex'), identity: `${stat.dev}:${stat.ino}` };
}

function familyKind(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'L';
  if (stat.isDirectory()) return 'D';
  if (stat.isFile()) return 'F';
  return 'O';
}

// ============================================================================
// Downstream projection (proves ONE observation feeds every projection)
// ============================================================================

export interface HostQueryProjection {
  registration: 'present' | 'absent' | 'unknown';
  installedVersion: string | null;
  enabled: boolean | null;
  /** Advisory stderr is diagnostic metadata, never a second policy decision or a query failure. */
  advisory: string | null;
  /** True only when the query itself failed; a PASS can never be reported with this true. */
  queryFailed: boolean;
  failureCode: HostObservationFailureCode | null;
}

/**
 * The single projection every downstream surface (doctor plugin status + the
 * integration summary + the human/trailer/exit) derives from. Because it is the
 * ONE observation, a `queryFailed: true` and a `registration: 'present'` PASS can
 * never be reported together — the real sandbox PATH advisory rides `advisory`,
 * not `queryFailed`.
 */
export function projectHostQuery(observation: CodexHostObservation): HostQueryProjection {
  if (observation.status === 'failed') {
    return {
      registration: 'unknown',
      installedVersion: null,
      enabled: null,
      advisory: null,
      queryFailed: true,
      failureCode: observation.code,
    };
  }
  return {
    registration: observation.plugin.installed ? 'present' : 'absent',
    installedVersion: observation.plugin.version,
    enabled: observation.plugin.enabled,
    advisory: observation.advisoryStderr,
    queryFailed: false,
    failureCode: null,
  };
}

// ============================================================================
// Authenticated delivery record + pure assessment
// ============================================================================

export type DeliveryAssessment = AuthenticatedDeliveryAssessment;

/**
 * The authenticated delivery record. Every field is mandatory: a legacy
 * minimal/core-only record is structurally invalid and can never authorize
 * activation.
 */
export type AuthenticatedDeliveryRecord = AuthenticatedDeliveryRecordFields;

/** The read-state of the on-disk delivery record (mirrors the activation snapshot's delivery fact). */
export type DeliveryRecordReadState = AuthenticatedDeliveryRecordReadState;

/** The complete authenticated tuple trusted by the current activation request. */
export type ActivationDeliveryExpectation = AuthenticatedDeliveryRecordFields;

/**
 * Pure classifier: `absent` (no record), `invalid` (present but structurally
 * malformed), `mismatch` (valid but a bound value differs from the activation
 * intent), or `matching` (every bound value equals the installed target and
 * current activation intent). Performs no I/O.
 */
export function assessAuthenticatedDelivery(
  fact: DeliveryRecordReadState,
  expectation: ActivationDeliveryExpectation,
): DeliveryAssessment {
  return assessAuthenticatedDeliveryRecord(fact, expectation);
}

// ============================================================================
// Stable `delivery-incomplete` result (authority: none, exit 1, deliveryComplete: false)
// ============================================================================

export interface DeliveryIncompleteResult {
  code: 'delivery-incomplete';
  authority: 'none';
  exit: 1;
  deliveryComplete: false;
  assessment: Exclude<DeliveryAssessment, 'matching'>;
  recovery: string;
  detail: string;
}

/** The one recovery command every non-matching-record surface names. */
export const DELIVERY_INCOMPLETE_RECOVERY =
  'run genie update (or genie install) to publish a verified delivery record, then genie setup --codex';

/**
 * The stable typed `delivery-incomplete` result: no mutation authority, exit 1,
 * `deliveryComplete: false`. Its `detail` is plain, ANSI-free text.
 */
export function buildDeliveryIncompleteResult(
  assessment: Exclude<DeliveryAssessment, 'matching'>,
  detail?: string,
): DeliveryIncompleteResult {
  return {
    code: 'delivery-incomplete',
    authority: 'none',
    exit: 1,
    deliveryComplete: false,
    assessment,
    recovery: DELIVERY_INCOMPLETE_RECOVERY,
    detail:
      detail ??
      `delivery record is ${assessment}; update or install must publish a matching authenticated delivery record before activation`,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
