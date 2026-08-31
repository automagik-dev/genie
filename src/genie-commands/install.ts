/**
 * Genie Install Command — TypeScript-side finishing step of the curl|bash bootstrap.
 *
 * install.sh downloads, verifies, extracts, links and PATH-wires the binary in
 * bash, then hands off to `genie install` on the freshly linked binary for the
 * finishing steps that belong in TypeScript: canonical payload normalization,
 * v4 cleanup, consent, the skills channel and the remaining integrations.
 *
 * Opt out of the v4 cleanup with `--skip-v4-cleanup` — install.sh forwards its
 * CLI args, so `curl ... | bash -s -- --skip-v4-cleanup` reaches this flag.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { retireInstallVersionMarker } from '../lib/install-version-marker.js';
import {
  type LifecycleLease,
  type LifecycleLeaseSkip,
  acquireLifecycleLease,
  acquireLifecycleLeaseWithWait,
} from '../lib/lifecycle-lease.js';
import {
  acquireOrderedLifecycleLeases,
  lifecycleBusyMessage,
  releaseOrderedLifecycleLeases,
} from '../lib/ordered-lifecycle-leases.js';
import {
  type InstallIntegrationsOptions,
  type IntegrationResult,
  type IntegrationSelection,
  installRuntimeIntegrations,
  persistIntegrationConsent,
} from '../lib/runtime-integrations.js';
import { type SkillsChannelConvergenceResult, runSkillsChannelConvergence } from '../lib/skills-installer.js';
import { VERSION } from '../lib/version.js';
import { type AuxiliaryTreeOperations, type AuxiliaryTreeOutcome, convergeAuxiliaryTree } from './auxiliary-trees.js';
import { cleanupV4 } from './legacy-v4.js';
import { runAgentSyncSafe } from './update.js';

const GENIE_HOME = process.env.GENIE_HOME || join(homedir(), '.genie');

/** Reported for an explicitly requested Codex selection now that its plugin subsystem is retired. */
const CODEX_INTEGRATION_RETIRED = 'Codex plugin integration is retired; nothing to install';

/**
 * Auxiliary trees moved from `bin/` to the GENIE_HOME root. plugins/skills/
 * templates are the trees `genie update`'s syncAuxiliaryContent also manages.
 * `.claude-plugin` carries the marketplace manifest, whose plugin entries
 * reference `./plugins/genie` RELATIVE to the manifest location — it must live
 * beside plugins/ so a marketplace root truly contains what the manifest
 * references (left in bin/, the manifest would dangle once plugins/ moves out).
 */
const AUX_LAYOUT_DIRS = ['plugins', 'skills', 'templates', '.claude-plugin'] as const;

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
/** The skills.sh channel step; production pins it to the running binary's VERSION. */
type SkillsChannelRunner = (selection: IntegrationSelection) => SkillsChannelConvergenceResult;
type IntegrationRunner = (options?: InstallIntegrationsOptions) => ReturnType<typeof installRuntimeIntegrations>;
type LifecycleLeaseAcquirer = () => LifecycleLease | LifecycleLeaseSkip;
type ConsentWriter = (selection: IntegrationSelection) => void;
type InstallMarkerRetirer = () => void;

function codexInScope(selection: IntegrationSelection): boolean {
  return selection === 'auto' || selection === 'codex' || selection === 'all';
}

/** The claude/hermes scope for `runIntegrations` when Codex is deferred (never activate it here). */
function claudeOnlyScope(selection: IntegrationSelection): InstallIntegrationsOptions {
  if (selection === 'auto') return { selection: 'auto', detected: { codex: false } };
  if (selection === 'all') return { selection: 'claude' };
  return { selection: 'none' };
}

function retireInstallMarkerSafe(retireMarker: InstallMarkerRetirer): void {
  try {
    retireMarker();
  } catch {
    // orphan-metadata cleanup must never fail a completed install.
  }
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
 * Build the ordered install results. The Codex plugin subsystem is retired, so
 * a Codex-in-scope selection never reaches the integration runner for Codex; an
 * explicitly requested Codex selection reports the retirement rather than
 * failing, and every other runtime keeps its ordinary integration result.
 */
function buildInstallResults(selection: IntegrationSelection, runIntegrations: IntegrationRunner): IntegrationResult[] {
  if (!codexInScope(selection)) return runIntegrations({ selection });
  const nonCodex = runIntegrations(claudeOnlyScope(selection));
  if (selection === 'codex' || selection === 'all') {
    return [{ runtime: 'codex', ok: true, detail: CODEX_INTEGRATION_RETIRED }, ...nonCodex];
  }
  return nonCodex;
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
 * Run the integrations this command is authorized to own. Codex is structurally
 * absent from the runner scope.
 *
 * Returns the skills-channel result so the caller can give a skills failure its
 * own exit precedence.
 */
function runPermittedPostDeliveryIntegrations(
  selection: IntegrationSelection,
  runIntegrations: IntegrationRunner,
  runSync: AgentSyncRunner,
  runSkills: SkillsChannelRunner,
): SkillsChannelConvergenceResult {
  const results = buildInstallResults(selection, runIntegrations);
  for (const result of results) {
    const glyph = result.ok ? '\x1b[32m+\x1b[0m' : '\x1b[33m!\x1b[0m';
    const disabled = result.preservedDisabled ? '; disabled state preserved' : '';
    console.log(`  ${glyph} ${result.runtime}: ${result.detail}${disabled}`);
  }
  if (selection !== 'auto' && selection !== 'none') {
    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0)
      throw new Error(`Requested integration failed: ${failed.map((result) => result.runtime).join(', ')}`);
  }
  // Skills BEFORE agent-sync (wish `skills-everywhere` decision 2), and for
  // every non-`none` consent with `--all` (decision 3: an explicit, accepted
  // widening of the install-consent contract for skills only). A failure sets
  // exit 1 with the remedy command and never throws — the delivered bytes stay
  // committed.
  const skills = runSkills(selection);
  const agentSyncSelection = narrowAgentSyncSelection(selection);
  if (agentSyncSelection !== null) runSync(agentSyncSelection);
  return skills;
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
  writeConsent: ConsentWriter = (selection) => persistIntegrationConsent(selection, GENIE_HOME),
  retireMarker: InstallMarkerRetirer = () => retireInstallVersionMarker(GENIE_HOME),
  runSkills: SkillsChannelRunner = (selection) =>
    runSkillsChannelConvergence({ selection, version: VERSION, genieHome: GENIE_HOME }),
): Promise<void> {
  const selection = resolveIntegrationSelection(options);
  // The bounded wait wraps the acquirer actually in play (injected seam
  // included), so production and tests share one retry policy.
  const acquired = acquireOrderedLifecycleLeases(() => acquireLifecycleLeaseWithWait(acquireLease));
  if (!acquired.ok) {
    // One human-readable stderr line plus exit 2 is the whole contract here.
    console.error(lifecycleBusyMessage(acquired.detail));
    process.exitCode = 2;
    return;
  }
  const { agentSyncLease: lease } = acquired;
  try {
    // The lifecycle lock is held before canonical payload normalization,
    // VERSION publication, or any later finisher.
    const normalized = normalizeLayout(GENIE_HOME);
    if (normalized !== undefined) {
      for (const outcome of normalized) printAuxiliaryOutcome(outcome);
      const failed = normalized.filter((outcome) => outcome.status === 'failed');
      if (failed.length > 0) {
        throw new Error(`Install payload convergence failed: ${failed.map((outcome) => outcome.label).join(', ')}`);
      }
    }
    persistInstallOwnedConsent(selection, writeConsent);
    if (options.skipV4Cleanup) {
      console.log('\x1b[2mSkipping v4 legacy cleanup (--skip-v4-cleanup).\x1b[0m');
    } else {
      runV4Cleanup();
    }

    const skills = runPermittedPostDeliveryIntegrations(selection, runIntegrations, runSync, runSkills);
    // Decision 14: marker retirement is the LAST successful finisher. A later
    // consent, legacy cleanup, permitted integration, or sync failure must leave
    // the marker intact so the whole install remains retryable.
    retireInstallMarkerSafe(retireMarker);
    // A failed skills install is a FAILURE: the delivered bytes stay committed,
    // and the operator gets exit 1 with the remedy command.
    if (skills.status === 'failed') process.exitCode = 1;
  } finally {
    releaseOrderedLifecycleLeases(lease);
  }
}

/**
 * Gate the agent-sync scope for install: skip it where it has nothing to do —
 * `none` (nothing selected) and `codex` (a retired plugin runtime agent-sync
 * never converged). Every other selection (`auto`/`all`/`claude`) passes
 * through UNCHANGED so `runAgentSync` sees the real selection.
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
