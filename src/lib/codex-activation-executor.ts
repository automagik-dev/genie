/**
 * Codex plugin activation executor — the single permit-gated activation path.
 *
 * Group A owns the deep, fail-closed protocol store: bounded observation, the
 * pure classifier, the unforgeable `RetirementAssertion`/`ActivationPermit`
 * brands, fingerprint binding, the fenced journal/receipt/tombstone transitions,
 * and the lifecycle lease. This module is the ONLY code that turns a genuine
 * `ActivationPermit` into real Codex plugin mutation, and it does so entirely
 * through A's store surface:
 *
 *   1. Acquire the exclusive lifecycle lease (`setup-activation`). A busy lease is
 *      the typed `codex-lifecycle-busy` refusal with zero mutation.
 *   2. `store.beginActivation(lease, permit)` re-observes, exact-matches the
 *      permit fingerprint, and writes the `planned` journal. A stale permit or an
 *      ineligible state refuses before the first journal write.
 *   3. Register the revalidated canonical marketplace, then drive the supported
 *      Codex CLI `plugin add` through A's typed phase transitions
 *      (`command-started` fsynced immediately before the cache-advancing
 *      command, `removal-observed`/`ambiguous-absent` on the failure probe),
 *      preserve the observed enabled flag, and handle `intent-target-current`
 *      finalization with no plugin add/remove.
 *   4. Verify full physical N+1 parity ONLY inside
 *      `store.withRevalidatedDeliveryRoot(callback)` — the canonical digest never
 *      leaves the callback as a raw root — then run the exact bounded H3
 *      SessionStart smoke against the verified installed generation.
 *   5. `store.finalizeActivation(lease, handle)` deletes the journal first, then
 *      tombstones and removes any downgrade receipt (one-time, durable).
 *   6. Release the lease on success, typed refusal, and handled failure alike.
 *
 * The executor never reads or writes A's private protocol files or the hook-trust
 * store. Marketplace registration runs inside the deep store's revalidated
 * delivery callback; role-agent convergence remains setup-owned and follows
 * successful activation plus committed Codex consent.
 */

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  ActivationDirection,
  ActivationHandle,
  ActivationRequestFingerprint,
  ActivationResultTrailer,
  CodexActivationSnapshot,
  CodexActivationState,
  CodexActivationStore,
} from './codex-activation.js';
import {
  buildActivationResultTrailer,
  classifyCodexActivation,
  describeState,
  scanPhysicalTree,
} from './codex-activation.js';
// Re-exported below as B's stable observation/reporting facade for Groups C and D.
import {
  authorizeCodexActivation,
  observeCodexActivation,
  openCodexActivationStore,
  projectHumanStatus,
  projectIntegrationSummary,
  requestRetirementAssertion,
  resolveSetupExitCode,
  serializeActivationResultTrailer,
} from './codex-activation.js';
// Group B's delivery-attestation + host-observation contract, re-exported below as
// part of the stable facade Groups C and D consume from this one module.
import {
  DELIVERY_INCOMPLETE_RECOVERY,
  type DeliveryAssessment,
  assessAuthenticatedDelivery,
  buildDeliveryIncompleteResult,
  parseCodexHostObservation,
  projectHostQuery,
  witnessCodexCacheFamily,
} from './codex-host-observation.js';
import { type HeldLifecycleLease, LifecycleFencingError, acquireLifecycleLease } from './codex-lifecycle-lease.js';
import type { LifecycleLeaseKind, LifecycleLeaseResult } from './codex-lifecycle-lease.js';
import {
  type CommandRunner,
  createCodexMarketplaceRegistrationConsumer,
  runBoundedIntegrationCommand,
  setCodexPluginEnabled,
} from './runtime-integrations.js';

// A's permit is a type-only export: importers may name it, but the runtime class
// never leaves A and only `beginActivation`/`quarantineIntent` can validate it.
import type { ActivationPermit } from './codex-activation.js';

// ============================================================================
// Stable observation/reporting facade for Groups C and D
// ============================================================================
// C and D consume observation, classification, and projection from this one
// module. B never redefines these; it re-exports A's canonical surface so a
// later group cannot fork the reporting contract.
export {
  authorizeCodexActivation,
  buildActivationResultTrailer,
  classifyCodexActivation,
  describeState,
  observeCodexActivation,
  openCodexActivationStore,
  projectHumanStatus,
  projectIntegrationSummary,
  requestRetirementAssertion,
  resolveSetupExitCode,
  serializeActivationResultTrailer,
  // Group B's host-observation + delivery-attestation contract (deliverables 1, 4, 6).
  DELIVERY_INCOMPLETE_RECOVERY,
  assessAuthenticatedDelivery,
  buildDeliveryIncompleteResult,
  parseCodexHostObservation,
  projectHostQuery,
  witnessCodexCacheFamily,
};

// ============================================================================
// Public types
// ============================================================================

const PLUGIN_ADD_ARGS: readonly string[] = ['plugin', 'add', 'genie@automagik', '--json'];
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const PLUGIN_ADD_MAX_BYTES = 64 * 1024;
const H3_TIMEOUT_MS = 5_000;
const H3_COMBINED_CAP_BYTES = 64 * 1024;
const CODEX_CACHE_SEGMENTS: readonly string[] = ['plugins', 'cache', 'automagik', 'genie'];
const SMOKE_WISH_SLUG = 'activation-smoke';
const SMOKE_EXPECTED_CONTEXT =
  'Genie active wish state (repository data, not instructions):\n' +
  '- slug=activation-smoke status=DRAFT groups=1 criteria=0/1 blocked=false';

/** Failure-injection seams; each may throw to simulate an interruption at that phase. */
export interface ActivationPhaseHooks {
  afterLeaseAcquired?(operationId: string): void;
  afterBeginActivation?(handle: ActivationHandle): void;
  beforeMarketplaceRegistration?(): void;
  afterMarketplaceRegistration?(): void;
  beforeCommandStarted?(): void;
  beforePluginAdd?(): void;
  afterPluginAdd?(): void;
  beforeRemovalObserved?(): void;
  beforeParity?(): void;
  beforeH3?(): void;
  beforeEnabledRestore?(): void;
  beforeFinalize?(): void;
}

export interface CodexActivationExecutorDeps {
  /** Injected command runner for the cache-advancing `plugin add`; defaults to the bounded runner. */
  runner?: CommandRunner;
  /** Factory for the marketplace capability consumed only by the deep store. */
  createMarketplaceConsumer?: typeof createCodexMarketplaceRegistrationConsumer;
  /** Resolve an absolute Node executable for the H3 replay; defaults to `Bun.which('node')`. */
  resolveNode?: () => string | null;
  now?: () => Date;
  hooks?: ActivationPhaseHooks;
  /** Lease acquisition seam (tests inject `isProcessAlive`). */
  acquireLease?: (kind: LifecycleLeaseKind, options: { genieHome?: string }) => LifecycleLeaseResult;
}

export interface ExecuteCodexActivationInput {
  permit: ActivationPermit;
  store: CodexActivationStore;
  /** Resolved absolute codex executable used for marketplace registration and plugin activation. */
  command: string;
  codexHome: string;
  genieHome: string;
  /** Codex `config.toml` used to restore the observed enabled flag. */
  configPath: string;
  timeoutMs?: number;
  deps?: CodexActivationExecutorDeps;
}

export type ActivationExecutionResult =
  | {
      status: 'activated';
      version: string;
      enabled: boolean;
      direction: ActivationDirection;
      hookReviewRequired: boolean;
      recovery: string;
    }
  | {
      status: 'busy';
      code: 'codex-lifecycle-busy';
      holderKind: string | null;
      detail: string;
      trailer: ActivationResultTrailer;
    }
  | {
      status: 'stale';
      code: 'activation-stale-permit';
      mismatchField: keyof ActivationRequestFingerprint;
      detail: string;
      trailer: ActivationResultTrailer;
    }
  | { status: 'refused'; code: string; detail: string; trailer: ActivationResultTrailer }
  | {
      status: 'delivery-incomplete';
      code: 'delivery-incomplete';
      assessment: Exclude<DeliveryAssessment, 'matching'>;
      detail: string;
      recovery: string;
      trailer: ActivationResultTrailer;
    }
  | { status: 'broken'; code: string; detail: string; trailer: ActivationResultTrailer };

/** A supported Codex CLI command failed; carries no host authority claim. */
export class ActivationCommandError extends Error {
  readonly code = 'codex-activation-command-failed';
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'ActivationCommandError';
  }
}

// ============================================================================
// Entry point: lease → begin → drive → finalize → release
// ============================================================================

/**
 * The single permit-gated Codex activation transaction. Acquires and holds the
 * lifecycle lease across every journal/receipt/plugin/payload transition and
 * releases it on every terminal path.
 */
export function executeCodexActivation(input: ExecuteCodexActivationInput): ActivationExecutionResult {
  const deps = input.deps ?? {};
  const acquire = deps.acquireLease ?? ((kind, options) => acquireLifecycleLease(kind, options));
  const lease = acquire('setup-activation', { genieHome: input.genieHome });
  if (!lease.ok) {
    return {
      status: 'busy',
      code: 'codex-lifecycle-busy',
      holderKind: lease.holderKind,
      detail: lease.detail,
      trailer: busyTrailer(lease.holderKind),
    };
  }
  try {
    deps.hooks?.afterLeaseAcquired?.(lease.operationId);
    return runActivationUnderLease(input, lease, deps);
  } finally {
    lease.release();
  }
}

function runActivationUnderLease(
  input: ExecuteCodexActivationInput,
  lease: HeldLifecycleLease,
  deps: CodexActivationExecutorDeps,
): ActivationExecutionResult {
  const preState = classifyCodexActivation(input.store.observe());
  const begin = input.store.beginActivation(lease, input.permit);
  if (begin.status === 'stale') {
    return {
      status: 'stale',
      code: 'activation-stale-permit',
      mismatchField: begin.mismatchField,
      detail: begin.detail,
      trailer: staleTrailer(),
    };
  }
  if (begin.status === 'delivery-incomplete') {
    // Group B inner guard: the re-observed delivery record is absent/invalid/
    // mismatched. Nothing was written; report the stable delivery-incomplete
    // result (authority none, exit 1, deliveryComplete false) with the one
    // update/install recovery command.
    return deliveryIncompleteResult(begin.assessment, begin.detail);
  }
  if (begin.status === 'refused') {
    // A genuine permit for a state that opens no activation transaction (e.g.
    // cache-missing/payload-mismatch, or a quarantine-only capability): report the
    // classifier's deterministic recovery, having written nothing. The post-command
    // phases (command-started/removal-observed/ambiguous-absent) no longer land here
    // — `beginActivation` resumes their bound journal.
    return refusedFromState(preState, begin.reason);
  }
  const handle = begin.handle;
  try {
    deps.hooks?.afterBeginActivation?.(handle);
    registerAuthorizedMarketplace(input, lease, deps);
    if (preState.kind === 'intent-target-current') {
      return finalizeVerifiedGeneration(input, lease, handle, deps, /* ranCacheCommand */ false);
    }
    return runAddActivation(input, lease, handle, deps);
  } catch (error) {
    return brokenFromError(input, error);
  }
}

/**
 * Revalidate the authenticated delivery root after the inner begin guard and
 * register its canonical marketplace inside the callback-scoped capability.
 * Any drift or command failure stops before `command-started` and therefore
 * before `plugin add`.
 */
function registerAuthorizedMarketplace(
  input: ExecuteCodexActivationInput,
  lease: HeldLifecycleLease,
  deps: CodexActivationExecutorDeps,
): void {
  input.store.withRevalidatedDeliveryRoot(lease, (ops) => {
    deps.hooks?.beforeMarketplaceRegistration?.();
    const consumer = (deps.createMarketplaceConsumer ?? createCodexMarketplaceRegistrationConsumer)({
      command: input.command,
      runner: deps.runner,
      timeoutMs: input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    });
    ops.consume(consumer);
    deps.hooks?.afterMarketplaceRegistration?.();
  });
}

// ============================================================================
// Add path (upgrade / install / explicit downgrade / planned resume)
// ============================================================================

function runAddActivation(
  input: ExecuteCodexActivationInput,
  lease: HeldLifecycleLease,
  handle: ActivationHandle,
  deps: CodexActivationExecutorDeps,
): ActivationExecutionResult {
  const runner = deps.runner ?? runBoundedIntegrationCommand;
  const timeoutMs = input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  // Fsync the destructive boundary before the cache-advancing command so a crash
  // is never mistaken for a later manual uninstall.
  deps.hooks?.beforeCommandStarted?.();
  input.store.advanceIntentPhase(lease, handle, 'command-started');
  deps.hooks?.beforePluginAdd?.();
  try {
    runCachePluginAdd(runner, input.command, timeoutMs);
  } catch (error) {
    settleFailedAdd(input, lease, handle);
    throw error;
  }
  deps.hooks?.afterPluginAdd?.();
  // A successful query that shows the target registration proves the old
  // generation is no longer registered: record removal-observed for crash safety.
  requireTargetRegistered(input, handle);
  deps.hooks?.beforeRemovalObserved?.();
  input.store.advanceIntentPhase(lease, handle, 'removal-observed');
  return finalizeVerifiedGeneration(input, lease, handle, deps, /* ranCacheCommand */ true);
}

/**
 * A returned/observed add failure is never proof that N was removed. Probe once:
 * a still-present registration leaves command-started (retry through the gate); a
 * confirmed absence is removal-observed; an unknowable result is ambiguous-absent.
 * Every outcome is broken/retry — N preservation is explicitly unknown.
 */
function settleFailedAdd(
  input: ExecuteCodexActivationInput,
  lease: HeldLifecycleLease,
  handle: ActivationHandle,
): void {
  let snapshot: CodexActivationSnapshot;
  try {
    snapshot = input.store.observe();
  } catch {
    input.store.advanceIntentPhase(lease, handle, 'ambiguous-absent', 'plugin add failed and re-observation failed');
    return;
  }
  if (snapshot.query.status !== 'ok') {
    input.store.advanceIntentPhase(lease, handle, 'ambiguous-absent', 'plugin add failed; plugin query unavailable');
    return;
  }
  if (snapshot.query.registration.present) {
    // Registration is still present; leave command-started so the gated retry can
    // reconcile without claiming the old generation survived.
    return;
  }
  input.store.advanceIntentPhase(
    lease,
    handle,
    'removal-observed',
    'plugin add failed after the old registration went absent',
  );
}

function requireTargetRegistered(input: ExecuteCodexActivationInput, handle: ActivationHandle): void {
  const snapshot = input.store.observe();
  if (snapshot.query.status !== 'ok') {
    throw new ActivationCommandError('codex plugin list failed after plugin add');
  }
  const registration = snapshot.query.registration;
  if (!registration.present || registration.version === null) {
    throw new ActivationCommandError('Codex plugin registration is absent or invalid after plugin add');
  }
  if (snapshot.canonical.status !== 'ok' || registration.version.canonical !== snapshot.canonical.version.canonical) {
    const observed = registration.version.canonical;
    const target = handle.direction === 'downgrade' ? 'the downgrade target' : 'the canonical target';
    throw new ActivationCommandError(
      `Codex plugin remained at v${observed} after one non-destructive add attempt (expected ${target}); refusing automatic removal/reinstall`,
    );
  }
}

// ============================================================================
// Finalization: parity (inside the callback) → H3 → enabled restore → finalize
// ============================================================================

function finalizeVerifiedGeneration(
  input: ExecuteCodexActivationInput,
  lease: HeldLifecycleLease,
  handle: ActivationHandle,
  deps: CodexActivationExecutorDeps,
  ranCacheCommand: boolean,
): ActivationExecutionResult {
  deps.hooks?.beforeParity?.();
  const verified = verifyInstalledParity(input, lease);
  deps.hooks?.beforeH3?.();
  runBoundedH3Smoke(verified.installedRoot, deps);
  deps.hooks?.beforeEnabledRestore?.();
  const enabled = restoreEnabledFlag(input);
  deps.hooks?.beforeFinalize?.();
  input.store.finalizeActivation(lease, handle);
  return {
    status: 'activated',
    version: verified.version,
    enabled,
    direction: handle.direction,
    hookReviewRequired: true,
    recovery: ranCacheCommand
      ? 'Activated; review `/hooks` and start a new Codex task (tasks pinned to the old generation may break).'
      : 'Verified already-current generation; review `/hooks` and start a new Codex task.',
  };
}

interface VerifiedGeneration {
  version: string;
  installedRoot: string;
}

/**
 * Verify full physical N+1 parity strictly inside A's revalidated delivery
 * callback. The canonical digest is compared against the installed generation
 * without the executor ever holding the raw canonical root; the installed cache
 * path (a codex-owned path, not the canonical bundle) is the only value returned.
 */
function verifyInstalledParity(input: ExecuteCodexActivationInput, lease: HeldLifecycleLease): VerifiedGeneration {
  return input.store.withRevalidatedDeliveryRoot(lease, (ops) => {
    const version = ops.deliveredVersion();
    const canonicalDigest = ops.inventoryDigest();
    const installedRoot = join(input.codexHome, ...CODEX_CACHE_SEGMENTS, version);
    assertInstalledWithinCacheFamily(input.codexHome, installedRoot);
    const tree = scanPhysicalTree(installedRoot);
    if (tree.status === 'absent') {
      throw new ActivationCommandError(`installed Codex generation is absent at ${installedRoot}`);
    }
    if (tree.status === 'symlink') {
      throw new ActivationCommandError(`installed Codex generation is unsafe (symlink) at ${installedRoot}`);
    }
    if (tree.status === 'unsafe') {
      throw new ActivationCommandError(
        `installed Codex generation is unsafe at ${installedRoot}: ${tree.detail ?? ''}`,
      );
    }
    if (tree.digest !== canonicalDigest) {
      throw new ActivationCommandError(
        `installed Codex plugin payload identity mismatch at ${installedRoot} (differs from the canonical delivery)`,
      );
    }
    return { version, installedRoot };
  });
}

/**
 * Reject a path alias: the installed generation must be a physical child of the
 * expected codex cache family so no symlink/junction can execute foreign bytes.
 */
function assertInstalledWithinCacheFamily(codexHome: string, installedRoot: string): void {
  const familyDir = join(codexHome, ...CODEX_CACHE_SEGMENTS);
  const realFamily = safeRealpath(familyDir);
  const realParent = safeRealpath(parentOf(installedRoot));
  if (realFamily !== null && realParent !== null) {
    const rel = relative(realFamily, realParent);
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
      throw new ActivationCommandError(`installed Codex generation escapes the expected cache root: ${installedRoot}`);
    }
  }
}

/**
 * Restore the observed enabled flag through the supported, non-cache-advancing
 * config command, then re-query to confirm. `plugin add` may enable the plugin;
 * a previously disabled operator choice must be preserved.
 */
function restoreEnabledFlag(input: ExecuteCodexActivationInput): boolean {
  const desiredEnabled = readPriorEnabled(input);
  const current = input.store.observe();
  const currentEnabled =
    current.query.status === 'ok' && current.query.registration.present
      ? current.query.registration.enabled
      : desiredEnabled;
  if (currentEnabled === desiredEnabled) return desiredEnabled;
  const restored = setCodexPluginEnabled(desiredEnabled, input.configPath);
  if (!restored.ok) throw new ActivationCommandError(`failed to restore enabled=${desiredEnabled}: ${restored.detail}`);
  const after = input.store.observe();
  const afterEnabled =
    after.query.status === 'ok' && after.query.registration.present
      ? after.query.registration.enabled
      : !desiredEnabled;
  if (afterEnabled !== desiredEnabled) {
    throw new ActivationCommandError(`enabled-state restore verification failed (expected enabled=${desiredEnabled})`);
  }
  return desiredEnabled;
}

/** The prior enabled flag the permit's journal captured (via the planned intent). */
function readPriorEnabled(input: ExecuteCodexActivationInput): boolean {
  // The journal is A's private state; the executor reads the observed enabled flag
  // rather than the raw journal file. `beginActivation` bound priorEnabled to this
  // same observation, so the observed value is the authoritative desired flag.
  const snapshot = input.store.observe();
  if (snapshot.intent.status === 'valid') return snapshot.intent.intent.priorEnabled;
  return snapshot.query.status === 'ok' && snapshot.query.registration.present
    ? snapshot.query.registration.enabled
    : true;
}

// ============================================================================
// Supported Codex CLI command (the only cache-advancing mutation)
// ============================================================================

function runCachePluginAdd(runner: CommandRunner, command: string, timeoutMs: number): void {
  const result = runner(command, [...PLUGIN_ADD_ARGS], { timeoutMs, maxOutputBytes: PLUGIN_ADD_MAX_BYTES });
  if (result.timedOut) throw new ActivationCommandError('codex plugin add timed out', true);
  if (result.outputOverflow) throw new ActivationCommandError('codex plugin add exceeded the output safety cap');
  if (result.exitCode !== 0) {
    throw new ActivationCommandError(`codex plugin add failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

// ============================================================================
// Exact bounded H3 SessionStart smoke
// ============================================================================

export interface H3SmokeResult {
  ok: boolean;
  detail: string;
}

/**
 * Replay the sole Codex SessionStart hook (H3) against the verified installed
 * generation, without a shell, in a sterile from-scratch environment. Success is
 * exit 0, empty stderr, and exactly one JSON object whose additionalContext is the
 * exact expected wish-state line. Timeout, cap breach, spawn failure, schema
 * mismatch, or unexpected output is activation failure.
 */
export function runBoundedH3Smoke(verifiedTRoot: string, deps: CodexActivationExecutorDeps = {}): H3SmokeResult {
  const node = resolveValidatedNode(deps.resolveNode);
  const scriptPath = join(verifiedTRoot, 'scripts', 'session-context.cjs');
  assertRegularFile(scriptPath, 'H3 session-context script');
  const fixture = createSmokeFixture(deps.now ?? (() => new Date()));
  try {
    const repoCwd = realpathSync(fixture.repoRoot);
    const payload = `${JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'genie-activation-smoke',
      source: 'startup',
      cwd: repoCwd,
    })}\n`;
    const result = spawnSync(node, [scriptPath], {
      cwd: repoCwd,
      env: buildSterileEnv(verifiedTRoot, fixture),
      input: payload,
      timeout: H3_TIMEOUT_MS,
      maxBuffer: H3_COMBINED_CAP_BYTES,
      encoding: 'utf8',
      windowsHide: true,
    });
    const check = evaluateH3Result(result);
    if (!check.ok) throw new ActivationCommandError(`H3 SessionStart smoke failed: ${check.detail}`);
    return check;
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

interface SmokeFixture {
  root: string;
  repoRoot: string;
  home: string;
  temp: string;
}

function createSmokeFixture(now: () => Date): SmokeFixture {
  const root = mkdtempSync(join(tmpdir(), 'genie-h3-smoke-'));
  const repoRoot = join(root, 'repo');
  const home = join(root, 'home');
  const temp = join(root, 'tmp');
  const wishDir = join(repoRoot, '.genie', 'wishes', SMOKE_WISH_SLUG);
  mkdirSync(wishDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  const wish = [
    '# Wish: activation-smoke',
    '',
    '**Status:** DRAFT',
    '',
    '### Group A: Smoke',
    '',
    '- [ ] smoke',
    '',
  ].join('\n');
  writeFileSync(join(wishDir, 'WISH.md'), wish, { encoding: 'utf8', mode: 0o600 });
  // `now` participates only so the fixture timestamp is deterministic in tests.
  void now;
  return { root, repoRoot, home, temp };
}

/** An allow-list environment built from scratch — no inherited variables leak in. */
function buildSterileEnv(verifiedTRoot: string, fixture: SmokeFixture): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    return {
      Path: process.env.Path ?? process.env.PATH ?? '',
      USERPROFILE: fixture.home,
      TEMP: fixture.temp,
      TMP: fixture.temp,
      SystemRoot: process.env.SystemRoot ?? '',
      ComSpec: process.env.ComSpec ?? '',
      PATHEXT: process.env.PATHEXT ?? '',
      PLUGIN_ROOT: verifiedTRoot,
    };
  }
  return {
    PATH: process.env.PATH ?? '',
    HOME: fixture.home,
    TMPDIR: fixture.temp,
    LANG: 'C',
    PLUGIN_ROOT: verifiedTRoot,
  };
}

function evaluateH3Result(result: ReturnType<typeof spawnSync>): H3SmokeResult {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') return fail('H3 exceeded the 5-second timeout');
    return fail(`H3 spawn failed: ${result.error.message}`);
  }
  if (result.signal) return fail(`H3 terminated by signal ${result.signal}`);
  const stdout = toText(result.stdout);
  const stderr = toText(result.stderr);
  if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > H3_COMBINED_CAP_BYTES) {
    return fail('H3 combined output exceeded the 64-KiB cap');
  }
  if (result.status !== 0) return fail(`H3 exited ${result.status ?? 'null'}`);
  if (stderr.length > 0) return fail('H3 wrote to stderr');
  return evaluateH3Payload(stdout);
}

function evaluateH3Payload(stdout: string): H3SmokeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return fail('H3 stdout was not exactly one JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('H3 output was not a JSON object');
  }
  const hookSpecificOutput = Reflect.get(parsed, 'hookSpecificOutput');
  if (typeof hookSpecificOutput !== 'object' || hookSpecificOutput === null) {
    return fail('H3 output is missing hookSpecificOutput');
  }
  if (Reflect.get(hookSpecificOutput, 'hookEventName') !== 'SessionStart') {
    return fail('H3 hookEventName is not SessionStart');
  }
  if (Reflect.get(hookSpecificOutput, 'additionalContext') !== SMOKE_EXPECTED_CONTEXT) {
    return fail('H3 additionalContext did not match the exact expected wish-state line');
  }
  return { ok: true, detail: 'H3 SessionStart smoke passed' };
}

function resolveValidatedNode(resolveNode?: () => string | null): string {
  const candidate = resolveNode ? resolveNode() : Bun.which('node');
  if (!candidate) throw new ActivationCommandError('no Node executable found for the H3 smoke');
  if (!isAbsolute(candidate)) throw new ActivationCommandError(`Node executable is not an absolute path: ${candidate}`);
  const real = safeRealpath(candidate);
  if (real === null) throw new ActivationCommandError(`Node executable is unreadable: ${candidate}`);
  assertRegularFile(real, 'Node executable');
  return real;
}

function assertRegularFile(path: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new ActivationCommandError(`${label} is unreadable: ${errorText(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ActivationCommandError(`${label} is not a physical regular file: ${path}`);
  }
}

// ============================================================================
// Result construction
// ============================================================================

function refusedFromState(state: CodexActivationState, reason: string): ActivationExecutionResult {
  const descriptor = describeState(state);
  return {
    status: descriptor.exit === 1 ? 'broken' : 'refused',
    code: descriptor.machineCode,
    detail: `${reason} (${descriptor.recovery})`,
    trailer: buildActivationResultTrailer(state, /* deliveryComplete */ true),
  };
}

function brokenFromError(input: ExecuteCodexActivationInput, error: unknown): ActivationExecutionResult {
  // The journal is intentionally left in place for a gated retry; the lease is
  // released by the caller's finally. Reclassify the current state for reporting.
  let state: CodexActivationState;
  try {
    state = classifyCodexActivation(input.store.observe());
  } catch {
    state = { kind: 'snapshot-inconsistent', detail: 'post-failure re-observation failed' };
  }
  const fenced = error instanceof LifecycleFencingError;
  return {
    status: 'broken',
    code: fenced ? 'codex-lifecycle-fenced' : describeState(state).machineCode,
    detail: errorText(error),
    trailer: buildActivationResultTrailer(state, /* deliveryComplete */ true),
  };
}

/**
 * Map Group B's inner-guard refusal to the executor result: the stable
 * delivery-incomplete outcome (authority none, exit 1, deliveryComplete false)
 * carrying the one update/install recovery command. Nothing was mutated.
 */
function deliveryIncompleteResult(
  assessment: Exclude<DeliveryAssessment, 'matching'>,
  detail: string,
): ActivationExecutionResult {
  const result = buildDeliveryIncompleteResult(assessment, detail);
  return {
    status: 'delivery-incomplete',
    code: 'delivery-incomplete',
    assessment,
    detail: result.detail,
    recovery: result.recovery,
    trailer: {
      schemaVersion: 1,
      code: 'delivery-incomplete',
      deliveryComplete: false,
      retry: true,
      nextAction: result.recovery,
    },
  };
}

function busyTrailer(holderKind: string | null): ActivationResultTrailer {
  return {
    schemaVersion: 1,
    code: 'codex-lifecycle-busy',
    deliveryComplete: false,
    retry: true,
    nextAction: holderKind
      ? `retry after the current ${holderKind} lifecycle command releases the lease`
      : 'retry after the current lifecycle command releases the lease',
  };
}

function staleTrailer(): ActivationResultTrailer {
  return {
    schemaVersion: 1,
    code: 'activation-stale-permit',
    deliveryComplete: true,
    retry: true,
    nextAction: 'retire tasks → genie setup --codex → /hooks → new task',
  };
}

// ============================================================================
// Small utilities
// ============================================================================

function fail(detail: string): H3SmokeResult {
  return { ok: false, detail };
}

function toText(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : value.toString('utf8');
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function parentOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf(sep));
  return idx <= 0 ? path : path.slice(0, idx);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
