/**
 * Genie Install Command — TypeScript-side finishing step of the curl|bash bootstrap.
 *
 * install.sh downloads, verifies, extracts, links and PATH-wires the binary in
 * bash, then hands off to `genie install` on the freshly linked binary for the
 * finishing steps that belong in TypeScript. v5 authenticates and deep-publishes
 * the Codex delivery before v4 cleanup and permitted non-Codex convergence;
 * explicit `setup --codex` alone owns Codex activation and managed roles.
 *
 * Opt out of the v4 cleanup with `--skip-v4-cleanup` — install.sh forwards its
 * CLI args, so `curl ... | bash -s -- --skip-v4-cleanup` reaches this flag. The
 * layout-normalize always runs; the selected non-Codex sync scope runs only
 * after authenticated delivery publication succeeds.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type LifecycleLease, acquireLifecycleLease } from '../lib/agent-sync.js';
import type { DeliveryEvidenceChannel } from '../lib/codex-delivery-evidence.js';
import {
  type HeldLifecycleLease,
  type LifecycleLeaseResult,
  acquireLifecycleLease as acquireCodexLifecycleLease,
} from '../lib/codex-lifecycle-lease.js';
import { genieConfigExists, getGenieConfigPath } from '../lib/genie-config.js';
import { retireInstallVersionMarker } from '../lib/install-version-marker.js';
import { acquireOrderedLifecycleLeases, releaseOrderedLifecycleLeases } from '../lib/ordered-lifecycle-leases.js';
import {
  type InstallIntegrationsOptions,
  type IntegrationResult,
  type IntegrationSelection,
  installRuntimeIntegrations,
  parseCodexPluginState,
  persistIntegrationConsent,
  resolveRuntimeExecutable,
  runBoundedIntegrationCommand,
} from '../lib/runtime-integrations.js';
import { VERSION } from '../lib/version.js';
import { type AuxiliaryTreeOperations, type AuxiliaryTreeOutcome, convergeAuxiliaryTree } from './auxiliary-trees.js';
import {
  CODEX_DELIVERY_INCOMPLETE_TRAILER,
  CODEX_DELIVERY_RESULT_TRAILER,
  CODEX_LIFECYCLE_BUSY_TRAILER,
  CODEX_RETIRE_RECOVERY,
  CodexLifecycleBusyError,
  classifyCodexDelivery,
} from './codex-delivery.js';
import { cleanupV4 } from './legacy-v4.js';
import {
  type AlreadyCurrentRepairDirective,
  attemptAlreadyCurrentDeliveryRepair,
  resolvePlatformId,
  runAgentSyncSafe,
} from './update.js';

const GENIE_HOME = process.env.GENIE_HOME || join(homedir(), '.genie');

/**
 * Auxiliary trees moved from `bin/` to the GENIE_HOME root. plugins/skills/
 * templates are the trees `genie update`'s syncAuxiliaryContent also manages.
 * `.agents` + `.claude-plugin` carry the marketplace manifests, whose plugin
 * entries reference `./plugins/genie` RELATIVE to the manifest location — they
 * must live beside plugins/ so `plugin marketplace add <GENIE_HOME>` points at
 * a root that truly contains what the manifests reference (left in bin/, the
 * manifests would dangle once plugins/ moves out).
 */
const AUX_LAYOUT_DIRS = ['plugins', 'skills', 'templates', '.agents', '.claude-plugin'] as const;

export interface InstallOptions {
  /** Set by --skip-v4-cleanup: leave v4-era artifacts in place. */
  skipV4Cleanup?: boolean;
  /** Which detected client integrations to install. Default: auto. */
  integrations?: IntegrationSelection;
  /** Alias for --integrations none. */
  skipIntegrations?: boolean;
}

type V4CleanupRunner = typeof cleanupV4;
type NormalizeAuxLayoutFn = (genieHome: string) => AuxiliaryTreeOutcome[] | undefined;
type AgentSyncRunner = (selection: IntegrationSelection) => void;
type IntegrationRunner = (options?: InstallIntegrationsOptions) => ReturnType<typeof installRuntimeIntegrations>;
type LifecycleLeaseAcquirer = () => LifecycleLease | { skipped: string };
type CodexLifecycleLeaseAcquirer = () => LifecycleLeaseResult;
type ConsentWriter = (selection: IntegrationSelection) => void;

/**
 * A detected Codex runtime whose installed generation must remain untouched by
 * install. `null` means absent or unobservable; setup owns every activation.
 */
export interface CodexInstallTarget {
  installedVersion: string | null;
}
type CodexInstallClassifier = (selection: IntegrationSelection) => CodexInstallTarget | null;
type InstallDeliveryRepair = (
  channel: DeliveryEvidenceChannel,
  platformId: string,
  lease: HeldLifecycleLease,
) => Promise<AlreadyCurrentRepairDirective>;
type InstallMarkerRetirer = () => void;

/**
 * Detect Codex without granting install any activation authority. A runnable
 * Codex command always returns a target, including fresh/absent, same-version,
 * malformed, or temporarily unobservable plugin state. The authenticated
 * delivery record is published first; only `setup --codex` may later mutate the
 * journal, registration/cache, enabled state, project route, or managed roles.
 */
function classifyCodexInstallDefault(selection: IntegrationSelection): CodexInstallTarget | null {
  if (!codexInScope(selection)) return null;
  let command: string | null;
  try {
    command = resolveRuntimeExecutable('codex', process.cwd());
  } catch {
    return { installedVersion: null };
  }
  // Delivery publication authenticates the installed Genie payload, not the
  // presence of a Codex executable. Publish now so installing Genie before
  // Codex does not make later setup unrecoverably delivery-incomplete.
  if (command === null) return { installedVersion: null };
  const result = runBoundedIntegrationCommand(command, ['plugin', 'list', '--json'], {
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
  });
  if (result.timedOut || result.outputOverflow || result.exitCode !== 0) return { installedVersion: null };
  const parsed = parseCodexPluginState(result.stdout);
  if (!parsed.ok || !parsed.state.installed) return { installedVersion: null };
  return { installedVersion: parsed.state.version ?? null };
}

function codexInScope(selection: IntegrationSelection): boolean {
  return selection === 'auto' || selection === 'codex' || selection === 'all';
}

/** The claude/hermes scope for `runIntegrations` when Codex is deferred (never activate it here). */
function claudeOnlyScope(selection: IntegrationSelection): InstallIntegrationsOptions {
  if (selection === 'auto') return { selection: 'auto', detected: { codex: false } };
  if (selection === 'all') return { selection: 'claude' };
  return { selection: 'none' };
}

/**
 * Report an authenticated Codex delivery without mutating Codex. The result is
 * informational only; the caller emits the completion trailer after publication
 * and leaves all activation work to `setup --codex`.
 */
function buildInstallCodexDeferral(target: CodexInstallTarget, actionRequired: boolean): IntegrationResult {
  const installed =
    target.installedVersion === null
      ? 'not registered or not safely observable'
      : `left at v${target.installedVersion}`;
  const next = actionRequired ? ` ${CODEX_RETIRE_RECOVERY}` : '';
  return {
    runtime: 'codex',
    ok: true,
    detail: `authenticated delivery v${VERSION}; Codex plugin ${installed} (no activation-owned mutation).${next}`,
    deliveryComplete: true,
    actionRequired,
  };
}

/** Resolve the release channel whose manifest and asset must authenticate a deferred install. */
function resolveDeliveryChannelForInstall(): DeliveryEvidenceChannel {
  const handedOffChannel = process.env.GENIE_INSTALL_DELIVERY_CHANNEL;
  if (handedOffChannel !== undefined) {
    if (handedOffChannel === 'stable' || handedOffChannel === 'homolog' || handedOffChannel === 'dev') {
      return handedOffChannel;
    }
    throw new Error(`Invalid installer delivery channel: ${handedOffChannel}`);
  }
  try {
    if (!genieConfigExists()) return 'stable';
    const raw = JSON.parse(readFileSync(getGenieConfigPath(), 'utf8')) as { updateChannel?: string };
    if (raw.updateChannel === 'dev' || raw.updateChannel === 'next') return 'dev';
    if (raw.updateChannel === 'homolog') return 'homolog';
    return 'stable';
  } catch {
    return 'stable';
  }
}

/**
 * Authenticate and deep-publish before any integration, sync, consent, legacy
 * cleanup, marker retirement, or Codex-owned mutation. A detected Codex target
 * without a held lease is an internal fail-closed error.
 */
async function finalizeInstallDeliveryLifecycle(
  lease: HeldLifecycleLease,
  target: CodexInstallTarget | null,
  deliveryChannel: DeliveryEvidenceChannel,
  repairDelivery: InstallDeliveryRepair,
): Promise<AlreadyCurrentRepairDirective | null> {
  if (target === null) return null;
  const delivery = await repairDelivery(deliveryChannel, resolvePlatformId(), lease);
  if (delivery.action === 'failed' || delivery.action === 'busy' || delivery.action === 'route-upgrade')
    return delivery;
  return delivery;
}

function retireInstallMarkerSafe(retireMarker: InstallMarkerRetirer): void {
  try {
    retireMarker();
  } catch {
    // orphan-metadata cleanup must never fail a completed install.
  }
}

function projectInstallDeliveryOutcome(
  delivery: AlreadyCurrentRepairDirective | null,
  actionRequired: boolean,
): boolean {
  if (delivery?.action === 'failed' || delivery?.action === 'route-upgrade') {
    const detail =
      delivery.action === 'route-upgrade'
        ? `release channel advanced to ${delivery.manifest.version} while authenticating the installed delivery`
        : delivery.detail;
    console.log(`  \x1b[31m!\x1b[0m Codex delivery incomplete: ${detail}`);
    console.log(CODEX_DELIVERY_INCOMPLETE_TRAILER);
    process.exitCode = 1;
    return true;
  }
  if (delivery?.action === 'busy') {
    console.log(`  \x1b[31m!\x1b[0m Codex delivery repair is busy: ${delivery.detail}`);
    console.log(CODEX_LIFECYCLE_BUSY_TRAILER);
    process.exitCode = 2;
    return true;
  }
  if (actionRequired) {
    process.exitCode = 2;
    console.log(CODEX_DELIVERY_RESULT_TRAILER);
  }
  return false;
}

/**
 * Converge the extracted `<home>/bin/{plugins,skills,templates}` trees into
 * the canonical `<home>/{plugins,skills,templates}` layout that `genie update`
 * and the agent-sync source resolver expect.
 *
 * install.sh extracts into `<home>/bin/`. Each present tree is compared by
 * content, copied to a sibling staging directory, digest-verified, and then
 * promoted with same-filesystem renames. VERSION stamps are written only
 * after all present trees converge and are never treated as content evidence.
 * Identical extracted trees are removed so deleted files cannot survive into
 * a later extraction. Every tree is attempted; any failure blocks subsequent
 * install finishers and retains actionable recovery artifacts.
 */
export function normalizeAuxLayout(
  genieHome: string,
  operations?: Partial<AuxiliaryTreeOperations>,
): AuxiliaryTreeOutcome[] {
  const binVersion = readVersionStamp(join(genieHome, 'bin', 'VERSION'));
  const outcomes = AUX_LAYOUT_DIRS.map((name) =>
    convergeAuxiliaryTree({
      label: name,
      source: join(genieHome, 'bin', name),
      destination: join(genieHome, name),
      removeSourceOnSuccess: true,
      operations,
    }),
  );
  const attempted = outcomes.some((outcome) => outcome.status !== 'skipped');
  const failed = outcomes.some((outcome) => outcome.status === 'failed');
  if (attempted && !failed && binVersion !== null) {
    try {
      // VERSION is metadata written only after every present tree was proven
      // digest-identical or promoted successfully. It is never convergence
      // evidence by itself.
      writeFileSync(join(genieHome, 'VERSION'), `${binVersion}\n`);
    } catch {
      // best-effort; a stale stamp only costs a digest compare next run.
    }
  }
  return outcomes;
}

/** Read a VERSION stamp file, returning its trimmed content or null. */
function readVersionStamp(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Build the ordered install results after delivery authentication. Every
 * Codex-in-scope selection excludes Codex from the integration runner; a
 * detected runtime gets an informational delivery result, while an explicitly
 * requested missing runtime remains a normal integration failure.
 */
function buildInstallResults(
  codexTarget: CodexInstallTarget | null,
  selection: IntegrationSelection,
  runIntegrations: IntegrationRunner,
  actionRequired: boolean,
): IntegrationResult[] {
  if (!codexInScope(selection)) return runIntegrations({ selection });
  const nonCodex = runIntegrations(claudeOnlyScope(selection));
  if (codexTarget !== null) return [buildInstallCodexDeferral(codexTarget, actionRequired), ...nonCodex];
  if (selection === 'codex' || selection === 'all') {
    return [{ runtime: 'codex', ok: false, detail: 'codex CLI not found' }, ...nonCodex];
  }
  return nonCodex;
}

function installActionRequired(
  target: CodexInstallTarget | null,
  delivery: AlreadyCurrentRepairDirective | null,
): boolean {
  if (target === null) return false;
  if (delivery?.action === 'exit-handoff') return true;
  if (target.installedVersion === null) return true;
  return classifyCodexDelivery(target.installedVersion, VERSION).kind !== 'current';
}

/**
 * Install may remember an explicitly Claude-only maintenance scope. Any
 * selection that can include Codex is activation authority and is persisted
 * only by a successful explicit `setup --codex`; `none` likewise must not
 * revoke an existing setup-owned consent record as an install side effect.
 */
function persistInstallOwnedConsent(selection: IntegrationSelection, writeConsent: ConsentWriter): void {
  if (selection === 'claude') writeConsent(selection);
}

/** Install-owned agent sync cannot cross into setup-owned Codex role convergence. */
export function runInstallAgentSync(
  selection: IntegrationSelection,
  sync: typeof runAgentSyncSafe = runAgentSyncSafe,
): void {
  sync({ strict: true, selection });
}

/**
 * Run only the post-publication integrations this command is authorized to
 * own. Codex itself is structurally absent from the runner scope; setup owns
 * its marketplace, plugin, project route, and managed-role convergence.
 */
function runPermittedPostDeliveryIntegrations(
  selection: IntegrationSelection,
  target: CodexInstallTarget | null,
  actionRequired: boolean,
  runIntegrations: IntegrationRunner,
  runSync: AgentSyncRunner,
): void {
  const results = buildInstallResults(target, selection, runIntegrations, actionRequired);
  for (const result of results) {
    const glyph = result.ok ? '\x1b[32m+\x1b[0m' : '\x1b[33m!\x1b[0m';
    const disabled = result.preservedDisabled ? '; disabled state preserved' : '';
    console.log(`  ${glyph} ${result.runtime}: ${result.detail}${disabled}`);
  }
  const codexFailed = results.some((result) => result.runtime === 'codex' && !result.ok);
  if (selection !== 'auto' && selection !== 'none') {
    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0)
      throw new Error(`Requested integration failed: ${failed.map((result) => result.runtime).join(', ')}`);
  }
  const agentSyncSelection = narrowAgentSyncSelection(selection);
  if (agentSyncSelection !== null) {
    if (!codexFailed) {
      runSync(agentSyncSelection);
    } else {
      // selection === 'auto' is the only surviving case here: an explicit
      // --integrations all/claude/codex failure already threw above.
      console.log(
        '  \x1b[33m!\x1b[0m Skipped agent-sync: codex integration failed under --integrations auto (rerun with --integrations claude to sync Claude/hermes only, or fix codex and rerun).',
      );
    }
  }
}

/**
 * Run the post-install finishers. `runV4Cleanup` / `normalizeLayout` / `runSync`
 * are injection seams for tests (mirrors runV4CleanupSafe) — production callers
 * pass options only.
 */
export async function installCommand(
  options: InstallOptions = {},
  runV4Cleanup: V4CleanupRunner = cleanupV4,
  normalizeLayout: NormalizeAuxLayoutFn = normalizeAuxLayout,
  runSync: AgentSyncRunner = runInstallAgentSync,
  runIntegrations: IntegrationRunner = installRuntimeIntegrations,
  acquireLease: LifecycleLeaseAcquirer = () => acquireLifecycleLease(GENIE_HOME),
  acquireCodexLease: CodexLifecycleLeaseAcquirer = () =>
    acquireCodexLifecycleLease('install-converge', { genieHome: GENIE_HOME }),
  writeConsent: ConsentWriter = (selection) => persistIntegrationConsent(selection, GENIE_HOME),
  classifyCodexInstall: CodexInstallClassifier = classifyCodexInstallDefault,
  repairDelivery: InstallDeliveryRepair = (channel, platformId, lease) =>
    attemptAlreadyCurrentDeliveryRepair(channel, platformId, lease),
  retireMarker: InstallMarkerRetirer = () => retireInstallVersionMarker(GENIE_HOME),
): Promise<void> {
  // install.sh passes the exact channel whose manifest selected the installed
  // bytes. Resolve and validate it before acquiring either lifecycle lease or
  // running a finisher, so fresh dev/homolog installs cannot be relabeled as
  // stable and a malformed internal handoff cannot mutate anything.
  const deliveryChannel = resolveDeliveryChannelForInstall();
  const selection = resolveIntegrationSelection(options);
  const acquired = acquireOrderedLifecycleLeases(acquireLease, acquireCodexLease);
  if (!acquired.ok) {
    if (acquired.busy === 'agent-sync') {
      throw new Error(`Another Genie lifecycle command is active: ${acquired.detail}`);
    }
    console.log(new CodexLifecycleBusyError(acquired.refusal.holderKind).message);
    console.log(CODEX_LIFECYCLE_BUSY_TRAILER);
    process.exitCode = 2;
    return;
  }
  const { agentSyncLease: lease, codexLease } = acquired;
  try {
    codexLease.assertOperation(codexLease.operationId);

    // Both lifecycle locks are now held before canonical payload normalization,
    // VERSION publication, delivery repair, or any later finisher.
    const normalized = normalizeLayout(GENIE_HOME);
    if (normalized !== undefined) {
      for (const outcome of normalized) printAuxiliaryOutcome(outcome);
      const failed = normalized.filter((outcome) => outcome.status === 'failed');
      if (failed.length > 0) {
        throw new Error(`Install payload convergence failed: ${failed.map((outcome) => outcome.label).join(', ')}`);
      }
    }
    const codexTarget = classifyCodexInstall(selection);
    const delivery = await finalizeInstallDeliveryLifecycle(codexLease, codexTarget, deliveryChannel, repairDelivery);
    // Failed, busy, or advanced authentication is terminal before every
    // activation-owned or integration-owned finisher. An advanced channel must
    // be selected and delivered by the ordinary installer/update path; this
    // stale target never mints a record or mutates Codex.
    if (projectInstallDeliveryOutcome(delivery, false)) return;

    persistInstallOwnedConsent(selection, writeConsent);
    if (options.skipV4Cleanup) {
      console.log('\x1b[2mSkipping v4 legacy cleanup (--skip-v4-cleanup).\x1b[0m');
    } else {
      runV4Cleanup();
    }

    // Install never invokes Codex convergence, even after the authenticated
    // record exists. Only unrelated Claude/Hermes integration and sync work is
    // permitted here; `setup --codex` owns every Codex activation mutation.
    const actionRequired = installActionRequired(codexTarget, delivery);
    runPermittedPostDeliveryIntegrations(selection, codexTarget, actionRequired, runIntegrations, runSync);
    // Decision 14: marker retirement is the LAST successful finisher. A later
    // consent, legacy cleanup, permitted integration, or sync failure must leave
    // the marker intact so the whole install remains retryable.
    retireInstallMarkerSafe(retireMarker);
    // Delivered-but-action-required (Codex generation deferred): exit 2 with the
    // one A-owned result trailer and no all-green footer. install.sh maps this to
    // an installer exit 2 (deliverable 3).
    if (projectInstallDeliveryOutcome(delivery, actionRequired)) return;
  } finally {
    releaseOrderedLifecycleLeases(codexLease, lease);
  }
}

/**
 * Gate the agent-sync scope for install. R2/A1 (agent-sync must never write
 * codex product skills into ~/.agents/skills) is now structural in
 * `runAgentSync` itself — there is no `codex` arm to narrow away from — so
 * this only needs to skip agent-sync where it has nothing to do: `none`
 * (nothing selected) and `codex` (setup owns Codex convergence, never
 * agent-sync). Every other selection
 * (`auto`/`all`/`claude`) passes through UNCHANGED so `runAgentSync` sees the
 * real selection and converges hermes on `auto`/`all` too.
 */
export function narrowAgentSyncSelection(selection: IntegrationSelection): IntegrationSelection | null {
  return selection === 'none' || selection === 'codex' ? null : selection;
}

/** Validate raw Commander input before cleanup, synchronization, or install side effects. */
export function resolveIntegrationSelection(options: InstallOptions): IntegrationSelection {
  const selection = options.skipIntegrations ? 'none' : (options.integrations ?? 'auto');
  if (!['auto', 'codex', 'claude', 'all', 'none'].includes(selection)) {
    throw new Error(`Invalid --integrations value: ${selection}`);
  }
  return selection;
}

function printAuxiliaryOutcome(outcome: AuxiliaryTreeOutcome): void {
  if (outcome.status === 'skipped') return;
  if (outcome.status === 'failed') {
    const rollback = outcome.rollbackError ? `; rollback: ${outcome.rollbackError}` : '';
    const fresh = outcome.freshArtifact
      ? `; verified fresh artifact: ${outcome.freshArtifact}`
      : '; no verified fresh artifact available';
    console.log(`  \x1b[31m!\x1b[0m ${outcome.label}: failed at ${outcome.stage}: ${outcome.error}${rollback}${fresh}`);
    return;
  }
  const detail = outcome.status === 'unchanged' ? 'content already current; extracted residue removed' : 'refreshed';
  console.log(`  \x1b[32m+\x1b[0m ${outcome.label}: ${detail}`);
  for (const warning of outcome.warnings) console.log(`  \x1b[33m!\x1b[0m ${outcome.label}: ${warning}`);
}
