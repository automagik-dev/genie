/**
 * Codex plugin activation protocol — the pure, fail-closed core.
 *
 * `genie update` can advance and prune a versioned Codex plugin cache while an
 * open Codex task still holds paths into the old generation. This module puts
 * every activation-capable entry path behind three explicit layers:
 *
 *   1. `observeCodexActivation()` performs only bounded reads and returns a
 *      `CodexActivationSnapshot` of plain facts (no mutation, no authority).
 *   2. `classifyCodexActivation(snapshot)` is a pure, total function that maps a
 *      snapshot to exactly one tagged `CodexActivationState` via the design
 *      truth table's first-match ordering.
 *   3. `authorizeCodexActivation(request)` is pure, performs no I/O, and returns
 *      either a refusal or an opaque, process-local, fingerprint-bound
 *      `ActivationPermit`. A permit can be minted only from a genuine
 *      `RetirementAssertion`, which only the deep consent entry point
 *      (`requestRetirementAssertion`) can produce after real TTY/env/flag checks.
 *
 * The `CodexActivationStore` is the only writer of delivery, intent, receipt, and
 * tombstone state. Its raw paths are private; its public surface revalidates
 * inside a delivery callback and re-observes before the first journal write, so
 * stale consent mutates nothing. Every durable transition is fenced by the
 * lifecycle lease's operation ID.
 *
 * Brands are unforgeable at runtime, not merely in the type system: minted
 * assertions and permits are tracked in module-private `WeakSet`s, so a
 * structural lookalike, a persisted JSON object, or a test-constructed
 * substitute fails the runtime membership check.
 */

import { createHash, randomBytes } from 'node:crypto';
import { type Stats, closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  atomicWriteFileSync,
  readBoundedRegularFile,
  renameNonOverwriting,
  unlinkWithParentFsync,
} from './codex-activation-persistence.js';
import { type HeldLifecycleLease, LifecycleFencingError } from './codex-lifecycle-lease.js';
import { resolveCodexDir, resolveGenieHome } from './genie-home.js';
import { type CommandRunner, parseCodexPluginState, runBoundedIntegrationCommand } from './runtime-integrations.js';

// ============================================================================
// Release-version grammar and direction
// ============================================================================

/** Exact `MAJOR.YYMMDD.N` release grammar; build metadata is stripped only after a match. */
const RELEASE_VERSION_RE = /^(\d+)\.(\d{6})\.(\d+)(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export interface ParsedReleaseVersion {
  readonly major: number;
  readonly ymd: number;
  readonly n: number;
  /** The `MAJOR.YYMMDD.N` triple with build metadata removed; used for equality. */
  readonly canonical: string;
}

/** Parse a release version, returning null for anything that fails the exact grammar. */
export function parseReleaseVersion(raw: unknown): ParsedReleaseVersion | null {
  if (typeof raw !== 'string') return null;
  const match = RELEASE_VERSION_RE.exec(raw);
  if (!match) return null;
  const major = Number(match[1]);
  const ymd = Number(match[2]);
  const n = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(ymd) || !Number.isSafeInteger(n)) return null;
  return { major, ymd, n, canonical: `${major}.${match[2]}.${n}` };
}

/** Total numeric order over validated versions. */
export function compareReleaseVersions(a: ParsedReleaseVersion, b: ParsedReleaseVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.ymd !== b.ymd) return a.ymd < b.ymd ? -1 : 1;
  if (a.n !== b.n) return a.n < b.n ? -1 : 1;
  return 0;
}

export type ActivationDirection = 'install' | 'upgrade' | 'downgrade' | 'repair';

/** Direction is the total result of comparing a (nullable) from against target. */
export function deriveDirection(from: ParsedReleaseVersion | null, target: ParsedReleaseVersion): ActivationDirection {
  if (from === null) return 'install';
  const order = compareReleaseVersions(from, target);
  if (order < 0) return 'upgrade';
  if (order > 0) return 'downgrade';
  return 'repair';
}

// ============================================================================
// Durable record schemas
// ============================================================================

const HEX_128_RE = /^[0-9a-f]{32}$/;
const HEX_256_RE = /^[0-9a-f]{64}$/;
const MAX_INTENT_BYTES = 16 * 1024;
const MAX_RECEIPT_BYTES = 8 * 1024;
const MAX_DELIVERY_BYTES = 8 * 1024;
const MAX_FAILURE_TEXT = 2048;

export type IntentPhase = 'planned' | 'command-started' | 'removal-observed' | 'ambiguous-absent';
const INTENT_PHASES: ReadonlySet<string> = new Set<IntentPhase>([
  'planned',
  'command-started',
  'removal-observed',
  'ambiguous-absent',
]);

export interface RefreshIntent {
  schemaVersion: 1;
  /** The intent's own 128-bit id, distinct from delivery/receipt ids. */
  refreshIntentId: string;
  /** The holding lease's operation id — fences every subsequent transition. */
  operationId: string;
  fromPluginVersion: string | null;
  targetVersion: string;
  direction: ActivationDirection;
  priorEnabled: boolean;
  canonicalPayloadSha256: string;
  phase: IntentPhase;
  commandKind: 'codex-plugin-add';
  lastFailure: string;
  /** Matches the downgrade receipt id only for a downgrade; null otherwise. */
  receiptId: string | null;
}

export interface DowngradeReceipt {
  schemaVersion: 1;
  receiptId: string;
  fromPluginVersion: string;
  targetVersion: string;
  canonicalPayloadSha256: string;
  channel: string;
}

export interface DeliveryRecord {
  schemaVersion: 1;
  /** The 128-bit delivery transaction id; a downgrade receipt copies it as its receiptId. */
  deliveryId: string;
  targetVersion: string;
  canonicalPayloadSha256: string;
  channel: string;
  deliveredAt: string;
}

export interface ReceiptTombstone {
  schemaVersion: 1;
  receiptId: string;
  consumedAt: string;
  operationId: string;
}

const INTENT_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'refreshIntentId',
  'operationId',
  'fromPluginVersion',
  'targetVersion',
  'direction',
  'priorEnabled',
  'canonicalPayloadSha256',
  'phase',
  'commandKind',
  'lastFailure',
  'receiptId',
]);

/** Structural schema-1 validation only; semantic binding to the snapshot happens in the classifier. */
export function parseRefreshIntentStructure(content: string): RefreshIntent | null {
  const parsed = safeJson(content);
  if (!isPlainObject(parsed)) return null;
  if (Object.keys(parsed).some((key) => !INTENT_KEYS.has(key))) return null; // no unknown keys
  const record = parsed;
  if (record.schemaVersion !== 1) return null;
  if (!isHex128(record.refreshIntentId) || !isHex128(record.operationId)) return null;
  if (record.fromPluginVersion !== null && parseReleaseVersion(record.fromPluginVersion) === null) return null;
  if (parseReleaseVersion(record.targetVersion) === null) return null;
  if (!isDirection(record.direction)) return null;
  if (typeof record.priorEnabled !== 'boolean') return null;
  if (!isHex256(record.canonicalPayloadSha256)) return null;
  if (typeof record.phase !== 'string' || !INTENT_PHASES.has(record.phase)) return null;
  if (record.commandKind !== 'codex-plugin-add') return null;
  if (typeof record.lastFailure !== 'string' || record.lastFailure.length > MAX_FAILURE_TEXT) return null;
  if (record.receiptId !== null && !isHex128(record.receiptId)) return null;
  return {
    schemaVersion: 1,
    refreshIntentId: record.refreshIntentId as string,
    operationId: record.operationId as string,
    fromPluginVersion: record.fromPluginVersion as string | null,
    targetVersion: record.targetVersion as string,
    direction: record.direction as ActivationDirection,
    priorEnabled: record.priorEnabled as boolean,
    canonicalPayloadSha256: record.canonicalPayloadSha256 as string,
    phase: record.phase as IntentPhase,
    commandKind: 'codex-plugin-add',
    lastFailure: record.lastFailure as string,
    receiptId: record.receiptId as string | null,
  };
}

const RECEIPT_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'receiptId',
  'fromPluginVersion',
  'targetVersion',
  'canonicalPayloadSha256',
  'channel',
]);

export function parseDowngradeReceiptStructure(content: string): DowngradeReceipt | null {
  const parsed = safeJson(content);
  if (!isPlainObject(parsed)) return null;
  if (Object.keys(parsed).some((key) => !RECEIPT_KEYS.has(key))) return null;
  const record = parsed;
  if (record.schemaVersion !== 1) return null;
  if (!isHex128(record.receiptId)) return null;
  const from = parseReleaseVersion(record.fromPluginVersion);
  const target = parseReleaseVersion(record.targetVersion);
  if (from === null || target === null) return null;
  if (compareReleaseVersions(from, target) <= 0) return null; // receipts only exist for a real downgrade
  if (!isHex256(record.canonicalPayloadSha256)) return null;
  if (typeof record.channel !== 'string' || record.channel.length === 0 || record.channel.length > 128) return null;
  return {
    schemaVersion: 1,
    receiptId: record.receiptId as string,
    fromPluginVersion: record.fromPluginVersion as string,
    targetVersion: record.targetVersion as string,
    canonicalPayloadSha256: record.canonicalPayloadSha256 as string,
    channel: record.channel as string,
  };
}

const DELIVERY_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'deliveryId',
  'targetVersion',
  'canonicalPayloadSha256',
  'channel',
  'deliveredAt',
]);

export function parseDeliveryRecordStructure(content: string): DeliveryRecord | null {
  const parsed = safeJson(content);
  if (!isPlainObject(parsed)) return null;
  if (Object.keys(parsed).some((key) => !DELIVERY_KEYS.has(key))) return null;
  const record = parsed;
  if (record.schemaVersion !== 1) return null;
  if (!isHex128(record.deliveryId)) return null;
  if (parseReleaseVersion(record.targetVersion) === null) return null;
  if (!isHex256(record.canonicalPayloadSha256)) return null;
  if (typeof record.channel !== 'string' || record.channel.length === 0 || record.channel.length > 128) return null;
  if (typeof record.deliveredAt !== 'string' || record.deliveredAt.length === 0) return null;
  return {
    schemaVersion: 1,
    deliveryId: record.deliveryId as string,
    targetVersion: record.targetVersion as string,
    canonicalPayloadSha256: record.canonicalPayloadSha256 as string,
    channel: record.channel as string,
    deliveredAt: record.deliveredAt as string,
  };
}

const TOMBSTONE_KEYS: ReadonlySet<string> = new Set(['schemaVersion', 'receiptId', 'consumedAt', 'operationId']);

export function parseReceiptTombstoneStructure(content: string): ReceiptTombstone | null {
  const parsed = safeJson(content);
  if (!isPlainObject(parsed)) return null;
  if (Object.keys(parsed).some((key) => !TOMBSTONE_KEYS.has(key))) return null;
  const record = parsed;
  if (record.schemaVersion !== 1) return null;
  if (!isHex128(record.receiptId) || !isHex128(record.operationId)) return null;
  if (typeof record.consumedAt !== 'string' || record.consumedAt.length === 0) return null;
  return {
    schemaVersion: 1,
    receiptId: record.receiptId as string,
    consumedAt: record.consumedAt as string,
    operationId: record.operationId as string,
  };
}

// ============================================================================
// Snapshot facts
// ============================================================================

export interface PhysicalTreeReport {
  status: 'ok' | 'symlink' | 'unsafe' | 'absent';
  digest?: string;
  identity?: string;
  detail?: string;
}

export type RegistrationFact =
  | { present: false }
  | { present: true; enabled: boolean; version: ParsedReleaseVersion }
  | { present: true; enabled: boolean; version: null; rawVersion: string | null };

export type QueryFact = { status: 'failed'; detail: string } | { status: 'ok'; registration: RegistrationFact };

export type CanonicalFact =
  | { status: 'ok'; version: ParsedReleaseVersion; digest: string; identity: string }
  | { status: 'error'; detail: string };

export type PhysicalCacheFact =
  | { kind: 'not-applicable' }
  | { kind: 'absent' }
  | { kind: 'unsafe-symlink'; detail: string }
  | { kind: 'unsafe'; detail: string }
  | { kind: 'present'; digest: string; identity: string };

export type ReceiptFact =
  | { status: 'absent' }
  | { status: 'invalid'; detail: string }
  | { status: 'present'; receipt: DowngradeReceipt };

export type DeliveryFact =
  | { status: 'absent' }
  | { status: 'invalid'; detail: string }
  | { status: 'present'; record: DeliveryRecord };

export type IntentFact =
  | { status: 'absent' }
  | { status: 'unsafe'; detail: string }
  | { status: 'oversized'; size: number }
  | { status: 'corrupt'; contentSha256: string; detail: string }
  | { status: 'valid'; intent: RefreshIntent; contentSha256: string };

/** Bounded identity + shallow listing digest of N's cache family, snapshotted around the query. */
export type FamilyWitness =
  | { status: 'absent' }
  | { status: 'unsafe'; detail: string }
  | { status: 'present'; digest: string; identity: string };

export interface CodexActivationSnapshot {
  canonical: CanonicalFact;
  query: QueryFact;
  cache: PhysicalCacheFact;
  receipt: ReceiptFact;
  delivery: DeliveryFact;
  intent: IntentFact;
  /** Whether the delivery receipt id was already consumed (tombstoned). */
  receiptConsumed: boolean;
  /** The cache-family witness immediately before and after the plugin query — proves observation is inert. */
  observationWitness: { before: FamilyWitness; after: FamilyWitness };
  observedAt: string;
}

// ============================================================================
// Classifier states
// ============================================================================

export interface IntentQuarantineTarget {
  oversized: boolean;
  contentSha256: string | null;
}

export type CodexActivationState =
  | { kind: 'query-failed'; detail: string }
  | { kind: 'registration-version-invalid'; rawVersion: string | null }
  | { kind: 'unsafe-cache-symlink'; detail: string }
  | { kind: 'unsafe-cache'; detail: string }
  | { kind: 'intent-invalid'; quarantine: IntentQuarantineTarget }
  | { kind: 'intent-mismatch'; quarantine: IntentQuarantineTarget; detail: string }
  | { kind: 'intent-target-current'; intent: RefreshIntent }
  | { kind: 'intent-ambiguous-absent'; intent: RefreshIntent }
  | { kind: 'intent-removal-observed'; intent: RefreshIntent }
  | { kind: 'intent-command-started'; intent: RefreshIntent }
  | { kind: 'intent-planned'; intent: RefreshIntent }
  | { kind: 'registration-absent' }
  | { kind: 'cache-missing' }
  | { kind: 'payload-mismatch'; detail: string }
  | { kind: 'pending-downgrade-explicit'; from: string; target: string; receiptId: string }
  | { kind: 'installed-newer'; from: string; target: string }
  | { kind: 'activation-pending'; from: string; target: string }
  | { kind: 'current' }
  | { kind: 'snapshot-inconsistent'; detail: string };

export type MutationAuthority = 'none' | 'journal-quarantine-only' | 'external-tty-setup';
export type CacheProjection =
  | 'verified-current'
  | 'present-unverified'
  | 'missing'
  | 'unsafe-symlink'
  | 'unsafe'
  | 'mismatch'
  | 'unknown';

/** The registration fact, treating a failed query as "no registration" for readers. */
function registrationOf(snapshot: CodexActivationSnapshot): RegistrationFact {
  return snapshot.query.status === 'ok' ? snapshot.query.registration : { present: false };
}

/**
 * Pure, total classifier. Evaluates the design truth table in first-match order
 * and always returns exactly one tagged state. Performs no I/O.
 */
export function classifyCodexActivation(snapshot: CodexActivationSnapshot): CodexActivationState {
  const preIntent = classifyPreIntent(snapshot);
  if (preIntent) return preIntent;
  const intentState = classifyIntent(snapshot);
  if (intentState) return intentState;
  return classifyRegistration(snapshot);
}

/** Rows that fail closed before any journal is trusted: query, canonical, invalid version, unsafe cache. */
function classifyPreIntent(snapshot: CodexActivationSnapshot): CodexActivationState | null {
  if (snapshot.query.status === 'failed') return { kind: 'query-failed', detail: snapshot.query.detail };
  if (snapshot.canonical.status === 'error') {
    return { kind: 'snapshot-inconsistent', detail: `canonical payload unreadable: ${snapshot.canonical.detail}` };
  }
  const registration = registrationOf(snapshot);
  if (registration.present && registration.version === null) {
    return { kind: 'registration-version-invalid', rawVersion: registration.rawVersion };
  }
  if (snapshot.cache.kind === 'unsafe-symlink') return { kind: 'unsafe-cache-symlink', detail: snapshot.cache.detail };
  if (snapshot.cache.kind === 'unsafe') return { kind: 'unsafe-cache', detail: snapshot.cache.detail };
  return null;
}

/** Intent rows. A symlinked/non-regular intent path fails closed; oversized/corrupt is quarantine-only. */
function classifyIntent(snapshot: CodexActivationSnapshot): CodexActivationState | null {
  const intent = snapshot.intent;
  if (intent.status === 'absent') return null;
  if (intent.status === 'unsafe') {
    return { kind: 'snapshot-inconsistent', detail: `refresh intent path is unsafe: ${intent.detail}` };
  }
  if (intent.status === 'oversized') {
    return { kind: 'intent-invalid', quarantine: { oversized: true, contentSha256: null } };
  }
  if (intent.status === 'corrupt') {
    return { kind: 'intent-invalid', quarantine: { oversized: false, contentSha256: intent.contentSha256 } };
  }
  const quarantine: IntentQuarantineTarget = { oversized: false, contentSha256: intent.contentSha256 };
  const binding = bindIntent(intent.intent, snapshot);
  if (!binding.bound) return { kind: 'intent-mismatch', quarantine, detail: binding.detail };
  if (isTargetCurrent(snapshot)) return { kind: 'intent-target-current', intent: intent.intent };
  switch (intent.intent.phase) {
    case 'ambiguous-absent':
      return { kind: 'intent-ambiguous-absent', intent: intent.intent };
    case 'removal-observed':
      return { kind: 'intent-removal-observed', intent: intent.intent };
    case 'command-started':
      return { kind: 'intent-command-started', intent: intent.intent };
    case 'planned':
      return { kind: 'intent-planned', intent: intent.intent };
  }
}

/** Registration/cache comparison rows once no unresolved intent remains. */
function classifyRegistration(snapshot: CodexActivationSnapshot): CodexActivationState {
  const registration = registrationOf(snapshot);
  const canonical = snapshot.canonical;
  if (canonical.status !== 'ok') return { kind: 'snapshot-inconsistent', detail: 'canonical target unavailable' };
  if (!registration.present) return { kind: 'registration-absent' };
  if (registration.version === null) return { kind: 'registration-version-invalid', rawVersion: null };
  if (snapshot.cache.kind === 'absent') return { kind: 'cache-missing' };
  if (snapshot.cache.kind !== 'present') {
    return { kind: 'snapshot-inconsistent', detail: `unexpected cache fact: ${snapshot.cache.kind}` };
  }
  const order = compareReleaseVersions(registration.version, canonical.version);
  const cacheDigest = snapshot.cache.digest;
  if (order === 0) {
    if (cacheDigest !== canonical.digest) {
      return { kind: 'payload-mismatch', detail: 'installed T bytes differ from the canonical payload' };
    }
    return { kind: 'current' };
  }
  if (order > 0) return classifyDowngradeSide(snapshot, registration.version, canonical);
  return { kind: 'activation-pending', from: registration.version.canonical, target: canonical.version.canonical };
}

function classifyDowngradeSide(
  snapshot: CodexActivationSnapshot,
  registered: ParsedReleaseVersion,
  canonical: Extract<CanonicalFact, { status: 'ok' }>,
): CodexActivationState {
  if (downgradeReceiptMatches(snapshot, registered, canonical)) {
    const receiptId = snapshot.receipt.status === 'present' ? snapshot.receipt.receipt.receiptId : '';
    return {
      kind: 'pending-downgrade-explicit',
      from: registered.canonical,
      target: canonical.version.canonical,
      receiptId,
    };
  }
  return { kind: 'installed-newer', from: registered.canonical, target: canonical.version.canonical };
}

function downgradeReceiptMatches(
  snapshot: CodexActivationSnapshot,
  registered: ParsedReleaseVersion,
  canonical: Extract<CanonicalFact, { status: 'ok' }>,
): boolean {
  if (snapshot.receipt.status !== 'present' || snapshot.receiptConsumed) return false;
  const receipt = snapshot.receipt.receipt;
  const from = parseReleaseVersion(receipt.fromPluginVersion);
  const target = parseReleaseVersion(receipt.targetVersion);
  if (from === null || target === null) return false;
  if (from.canonical !== registered.canonical) return false;
  if (target.canonical !== canonical.version.canonical) return false;
  if (receipt.canonicalPayloadSha256 !== canonical.digest) return false;
  // When a delivery record is present, its transaction id must equal the receipt id.
  if (snapshot.delivery.status === 'present' && snapshot.delivery.record.deliveryId !== receipt.receiptId) return false;
  return true;
}

function isTargetCurrent(snapshot: CodexActivationSnapshot): boolean {
  const registration = registrationOf(snapshot);
  const canonical = snapshot.canonical;
  if (canonical.status !== 'ok' || !registration.present || registration.version === null) return false;
  if (compareReleaseVersions(registration.version, canonical.version) !== 0) return false;
  return snapshot.cache.kind === 'present' && snapshot.cache.digest === canonical.digest;
}

interface IntentBinding {
  bound: boolean;
  detail: string;
}

/** Semantic binding of a structurally valid intent to the current snapshot. */
function bindIntent(intent: RefreshIntent, snapshot: CodexActivationSnapshot): IntentBinding {
  const canonical = snapshot.canonical;
  if (canonical.status !== 'ok') return { bound: false, detail: 'canonical target unavailable' };
  const target = parseReleaseVersion(intent.targetVersion);
  if (target === null || target.canonical !== canonical.version.canonical) {
    return { bound: false, detail: 'intent target differs from canonical target' };
  }
  if (intent.canonicalPayloadSha256 !== canonical.digest) {
    return { bound: false, detail: 'intent digest differs from canonical digest' };
  }
  const from = intent.fromPluginVersion === null ? null : parseReleaseVersion(intent.fromPluginVersion);
  if (intent.fromPluginVersion !== null && from === null)
    return { bound: false, detail: 'intent from-version invalid' };
  if (deriveDirection(from, target) !== intent.direction) {
    return { bound: false, detail: 'intent direction differs from derived direction' };
  }
  const registrationBinding = bindIntentRegistration(intent, snapshot, from);
  if (!registrationBinding.bound) return registrationBinding;
  return bindIntentReceipt(intent, snapshot);
}

function bindIntentRegistration(
  intent: RefreshIntent,
  snapshot: CodexActivationSnapshot,
  from: ParsedReleaseVersion | null,
): IntentBinding {
  const registration = registrationOf(snapshot);
  const registered = registration.present && registration.version ? registration.version.canonical : null;
  const target = intent.targetVersion;
  const fromCanonical = from?.canonical ?? null;
  if (intent.phase === 'planned') {
    // Planned: registration must equal from (or be absent for install).
    if (fromCanonical === null) {
      return registered === null ? bound() : { bound: false, detail: 'planned install expects no registration' };
    }
    return registered === fromCanonical ? bound() : { bound: false, detail: 'planned registration must equal from' };
  }
  // Later phases: registration may only be from, absent, or target.
  const parsedTarget = parseReleaseVersion(target);
  const targetCanonical = parsedTarget ? parsedTarget.canonical : target;
  if (registered === null || registered === fromCanonical || registered === targetCanonical) return bound();
  return { bound: false, detail: 'later-phase registration must be from, absent, or target' };
}

function bindIntentReceipt(intent: RefreshIntent, snapshot: CodexActivationSnapshot): IntentBinding {
  if (intent.direction === 'downgrade') {
    if (intent.receiptId === null) return { bound: false, detail: 'downgrade intent requires a receipt id' };
    if (snapshot.receipt.status !== 'present' || snapshot.receipt.receipt.receiptId !== intent.receiptId) {
      return { bound: false, detail: 'downgrade receipt id does not match a present receipt' };
    }
    if (snapshot.receiptConsumed) return { bound: false, detail: 'downgrade receipt already consumed' };
    return bound();
  }
  return intent.receiptId === null
    ? bound()
    : { bound: false, detail: 'non-downgrade intent must have null receipt id' };
}

function bound(): IntentBinding {
  return { bound: true, detail: '' };
}

// ============================================================================
// State descriptor: authority, exit, recovery
// ============================================================================

export interface StateDescriptor {
  machineCode: string;
  exit: 0 | 1 | 2;
  authority: MutationAuthority;
  actionRequired: boolean;
  recovery: string;
}

const RETIRE_RECOVERY = 'retire tasks → genie setup --codex → /hooks → new task';

/**
 * A single flat switch over the closed state union — the truth table's exit and
 * authority columns in one auditable place. Every arm is a literal with no
 * nesting, so cognitive complexity stays low.
 */
export function describeState(state: CodexActivationState): StateDescriptor {
  switch (state.kind) {
    case 'query-failed':
      return desc('query-failed', 1, 'none', true, 'Indeterminate; repair the Codex CLI/query, then rerun doctor');
    case 'registration-version-invalid':
      return desc(
        'registration-version-invalid',
        1,
        'none',
        true,
        'Indeterminate registration version; no comparison authority',
      );
    case 'unsafe-cache-symlink':
      return desc(
        'unsafe-cache-symlink',
        1,
        'none',
        true,
        'Unsafe cache symlink; repair through Codex, never Genie filesystem surgery',
      );
    case 'unsafe-cache':
      return desc('unsafe-cache', 1, 'none', true, 'Unsafe cache topology; manual Codex-host recovery');
    case 'intent-invalid':
      return desc(
        'intent-invalid',
        1,
        'journal-quarantine-only',
        true,
        'Quarantine the intent after a fresh assertion, then re-observe',
      );
    case 'intent-mismatch':
      return desc(
        'intent-mismatch',
        1,
        'journal-quarantine-only',
        true,
        'Quarantine the mismatched intent after a fresh assertion, then re-observe',
      );
    case 'intent-target-current':
      return desc(
        'intent-target-current',
        2,
        'external-tty-setup',
        true,
        'Restore enabled flag, reverify parity/H3, then clear the journal',
      );
    case 'intent-ambiguous-absent':
      return desc(
        'intent-ambiguous-absent',
        1,
        'external-tty-setup',
        true,
        'Broken/retry; reconcile with supported CLI, N may be gone',
      );
    case 'intent-removal-observed':
      return desc(
        'intent-removal-observed',
        1,
        'external-tty-setup',
        true,
        'N is gone; continue the supported add/verify transaction',
      );
    case 'intent-command-started':
      return desc(
        'intent-command-started',
        1,
        'external-tty-setup',
        true,
        'Host may have pruned N; query and idempotently reconcile',
      );
    case 'intent-planned':
      return desc(
        'intent-planned',
        2,
        'external-tty-setup',
        true,
        'No command is known to have started; resume through setup',
      );
    case 'registration-absent':
      return desc(
        'registration-absent',
        2,
        'external-tty-setup',
        true,
        'Activation required; update/install do not install it',
      );
    case 'cache-missing':
      return desc('cache-missing', 1, 'external-tty-setup', true, 'Broken/repair; supported reinstall only');
    case 'payload-mismatch':
      return desc(
        'payload-mismatch',
        1,
        'external-tty-setup',
        true,
        'Broken/repair; never execute or trust mismatched payload',
      );
    case 'pending-downgrade-explicit':
      return desc(
        'pending-downgrade-explicit',
        2,
        'external-tty-setup',
        true,
        `Explicit downgrade ${state.from}→${state.target} pending; retirement is irreversible`,
      );
    case 'installed-newer':
      return desc(
        'installed-newer',
        1,
        'none',
        true,
        'Refuse implicit downgrade; run an explicit channel update, then setup',
      );
    case 'activation-pending':
      return desc('activation-pending', 2, 'external-tty-setup', true, RETIRE_RECOVERY);
    case 'current':
      return desc('current', 0, 'none', false, 'Current; no mutation');
    case 'snapshot-inconsistent':
      return desc(
        'snapshot-inconsistent',
        1,
        'none',
        true,
        'Fail closed; print bounded snapshot facts, infer no authority',
      );
  }
}

function desc(
  machineCode: string,
  exit: 0 | 1 | 2,
  authority: MutationAuthority,
  actionRequired: boolean,
  recovery: string,
): StateDescriptor {
  return { machineCode, exit, authority, actionRequired, recovery };
}

// ============================================================================
// Unforgeable consent + authorization
// ============================================================================

/** Runtime brand registries. Membership — not structural shape — proves genuineness. */
const MINTED_ASSERTIONS = new WeakSet<object>();
const MINTED_PERMITS = new WeakSet<object>();

/**
 * A version-specific operator retirement assertion. Only the deep consent entry
 * point can mint one, and only for the current process. It is authority, never
 * proof of task liveness, and is never persisted. Genuineness is proven by
 * membership in `MINTED_ASSERTIONS`, never by construction: any instance made
 * outside `mintRetirementAssertion` (including `new instance.constructor(...)`)
 * is unregistered and rejected by every brand check.
 */
class RetirementAssertion {
  constructor(
    readonly observedFrom: string | null,
    readonly observedTarget: string,
    readonly assertedAt: string,
  ) {}
}

/**
 * Module-private factory; the sole path that registers a `RetirementAssertion` as
 * genuine. A free function, not a static, so it is unreachable via
 * `instance.constructor.*` — closing the static-`mint` escape hatch.
 */
function mintRetirementAssertion(
  observedFrom: string | null,
  observedTarget: string,
  assertedAt: string,
): RetirementAssertion {
  const assertion = new RetirementAssertion(observedFrom, observedTarget, assertedAt);
  MINTED_ASSERTIONS.add(assertion);
  return assertion;
}

export type PermitCapability = 'activation' | 'journal-quarantine';

/**
 * An opaque, process-local capability bound to an activation-request fingerprint.
 * Genuineness is proven by membership in `MINTED_PERMITS`, never by construction.
 */
class ActivationPermit {
  constructor(
    readonly capability: PermitCapability,
    readonly fingerprint: ActivationRequestFingerprint,
    readonly observedFrom: string | null,
    readonly observedTarget: string,
  ) {}
}

/**
 * Module-private factory; the sole path that registers an `ActivationPermit` as
 * genuine. A free function, not a static, so it is unreachable via
 * `instance.constructor.*` — closing the static-`mint` escape hatch.
 */
function mintActivationPermit(
  capability: PermitCapability,
  fingerprint: ActivationRequestFingerprint,
  observedFrom: string | null,
  observedTarget: string,
): ActivationPermit {
  const permit = new ActivationPermit(capability, fingerprint, observedFrom, observedTarget);
  MINTED_PERMITS.add(permit);
  return permit;
}

// Brands are type-only exports: importers may name them in type position, but the
// runtime classes never leave this module. The minters are free functions (not
// statics on the constructor), so neither an importer nor `instance.constructor`
// can reach them — the guarded consent entry point is the only route to a genuine,
// WeakSet-registered brand.
export type { RetirementAssertion, ActivationPermit };

export interface ActivationRequestFingerprint {
  observedFrom: string | null;
  observedTarget: string | null;
  canonicalPayloadSha256: string | null;
  installedDeliveryDigest: string | null;
  deliveryId: string | null;
  registrationIdentity: string | null;
  cacheIdentity: string | null;
  enabled: boolean | null;
  intentPhase: IntentPhase | null;
  intentId: string | null;
  receiptId: string | null;
}

/** The ordered fingerprint fields; `beginActivation` reports the first that drifts. */
const FINGERPRINT_FIELDS: readonly (keyof ActivationRequestFingerprint)[] = [
  'observedFrom',
  'observedTarget',
  'canonicalPayloadSha256',
  'installedDeliveryDigest',
  'deliveryId',
  'registrationIdentity',
  'cacheIdentity',
  'enabled',
  'intentPhase',
  'intentId',
  'receiptId',
];

export function computeActivationFingerprint(snapshot: CodexActivationSnapshot): ActivationRequestFingerprint {
  const registration = registrationOf(snapshot);
  const registered = registration.present && registration.version ? registration.version.canonical : null;
  const canonical = snapshot.canonical.status === 'ok' ? snapshot.canonical : null;
  const cache = snapshot.cache;
  const intent = snapshot.intent;
  const family = snapshot.observationWitness.after;
  return {
    observedFrom: registered,
    observedTarget: canonical ? canonical.version.canonical : null,
    canonicalPayloadSha256: canonical ? canonical.digest : null,
    installedDeliveryDigest: cache.kind === 'present' ? cache.digest : null,
    deliveryId: snapshot.delivery.status === 'present' ? snapshot.delivery.record.deliveryId : null,
    registrationIdentity: cache.kind === 'present' ? cache.identity : null,
    cacheIdentity: family.status === 'present' ? family.identity : null,
    enabled: registration.present ? registration.enabled : null,
    intentPhase: intent.status === 'valid' ? intent.intent.phase : null,
    intentId: intent.status === 'valid' ? intent.intent.refreshIntentId : null,
    receiptId: snapshot.receipt.status === 'present' ? snapshot.receipt.receipt.receiptId : null,
  };
}

/** Returns the first fingerprint field that differs, or null when they are identical. */
export function firstFingerprintMismatch(
  a: ActivationRequestFingerprint,
  b: ActivationRequestFingerprint,
): keyof ActivationRequestFingerprint | null {
  for (const field of FINGERPRINT_FIELDS) {
    if (a[field] !== b[field]) return field;
  }
  return null;
}

export interface ActivationInvocation {
  entry: ActivationEntryPath;
  assertion: RetirementAssertion | null;
}

export type ActivationEntryPath =
  | 'update'
  | 'post-delivery-converge'
  | 'already-current-update'
  | 'downgrade-delivery'
  | 'rollback'
  | 'install'
  | 'setup-codex'
  | 'full-setup-codex-step'
  | 'quick-setup'
  | 'sync-only'
  | 'doctor'
  | 'refresh-recovery-setup';

/** Entry paths that may legitimately carry a genuine assertion (external, real-TTY setup). */
const SETUP_ENTRY_PATHS: ReadonlySet<ActivationEntryPath> = new Set<ActivationEntryPath>([
  'setup-codex',
  'full-setup-codex-step',
  'refresh-recovery-setup',
]);

export type AuthorizationResult =
  | { result: 'not-requested' }
  | { result: 'required'; reason: string }
  | { result: 'refused'; reason: string }
  | { result: 'granted'; permit: ActivationPermit };

export interface AuthorizationRequest {
  state: CodexActivationState;
  snapshot: CodexActivationSnapshot;
  invocation: ActivationInvocation;
}

/**
 * Pure authorization overlay. Consumes a genuine `RetirementAssertion`, performs
 * no I/O, and returns a fingerprint-bound permit only when the assertion is
 * genuine, the entry path is an external setup path, and the asserted versions
 * still match the snapshot. A boolean, structural lookalike, persisted consent,
 * or test-constructed substitute fails the runtime genuineness check.
 */
export function authorizeCodexActivation(request: AuthorizationRequest): AuthorizationResult {
  const { authority } = describeState(request.state);
  if (authority === 'none') return { result: 'not-requested' };
  const capability: PermitCapability = authority === 'journal-quarantine-only' ? 'journal-quarantine' : 'activation';
  const { assertion, entry } = request.invocation;
  if (!SETUP_ENTRY_PATHS.has(entry)) {
    return { result: 'required', reason: 'activation requires an external real-TTY genie setup --codex assertion' };
  }
  if (assertion === null) {
    return { result: 'required', reason: 'a fresh retirement assertion is required' };
  }
  if (!MINTED_ASSERTIONS.has(assertion)) {
    return { result: 'refused', reason: 'assertion is not a genuine retirement assertion' };
  }
  const observed = observedVersions(request.snapshot);
  if (assertion.observedFrom !== observed.from || assertion.observedTarget !== observed.target) {
    return { result: 'refused', reason: 'stale assertion: observed versions changed since consent' };
  }
  const fingerprint = computeActivationFingerprint(request.snapshot);
  const permit = mintActivationPermit(capability, fingerprint, observed.from, observed.target ?? '');
  return { result: 'granted', permit };
}

function observedVersions(snapshot: CodexActivationSnapshot): { from: string | null; target: string | null } {
  const registration = registrationOf(snapshot);
  const from = registration.present && registration.version ? registration.version.canonical : null;
  const target = snapshot.canonical.status === 'ok' ? snapshot.canonical.version.canonical : null;
  return { from, target };
}

// ============================================================================
// Consent entry point (owns TTY/env/flag checks + the affirmative prompt)
// ============================================================================

const QUICK_FLAGS: ReadonlySet<string> = new Set(['--quick', '--fast']);
const NO_INTERACTIVE_FLAGS: ReadonlySet<string> = new Set([
  '--no-interactive',
  '--non-interactive',
  '--noninteractive',
  '--yes',
  '-y',
]);

export interface ConsentContext {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  /** The affirmative gate; returns true only on an explicit yes. Owns the real prompt in production. */
  prompt: (message: string) => boolean;
}

export type RetirementConsentResult =
  | { result: 'granted'; assertion: RetirementAssertion }
  | { result: 'required'; reason: string }
  | { result: 'refused'; reason: string };

/**
 * The single source of a genuine `RetirementAssertion`. Enforces real stdin and
 * stdout TTYs, empty `CODEX_THREAD_ID` and `CI`, no `--quick`/`--no-interactive`
 * spelling, and an affirmative prompt naming the observed N and T. Any guard
 * failure, decline, or EOF returns a refusal and mints nothing.
 */
export function requestRetirementAssertion(
  snapshot: CodexActivationSnapshot,
  ctx: ConsentContext,
): RetirementConsentResult {
  const guard = environmentGuard(ctx);
  if (guard) return { result: 'refused', reason: guard };
  const observed = observedVersions(snapshot);
  const target = observed.target;
  if (target === null) return { result: 'refused', reason: 'no canonical target to activate' };
  const from = observed.from ?? 'none';
  const message = `I assert tasks pinned to ${from} are retired and will not be resumed; activate ${target}.`;
  let affirmative: boolean;
  try {
    affirmative = ctx.prompt(message) === true;
  } catch {
    return { result: 'refused', reason: 'consent prompt failed or was interrupted' };
  }
  if (!affirmative) return { result: 'refused', reason: 'operator declined the retirement assertion' };
  return { result: 'granted', assertion: mintRetirementAssertion(observed.from, target, new Date().toISOString()) };
}

function environmentGuard(ctx: ConsentContext): string | null {
  if (!ctx.stdinIsTTY) return 'stdin is not a TTY';
  if (!ctx.stdoutIsTTY) return 'stdout is not a TTY';
  if (nonEmptyEnv(ctx.env.CODEX_THREAD_ID)) return 'CODEX_THREAD_ID is set';
  if (nonEmptyEnv(ctx.env.CI)) return 'CI is set';
  const flags = new Set(ctx.argv);
  for (const flag of QUICK_FLAGS) if (flags.has(flag)) return `${flag} refuses activation consent`;
  for (const flag of NO_INTERACTIVE_FLAGS) if (flags.has(flag)) return `${flag} refuses activation consent`;
  return null;
}

function nonEmptyEnv(value: string | undefined): boolean {
  return typeof value === 'string' && value.length > 0;
}

// ============================================================================
// Observation (bounded reads only)
// ============================================================================

const PLUGIN_LIST_TIMEOUT_MS = 5_000;
const PLUGIN_LIST_MAX_BYTES = 64 * 1024;

export interface ObserveOptions {
  genieHome?: string;
  codexHome?: string;
  /** Injected command runner (defaults to the bounded worker runner). */
  runner?: CommandRunner;
  /** Resolved codex executable; when null the query is reported as failed. */
  command?: string | null;
  /** TEST-ONLY canonical payload root override; production refuses caller/env roots. */
  canonicalRoot?: string;
  allowRootOverride?: boolean;
  now?: () => Date;
}

/** Perform every bounded read and assemble a `CodexActivationSnapshot`; never mutates. */
export function observeCodexActivation(options: ObserveOptions = {}): CodexActivationSnapshot {
  const genieHome = options.genieHome ?? resolveGenieHome();
  const codexHome = options.codexHome ?? resolveCodexDir();
  const now = options.now ?? (() => new Date());
  const canonical = observeCanonical(options);
  const familyDir = codexPluginFamilyDir(codexHome);
  const before = witnessFamily(familyDir);
  const query = observePluginQuery(options);
  const after = witnessFamily(familyDir);
  const cache = observeCache(query, codexHome);
  const receipt = observeReceipt(genieHome);
  const delivery = observeDelivery(genieHome);
  const receiptConsumed = receipt.status === 'present' && isReceiptConsumed(genieHome, receipt.receipt.receiptId);
  const intent = observeIntent(genieHome);
  return {
    canonical,
    query,
    cache,
    receipt,
    delivery,
    intent,
    receiptConsumed,
    observationWitness: { before, after },
    observedAt: now().toISOString(),
  };
}

function observeCanonical(options: ObserveOptions): CanonicalFact {
  const rootResult = resolveCanonicalRoot(options);
  if ('error' in rootResult) return { status: 'error', detail: rootResult.error };
  const payloadDir = join(rootResult.root, 'plugins', 'genie');
  const tree = scanPhysicalTree(payloadDir);
  if (tree.status !== 'ok') return { status: 'error', detail: tree.detail ?? `payload ${tree.status}` };
  const version = parseReleaseVersion(readTrimmed(join(rootResult.root, 'VERSION')));
  if (version === null) return { status: 'error', detail: 'canonical VERSION is missing or fails the release grammar' };
  return { status: 'ok', version, digest: tree.digest ?? '', identity: tree.identity ?? '' };
}

/**
 * Resolve the canonical payload root. Production refuses `GENIE_BUNDLE_ROOT` and
 * explicit overrides so a caller cannot point the trusted digest anchor at a
 * hostile tree; only `allowRootOverride` (tests) honors `canonicalRoot`.
 */
function resolveCanonicalRoot(options: ObserveOptions): { root: string } | { error: string } {
  if (options.canonicalRoot) {
    if (!options.allowRootOverride) return { error: 'explicit canonical root override is rejected in production' };
    return { root: resolve(options.canonicalRoot) };
  }
  if (!options.allowRootOverride && process.env.GENIE_BUNDLE_ROOT) {
    return { error: 'GENIE_BUNDLE_ROOT is rejected as a canonical activation root' };
  }
  const genieHome = options.genieHome ?? resolveGenieHome();
  const candidates = [genieHome, join(genieHome, 'bin')];
  const root = candidates.find((candidate) => existsDir(join(candidate, 'plugins', 'genie')));
  return root ? { root } : { error: 'canonical plugin payload root not found under GENIE_HOME' };
}

/** Run `codex plugin list --json` bounded to 5s / 64 KiB with a fully validated single JSON value. */
function observePluginQuery(options: ObserveOptions): QueryFact {
  if (!options.command) return { status: 'failed', detail: 'codex CLI not found' };
  const runner = options.runner ?? runBoundedIntegrationCommand;
  const result = runner(options.command, ['plugin', 'list', '--json'], {
    timeoutMs: PLUGIN_LIST_TIMEOUT_MS,
    maxOutputBytes: PLUGIN_LIST_MAX_BYTES,
  });
  if (result.timedOut) return { status: 'failed', detail: 'codex plugin list timed out' };
  if (result.outputOverflow) return { status: 'failed', detail: 'codex plugin list exceeded the output cap' };
  if (result.exitCode !== 0) return { status: 'failed', detail: `codex plugin list exited ${result.exitCode}` };
  if (stripControl(result.stderr).trim().length > 0) {
    return { status: 'failed', detail: 'codex plugin list wrote to stderr' };
  }
  return parsePluginList(result.stdout);
}

/** Require exactly one schema-valid JSON value after control-sequence sanitisation. */
function parsePluginList(rawStdout: string): QueryFact {
  const sanitized = stripControl(rawStdout).trim();
  const single = singleJsonValue(sanitized);
  if (!single.ok) return { status: 'failed', detail: single.detail };
  const parsed = parseCodexPluginState(JSON.stringify(single.value));
  if (!parsed.ok) return { status: 'failed', detail: parsed.detail };
  if (!parsed.state.installed) return { status: 'ok', registration: { present: false } };
  const version = parseReleaseVersion(parsed.state.version);
  if (version === null) {
    return {
      status: 'ok',
      registration: {
        present: true,
        enabled: parsed.state.enabled ?? false,
        version: null,
        rawVersion: parsed.state.version ?? null,
      },
    };
  }
  return { status: 'ok', registration: { present: true, enabled: parsed.state.enabled ?? false, version } };
}

function singleJsonValue(text: string): { ok: true; value: unknown } | { ok: false; detail: string } {
  if (text.length === 0) return { ok: false, detail: 'empty plugin list output' };
  try {
    const value = JSON.parse(text);
    return { ok: true, value };
  } catch {
    // A second trailing JSON value (e.g. two concatenated objects) fails whole-string parse.
    return { ok: false, detail: 'plugin list output was not exactly one JSON value' };
  }
}

function observeCache(query: QueryFact, codexHome: string): PhysicalCacheFact {
  if (query.status !== 'ok' || !query.registration.present || query.registration.version === null) {
    return { kind: 'not-applicable' };
  }
  const familyDir = codexPluginFamilyDir(codexHome);
  const generationDir = join(familyDir, query.registration.version.canonical);
  if (!withinExpectedCacheRoot(generationDir, familyDir)) {
    return { kind: 'unsafe', detail: 'cache generation escapes the expected Codex cache root' };
  }
  const tree = scanPhysicalTree(generationDir);
  if (tree.status === 'absent') return { kind: 'absent' };
  if (tree.status === 'symlink') return { kind: 'unsafe-symlink', detail: tree.detail ?? 'cache contains a symlink' };
  if (tree.status === 'unsafe') return { kind: 'unsafe', detail: tree.detail ?? 'cache topology is unsafe' };
  return { kind: 'present', digest: tree.digest ?? '', identity: tree.identity ?? '' };
}

function withinExpectedCacheRoot(generationDir: string, familyDir: string): boolean {
  const realFamily = safeRealpath(familyDir);
  const realParent = safeRealpath(dirnameOf(generationDir));
  if (realFamily === null || realParent === null) return true; // absent yet — scan will report it
  const rel = relative(realFamily, realParent);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function codexPluginFamilyDir(codexHome: string): string {
  return join(codexHome, 'plugins', 'cache', 'automagik', 'genie');
}

// ============================================================================
// Durable-state observation helpers
// ============================================================================

function refreshIntentPath(genieHome: string): string {
  return join(genieHome, '.codex-plugin-refresh-intent.json');
}
function downgradeReceiptPath(genieHome: string): string {
  return join(genieHome, '.codex-plugin-downgrade-receipt.json');
}
function deliveryRecordPath(genieHome: string): string {
  return join(genieHome, '.codex-plugin-delivery-record.json');
}
function receiptTombstonePath(genieHome: string): string {
  return join(genieHome, '.codex-plugin-receipt-tombstone.json');
}

function observeIntent(genieHome: string): IntentFact {
  const read = readBoundedRegularFile(refreshIntentPath(genieHome), MAX_INTENT_BYTES);
  if (read.status === 'absent') return { status: 'absent' };
  if (read.status === 'oversized') return { status: 'oversized', size: read.size };
  if (read.status === 'symlink') return { status: 'unsafe', detail: 'intent path is a symlink' };
  if (read.status === 'non-regular') return { status: 'unsafe', detail: 'intent path is not a regular file' };
  if (read.status === 'unreadable') return { status: 'unsafe', detail: `intent unreadable: ${read.detail}` };
  const contentSha256 = sha256Hex(read.content);
  const intent = parseRefreshIntentStructure(read.content);
  if (intent === null) return { status: 'corrupt', contentSha256, detail: 'intent failed schema-1 validation' };
  return { status: 'valid', intent, contentSha256 };
}

function observeReceipt(genieHome: string): ReceiptFact {
  const read = readBoundedRegularFile(downgradeReceiptPath(genieHome), MAX_RECEIPT_BYTES);
  if (read.status === 'absent') return { status: 'absent' };
  if (read.status !== 'ok') return { status: 'invalid', detail: `receipt ${read.status}` };
  const receipt = parseDowngradeReceiptStructure(read.content);
  return receipt ? { status: 'present', receipt } : { status: 'invalid', detail: 'receipt failed schema-1 validation' };
}

function observeDelivery(genieHome: string): DeliveryFact {
  const read = readBoundedRegularFile(deliveryRecordPath(genieHome), MAX_DELIVERY_BYTES);
  if (read.status === 'absent') return { status: 'absent' };
  if (read.status !== 'ok') return { status: 'invalid', detail: `delivery ${read.status}` };
  const record = parseDeliveryRecordStructure(read.content);
  return record ? { status: 'present', record } : { status: 'invalid', detail: 'delivery failed schema-1 validation' };
}

function isReceiptConsumed(genieHome: string, receiptId: string): boolean {
  const read = readBoundedRegularFile(receiptTombstonePath(genieHome), MAX_DELIVERY_BYTES);
  if (read.status !== 'ok') return false;
  const tombstone = parseReceiptTombstoneStructure(read.content);
  return tombstone !== null && tombstone.receiptId === receiptId;
}

// ============================================================================
// Physical-tree scanning (symlink-rejecting, bounded)
// ============================================================================

/**
 * Symlink-rejecting SHA-256 over a physical directory tree, plus the root's
 * `dev:ino` identity. Any symlink inside the required payload is unsafe; a
 * non-directory root or unreadable tree is unsafe rather than silently skipped.
 */
export function scanPhysicalTree(root: string): PhysicalTreeReport {
  let rootStat: Stats;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'unsafe', detail: `root unreadable: ${errorText(error)}` };
  }
  if (rootStat.isSymbolicLink()) return { status: 'symlink', detail: 'root is a symlink' };
  if (!rootStat.isDirectory()) return { status: 'unsafe', detail: 'root is not a directory' };
  const entries: string[] = [];
  const symlink = collectTreeEntries(root, root, entries);
  if (symlink) return { status: 'symlink', detail: symlink };
  const digest = createHash('sha256');
  digest.update('genie-codex-activation-tree-v1\0');
  for (const line of entries.sort()) digest.update(line);
  return { status: 'ok', digest: digest.digest('hex'), identity: `${rootStat.dev}:${rootStat.ino}` };
}

/** Returns a symlink-detail string on the first symlink, else null (tree fully scanned). */
function collectTreeEntries(root: string, current: string, out: string[]): string | null {
  let names: string[];
  try {
    names = readdirSync(current).sort();
  } catch (error) {
    out.push(`ERR\0${relative(root, current)}\0${errorText(error)}\0`);
    return null;
  }
  for (const name of names) {
    const abs = join(current, name);
    const rel = relative(root, abs).split(sep).join('/');
    let stat: Stats;
    try {
      stat = lstatSync(abs);
    } catch (error) {
      out.push(`ERR\0${rel}\0${errorText(error)}\0`);
      continue;
    }
    if (stat.isSymbolicLink()) return `symlink at ${rel}`;
    if (stat.isDirectory()) {
      out.push(`D\0${rel}\0`);
      const nested = collectTreeEntries(root, abs, out);
      if (nested) return nested;
    } else if (stat.isFile()) {
      out.push(`F\0${rel}\0${(stat.mode & 0o111) !== 0 ? 'x' : '-'}\0${hashFileBounded(abs)}\0`);
    } else {
      out.push(`O\0${rel}\0`);
    }
  }
  return null;
}

/** A cheap shallow witness of the cache family so the query can be proven inert. */
function witnessFamily(familyDir: string): FamilyWitness {
  let stat: Stats;
  try {
    stat = lstatSync(familyDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'unsafe', detail: `family unreadable: ${errorText(error)}` };
  }
  if (stat.isSymbolicLink()) return { status: 'unsafe', detail: 'family is a symlink' };
  if (!stat.isDirectory()) return { status: 'unsafe', detail: 'family is not a directory' };
  const digest = createHash('sha256');
  digest.update('genie-codex-cache-family-v1\0');
  try {
    for (const name of readdirSync(familyDir).sort()) {
      const child = lstatSync(join(familyDir, name));
      digest.update(`${name}\0${familyKind(child)}\0`);
    }
  } catch (error) {
    return { status: 'unsafe', detail: `family listing failed: ${errorText(error)}` };
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
// Projections + result trailer
// ============================================================================

export interface IntegrationSummaryEnvelope {
  schemaVersion: 1;
  codexPlugin: CodexPluginIntegrationSummary;
}

export interface CodexPluginIntegrationSummary {
  state: string;
  installedVersion: string | null;
  targetVersion: string | null;
  direction: ActivationDirection | null;
  registration: 'present' | 'absent' | 'invalid' | 'unknown';
  cache: CacheProjection;
  intentPhase: IntentPhase | null;
  mutationAuthority: MutationAuthority;
  authorization: { result: AuthorizationResult['result']; reason: string | null };
  actionRequired: boolean;
  deliveryComplete: boolean;
  recovery: string;
}

export function projectIntegrationSummary(
  state: CodexActivationState,
  snapshot: CodexActivationSnapshot,
  authorization: AuthorizationResult,
  deliveryComplete: boolean,
): IntegrationSummaryEnvelope {
  const descriptor = describeState(state);
  const installed = installedVersionOf(snapshot);
  const target = snapshot.canonical.status === 'ok' ? snapshot.canonical.version.canonical : null;
  return {
    schemaVersion: 1,
    codexPlugin: {
      state: descriptor.machineCode,
      installedVersion: installed,
      targetVersion: target,
      direction: directionOf(installed, target),
      registration: registrationProjection(snapshot),
      cache: projectCache(snapshot),
      intentPhase: intentPhaseOf(snapshot),
      mutationAuthority: descriptor.authority,
      authorization: { result: authorization.result, reason: authorizationReason(authorization) },
      actionRequired: descriptor.actionRequired,
      deliveryComplete,
      recovery: descriptor.recovery,
    },
  };
}

function installedVersionOf(snapshot: CodexActivationSnapshot): string | null {
  const registration = registrationOf(snapshot);
  return registration.present && registration.version ? registration.version.canonical : null;
}

function directionOf(installed: string | null, target: string | null): ActivationDirection | null {
  const from = parseReleaseVersion(installed);
  const to = parseReleaseVersion(target);
  if (to === null) return null;
  return deriveDirection(from, to);
}

function registrationProjection(snapshot: CodexActivationSnapshot): 'present' | 'absent' | 'invalid' | 'unknown' {
  if (snapshot.query.status !== 'ok') return 'unknown';
  const registration = registrationOf(snapshot);
  if (!registration.present) return 'absent';
  return registration.version === null ? 'invalid' : 'present';
}

function projectCache(snapshot: CodexActivationSnapshot): CacheProjection {
  const cache = snapshot.cache;
  if (cache.kind === 'not-applicable') return 'unknown';
  if (cache.kind === 'absent') return 'missing';
  if (cache.kind === 'unsafe-symlink') return 'unsafe-symlink';
  if (cache.kind === 'unsafe') return 'unsafe';
  const canonical = snapshot.canonical;
  if (canonical.status !== 'ok') return 'present-unverified';
  if (cache.digest === canonical.digest) return 'verified-current';
  const registration = registrationOf(snapshot);
  if (
    registration.present &&
    registration.version &&
    compareReleaseVersions(registration.version, canonical.version) === 0
  ) {
    return 'mismatch';
  }
  return 'present-unverified';
}

function intentPhaseOf(snapshot: CodexActivationSnapshot): IntentPhase | null {
  return snapshot.intent.status === 'valid' ? snapshot.intent.intent.phase : null;
}

function authorizationReason(authorization: AuthorizationResult): string | null {
  if (authorization.result === 'required' || authorization.result === 'refused') return authorization.reason;
  return null;
}

export interface ActivationResultTrailer {
  schemaVersion: 1;
  code: string;
  deliveryComplete: boolean;
  retry: boolean;
  nextAction: string;
}

/** The single canonical serializer for the exit-2 result trailer Groups C and D consume. */
export function serializeActivationResultTrailer(trailer: ActivationResultTrailer): string {
  return JSON.stringify({
    schemaVersion: 1,
    code: trailer.code,
    deliveryComplete: trailer.deliveryComplete,
    retry: trailer.retry,
    nextAction: trailer.nextAction,
  });
}

export function buildActivationResultTrailer(
  state: CodexActivationState,
  deliveryComplete: boolean,
): ActivationResultTrailer {
  const descriptor = describeState(state);
  return {
    schemaVersion: 1,
    code: descriptor.machineCode,
    deliveryComplete,
    retry: descriptor.exit === 1,
    nextAction: descriptor.recovery,
  };
}

export interface HumanProjection {
  stream: 'stdout' | 'stderr';
  exitCode: 0 | 1 | 2;
  text: string;
}

/** Normal/current/pending status goes to stdout; broken diagnostics go to stderr with no all-green footer. */
export function projectHumanStatus(state: CodexActivationState, snapshot: CodexActivationSnapshot): HumanProjection {
  const descriptor = describeState(state);
  const installed = installedVersionOf(snapshot) ?? 'absent';
  const target = snapshot.canonical.status === 'ok' ? snapshot.canonical.version.canonical : 'unknown';
  const stream: 'stdout' | 'stderr' = descriptor.exit === 1 ? 'stderr' : 'stdout';
  const text = `Codex plugin: ${descriptor.machineCode} (installed=${installed}, target=${target})\n${descriptor.recovery}`;
  return { stream, exitCode: descriptor.exit, text };
}

/** Setup refusal exits 2 even for a state whose ordinary doctor exit is 1. */
export function resolveSetupExitCode(state: CodexActivationState, authorization: AuthorizationResult): 0 | 1 | 2 {
  const base = describeState(state).exit;
  if ((authorization.result === 'required' || authorization.result === 'refused') && base === 1) return 2;
  return base;
}

// ============================================================================
// The deep protocol/attestation store
// ============================================================================

export interface CodexActivationStoreOptions extends ObserveOptions {
  genieHome?: string;
}

export interface PublishDeliveryInput {
  targetVersion: string;
  canonicalPayloadSha256: string;
  channel: string;
  /** Present only for an explicit channel downgrade; writes the matching receipt. */
  downgradeFrom?: string;
  deliveryId?: string;
  now?: () => Date;
}

export interface DeliveryRootOps {
  inventoryDigest(): string;
  deliveredVersion(): string;
}

export type BeginActivationResult =
  | { status: 'started'; handle: ActivationHandle }
  | { status: 'stale'; mismatchField: keyof ActivationRequestFingerprint; detail: string }
  | { status: 'refused'; reason: string };

export interface ActivationHandle {
  operationId: string;
  refreshIntentId: string;
  intentPath: string;
  direction: ActivationDirection;
  receiptId: string | null;
}

export interface CodexActivationStore {
  observe(): CodexActivationSnapshot;
  publishDelivery(lease: HeldLifecycleLease, input: PublishDeliveryInput): DeliveryRecord;
  withRevalidatedDeliveryRoot<T>(lease: HeldLifecycleLease, callback: (ops: DeliveryRootOps) => T): T;
  beginActivation(lease: HeldLifecycleLease, permit: ActivationPermit): BeginActivationResult;
  advanceIntentPhase(
    lease: HeldLifecycleLease,
    handle: ActivationHandle,
    phase: IntentPhase,
    lastFailure?: string,
  ): void;
  finalizeActivation(lease: HeldLifecycleLease, handle: ActivationHandle): void;
  quarantineIntent(
    lease: HeldLifecycleLease,
    permit: ActivationPermit,
  ): { quarantinedTo: string } | { skipped: string };
}

/** Open the deep store. Raw state/root paths stay captured in this closure and are never returned. */
export function openCodexActivationStore(options: CodexActivationStoreOptions = {}): CodexActivationStore {
  const genieHome = options.genieHome ?? resolveGenieHome();
  const intentPath = refreshIntentPath(genieHome);
  const receiptPath = downgradeReceiptPath(genieHome);
  const deliveryPath = deliveryRecordPath(genieHome);
  const tombstonePath = receiptTombstonePath(genieHome);
  const observeOptions: ObserveOptions = { ...options, genieHome };

  const observe = (): CodexActivationSnapshot => observeCodexActivation(observeOptions);

  return {
    observe,
    publishDelivery(lease, input) {
      lease.assertOperation(lease.operationId);
      return publishDeliveryImpl(deliveryPath, receiptPath, input);
    },
    withRevalidatedDeliveryRoot(lease, callback) {
      lease.assertOperation(lease.operationId);
      return withRevalidatedDeliveryRootImpl(observeOptions, deliveryPath, callback);
    },
    beginActivation(lease, permit) {
      return beginActivationImpl(lease, permit, observe, intentPath);
    },
    advanceIntentPhase(lease, handle, phase, lastFailure) {
      advanceIntentPhaseImpl(lease, handle, phase, lastFailure ?? '', intentPath);
    },
    finalizeActivation(lease, handle) {
      finalizeActivationImpl(lease, handle, intentPath, receiptPath, tombstonePath);
    },
    quarantineIntent(lease, permit) {
      return quarantineIntentImpl(lease, permit, intentPath);
    },
  };
}

function publishDeliveryImpl(deliveryPath: string, receiptPath: string, input: PublishDeliveryInput): DeliveryRecord {
  const now = input.now ?? (() => new Date());
  const deliveryId = input.deliveryId ?? mint128();
  if (input.deliveryId !== undefined && !HEX_128_RE.test(input.deliveryId)) {
    throw new Error('deliveryId must be 32 lowercase hex characters');
  }
  const record: DeliveryRecord = {
    schemaVersion: 1,
    deliveryId,
    targetVersion: input.targetVersion,
    canonicalPayloadSha256: input.canonicalPayloadSha256,
    channel: input.channel,
    deliveredAt: now().toISOString(),
  };
  if (input.downgradeFrom !== undefined) {
    const from = parseReleaseVersion(input.downgradeFrom);
    const target = parseReleaseVersion(input.targetVersion);
    if (from === null || target === null || compareReleaseVersions(from, target) <= 0) {
      throw new Error('downgrade delivery requires from > target with valid release versions');
    }
    const receipt: DowngradeReceipt = {
      schemaVersion: 1,
      receiptId: deliveryId,
      fromPluginVersion: input.downgradeFrom,
      targetVersion: input.targetVersion,
      canonicalPayloadSha256: input.canonicalPayloadSha256,
      channel: input.channel,
    };
    atomicWriteFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { backup: true });
  } else {
    // Any other successful delivery removes a stale downgrade receipt.
    unlinkWithParentFsync(receiptPath);
  }
  atomicWriteFileSync(deliveryPath, `${JSON.stringify(record, null, 2)}\n`, { backup: true });
  return record;
}

function withRevalidatedDeliveryRootImpl<T>(
  observeOptions: ObserveOptions,
  deliveryPath: string,
  callback: (ops: DeliveryRootOps) => T,
): T {
  const rootResult = resolveCanonicalRoot(observeOptions);
  if ('error' in rootResult) throw new Error(`delivery root revalidation failed: ${rootResult.error}`);
  const payloadDir = join(rootResult.root, 'plugins', 'genie');
  const tree = scanPhysicalTree(payloadDir);
  if (tree.status !== 'ok') throw new Error(`delivery payload is not a safe physical tree: ${tree.status}`);
  const version = parseReleaseVersion(readTrimmed(join(rootResult.root, 'VERSION')));
  if (version === null) throw new Error('delivery root VERSION fails the release grammar');
  const deliveryRead = readBoundedRegularFile(deliveryPath, MAX_DELIVERY_BYTES);
  if (deliveryRead.status !== 'ok') throw new Error(`delivery record is not readable: ${deliveryRead.status}`);
  const record = parseDeliveryRecordStructure(deliveryRead.content);
  if (record === null) throw new Error('delivery record failed schema-1 validation');
  if (record.canonicalPayloadSha256 !== tree.digest) throw new Error('delivery digest no longer matches the payload');
  if (record.targetVersion !== version.canonical) throw new Error('delivery version no longer matches the payload');

  let live = true;
  const ops: DeliveryRootOps = {
    inventoryDigest(): string {
      if (!live) throw new Error('delivery root capability used after the callback returned');
      return tree.digest ?? '';
    },
    deliveredVersion(): string {
      if (!live) throw new Error('delivery root capability used after the callback returned');
      return version.canonical;
    },
  };
  try {
    return callback(ops);
  } finally {
    live = false;
  }
}

function beginActivationImpl(
  lease: HeldLifecycleLease,
  permit: ActivationPermit,
  observe: () => CodexActivationSnapshot,
  intentPath: string,
): BeginActivationResult {
  if (!MINTED_PERMITS.has(permit)) return { status: 'refused', reason: 'permit is not a genuine activation permit' };
  if (permit.capability !== 'activation') return { status: 'refused', reason: 'permit lacks activation capability' };
  const snapshot = observe();
  const fresh = computeActivationFingerprint(snapshot);
  const mismatch = firstFingerprintMismatch(permit.fingerprint, fresh);
  if (mismatch !== null) {
    return { status: 'stale', mismatchField: mismatch, detail: `fingerprint field ${mismatch} changed since consent` };
  }
  const state = classifyCodexActivation(snapshot);
  const plan = planIntentFromState(state, snapshot, lease.operationId);
  if ('refused' in plan) return { status: 'refused', reason: plan.refused };
  lease.assertOperation(lease.operationId);
  atomicWriteFileSync(intentPath, `${JSON.stringify(plan.intent, null, 2)}\n`, { backup: true });
  return {
    status: 'started',
    handle: {
      operationId: lease.operationId,
      refreshIntentId: plan.intent.refreshIntentId,
      intentPath,
      direction: plan.intent.direction,
      receiptId: plan.intent.receiptId,
    },
  };
}

function planIntentFromState(
  state: CodexActivationState,
  snapshot: CodexActivationSnapshot,
  operationId: string,
): { intent: RefreshIntent } | { refused: string } {
  if (snapshot.canonical.status !== 'ok') return { refused: 'canonical target unavailable' };
  const registration = registrationOf(snapshot);
  const from = registration.present && registration.version ? registration.version : null;
  const target = snapshot.canonical.version;
  const direction = deriveDirection(from, target);
  const receiptId =
    direction === 'downgrade' && snapshot.receipt.status === 'present' ? snapshot.receipt.receipt.receiptId : null;
  if (direction === 'downgrade' && receiptId === null) return { refused: 'downgrade requires a matching receipt' };
  if (!ACTIVATION_ELIGIBLE.has(state.kind))
    return { refused: `state ${state.kind} does not authorize a new activation transaction` };
  const intent: RefreshIntent = {
    schemaVersion: 1,
    refreshIntentId: mint128(),
    operationId,
    fromPluginVersion: from ? from.canonical : null,
    targetVersion: target.canonical,
    direction,
    priorEnabled: registration.present ? registration.enabled : false,
    canonicalPayloadSha256: snapshot.canonical.digest,
    phase: 'planned',
    commandKind: 'codex-plugin-add',
    lastFailure: '',
    receiptId,
  };
  return { intent };
}

/** States for which `beginActivation` may open a fresh (planned) transaction. */
const ACTIVATION_ELIGIBLE: ReadonlySet<CodexActivationState['kind']> = new Set<CodexActivationState['kind']>([
  'activation-pending',
  'pending-downgrade-explicit',
  'registration-absent',
  'intent-planned',
  'intent-target-current',
]);

function advanceIntentPhaseImpl(
  lease: HeldLifecycleLease,
  handle: ActivationHandle,
  phase: IntentPhase,
  lastFailure: string,
  intentPath: string,
): void {
  lease.assertOperation(handle.operationId);
  const read = readBoundedRegularFile(intentPath, MAX_INTENT_BYTES);
  if (read.status !== 'ok') throw new Error(`cannot advance a missing/unsafe intent: ${read.status}`);
  const intent = parseRefreshIntentStructure(read.content);
  if (intent === null) throw new Error('cannot advance an intent that fails schema-1 validation');
  if (intent.operationId !== handle.operationId || intent.refreshIntentId !== handle.refreshIntentId) {
    throw new LifecycleFencingError('intent operation/id does not match the activation handle');
  }
  const next: RefreshIntent = { ...intent, phase, lastFailure: lastFailure.slice(0, MAX_FAILURE_TEXT) };
  atomicWriteFileSync(intentPath, `${JSON.stringify(next, null, 2)}\n`, { backup: true });
}

function finalizeActivationImpl(
  lease: HeldLifecycleLease,
  handle: ActivationHandle,
  intentPath: string,
  receiptPath: string,
  tombstonePath: string,
): void {
  lease.assertOperation(handle.operationId);
  // Delete the intent first; a crash before the receipt delete leaves an inert
  // receipt that `current` ignores and the next delivery removes.
  unlinkWithParentFsync(intentPath);
  if (handle.receiptId !== null) {
    const tombstone: ReceiptTombstone = {
      schemaVersion: 1,
      receiptId: handle.receiptId,
      consumedAt: new Date().toISOString(),
      operationId: handle.operationId,
    };
    atomicWriteFileSync(tombstonePath, `${JSON.stringify(tombstone, null, 2)}\n`, { backup: true });
    unlinkWithParentFsync(receiptPath);
  }
}

function quarantineIntentImpl(
  lease: HeldLifecycleLease,
  permit: ActivationPermit,
  intentPath: string,
): { quarantinedTo: string } | { skipped: string } {
  if (!MINTED_PERMITS.has(permit) || permit.capability !== 'journal-quarantine') {
    return { skipped: 'a genuine journal-quarantine permit is required' };
  }
  lease.assertOperation(lease.operationId);
  const read = readBoundedRegularFile(intentPath, MAX_INTENT_BYTES);
  if (read.status === 'symlink' || read.status === 'non-regular') {
    return { skipped: `unsafe intent path is not quarantined (${read.status})` };
  }
  if (read.status === 'oversized') {
    const target = `${intentPath}.invalid-oversized-${mint128()}`;
    const moved = renameNonOverwriting(intentPath, target);
    return { quarantinedTo: moved.path };
  }
  if (read.status !== 'ok') return { skipped: `intent not present to quarantine (${read.status})` };
  const target = `${intentPath}.invalid-${sha256Hex(read.content)}`;
  const moved = renameNonOverwriting(intentPath, target);
  return { quarantinedTo: moved.path };
}

// ============================================================================
// Small utilities
// ============================================================================

function mint128(): string {
  return randomBytes(16).toString('hex');
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Strip ANSI CSI and OSC control sequences from modeled diagnostics/output. */
export function stripControl(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ESC/BEL control bytes.
  return text.replace(/\][^]*(?:|\\)/g, '').replace(/\[[0-9;?]*[ -\/]*[@-~]/g, '');
}

function safeJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHex128(value: unknown): value is string {
  return typeof value === 'string' && HEX_128_RE.test(value);
}

function isHex256(value: unknown): value is string {
  return typeof value === 'string' && HEX_256_RE.test(value);
}

function isDirection(value: unknown): value is ActivationDirection {
  return value === 'install' || value === 'upgrade' || value === 'downgrade' || value === 'repair';
}

function readTrimmed(path: string): string | null {
  const read = readBoundedRegularFile(path, 4096);
  return read.status === 'ok' ? read.content.trim() || null : null;
}

function existsDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function dirnameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx <= 0 ? path : path.slice(0, idx);
}

function hashFileBounded(path: string): string {
  const digest = createHash('sha256');
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    return `unreadable:${errorText(error)}`;
  }
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      digest.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
