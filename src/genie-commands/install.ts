/**
 * Genie Install Command — TypeScript-side finishing step of the curl|bash bootstrap.
 *
 * install.sh downloads, verifies, extracts, links and PATH-wires the binary in
 * bash, then hands off to `genie install` on the freshly linked binary for the
 * finishing steps that belong in TypeScript. v5 keeps this deliberately thin:
 * v4 legacy cleanup, then the layout normalization + agent-sync phase that
 * converges every detected coding agent from the canonical source root.
 *
 * Opt out of the v4 cleanup with `--skip-v4-cleanup` — install.sh forwards its
 * CLI args, so `curl ... | bash -s -- --skip-v4-cleanup` reaches this flag. The
 * layout-normalize + agent-sync steps always run: install must converge agents.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type LifecycleLease, acquireLifecycleLease } from '../lib/agent-sync.js';
import {
  type InstallIntegrationsOptions,
  type IntegrationResult,
  type IntegrationSelection,
  installCodexAgents,
  installRuntimeIntegrations,
  parseCodexPluginState,
  persistIntegrationConsent,
  resolveBundleRoot,
  resolveRuntimeExecutable,
  runBoundedIntegrationCommand,
} from '../lib/runtime-integrations.js';
import { VERSION } from '../lib/version.js';
import { type AuxiliaryTreeOperations, type AuxiliaryTreeOutcome, convergeAuxiliaryTree } from './auxiliary-trees.js';
import { CODEX_DELIVERY_RESULT_TRAILER, CODEX_RETIRE_RECOVERY, classifyCodexDelivery } from './codex-delivery.js';
import { cleanupV4 } from './legacy-v4.js';
import { runAgentSyncSafe } from './update.js';

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
type ConsentWriter = (selection: IntegrationSelection) => void;

/** A pending install delivery: the installed generation N differs from the delivered T (=VERSION). */
export interface CodexInstallDeferral {
  installedVersion: string;
}
type CodexInstallClassifier = (selection: IntegrationSelection) => CodexInstallDeferral | null;

/**
 * Group C install gate (item 2). `genie install` runs on the freshly linked
 * binary (T = VERSION). If a Codex plugin generation N is already installed and
 * N ≠ T, an install would otherwise `plugin add` and advance the cache, pruning
 * the generation a live task references — the same 2026-07-11 hazard as update,
 * on the curl|bash reinstall vector. This classifier (shared `classifyCodexDelivery`,
 * observed reality: N from a live `codex plugin list`) reports that pending case
 * so the caller defers activation. A fresh install (absent plugin) or a
 * same-version install returns null and activates/converges normally.
 */
function classifyCodexInstallDefault(selection: IntegrationSelection): CodexInstallDeferral | null {
  if (!codexInScope(selection)) return null;
  let command: string | null;
  try {
    command = resolveRuntimeExecutable('codex', process.cwd());
  } catch {
    return null;
  }
  if (command === null) return null;
  const result = runBoundedIntegrationCommand(command, ['plugin', 'list', '--json'], {
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
  });
  if (result.timedOut || result.outputOverflow || result.exitCode !== 0) return null;
  const parsed = parseCodexPluginState(result.stdout);
  if (!parsed.ok || !parsed.state.installed) return null;
  const installedVersion = parsed.state.version ?? null;
  if (installedVersion === null) return null;
  const state = classifyCodexDelivery(installedVersion, VERSION);
  return state.kind === 'pending' ? { installedVersion } : null;
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
 * Deferred install of a pending Codex generation: converge only the non-plugin
 * role agents and return an action-required exit-2 result (deliveryComplete:true)
 * naming N and the retire recovery. Never runs a plugin/cache command.
 */
function buildInstallCodexDeferral(installedVersion: string): IntegrationResult {
  let agentDetail = '';
  const bundleRoot = resolveBundleRoot();
  if (bundleRoot !== null) {
    try {
      const agents = installCodexAgents(bundleRoot);
      agentDetail = agents.installed > 0 ? `; role agents refreshed (${agents.installed})` : '';
    } catch (error) {
      agentDetail = `; role-agent refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return {
    runtime: 'codex',
    ok: true,
    detail: `delivered v${VERSION}; Codex plugin left at v${installedVersion} (no cache advance). ${CODEX_RETIRE_RECOVERY}${agentDetail}`,
    deliveryComplete: true,
    actionRequired: true,
  };
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
 * Run the post-install finishers. `runV4Cleanup` / `normalizeLayout` / `runSync`
 * are injection seams for tests (mirrors runV4CleanupSafe) — production callers
 * pass options only.
 */
export function installCommand(
  options: InstallOptions = {},
  runV4Cleanup: V4CleanupRunner = cleanupV4,
  normalizeLayout: NormalizeAuxLayoutFn = normalizeAuxLayout,
  runSync: AgentSyncRunner = (selection) => runAgentSyncSafe({ strict: true, selection }),
  runIntegrations: IntegrationRunner = installRuntimeIntegrations,
  acquireLease: LifecycleLeaseAcquirer = () => acquireLifecycleLease(GENIE_HOME),
  writeConsent: ConsentWriter = (selection) => persistIntegrationConsent(selection, GENIE_HOME),
  classifyCodexInstall: CodexInstallClassifier = classifyCodexInstallDefault,
): void {
  const lease = acquireLease();
  if ('skipped' in lease) throw new Error(`Another Genie lifecycle command is active: ${lease.skipped}`);
  try {
    const selection = resolveIntegrationSelection(options);
    writeConsent(selection);
    if (options.skipV4Cleanup) {
      console.log('\x1b[2mSkipping v4 legacy cleanup (--skip-v4-cleanup).\x1b[0m');
    } else {
      runV4Cleanup();
    }
    // Converge only selected agent homes: fix the bin/ layout mismatch, then sync in-process
    // (the freshly-linked binary is already this version, so no re-exec needed).
    const normalized = normalizeLayout(GENIE_HOME);
    if (normalized !== undefined) {
      for (const outcome of normalized) printAuxiliaryOutcome(outcome);
      const failed = normalized.filter((outcome) => outcome.status === 'failed');
      if (failed.length > 0) {
        throw new Error(`Install payload convergence failed: ${failed.map((outcome) => outcome.label).join(', ')}`);
      }
    }
    // Codex is now converged end-to-end (plugin → single health proof →
    // fallback retirement → role agents) through runIntegrations; agent-sync
    // never writes Genie product skills into ~/.agents/skills (R2) because
    // `runAgentSync` has no codex arm at all — structural, not selection-gated.
    // Integrations run BEFORE the Claude/hermes agent-sync so a plugin-incapable
    // Codex leaves Claude trees byte-identical (R1/A2).
    // Group C install gate: a pending Codex generation (installed N ≠ delivered
    // T) is DEFERRED — converge role agents only and exclude Codex from the
    // plugin convergence, so install never advances the cache. A fresh/absent or
    // same-version plugin converges normally.
    const codexDeferral = classifyCodexInstall(selection);
    const results =
      codexDeferral !== null
        ? [buildInstallCodexDeferral(codexDeferral.installedVersion), ...runIntegrations(claudeOnlyScope(selection))]
        : runIntegrations({ selection });
    for (const result of results) {
      const glyph = result.ok ? '\x1b[32m+\x1b[0m' : '\x1b[33m!\x1b[0m';
      const disabled = result.preservedDisabled ? '; disabled state preserved' : '';
      console.log(`  ${glyph} ${result.runtime}: ${result.detail}${disabled}`);
    }
    const codexFailed = results.some((result) => result.runtime === 'codex' && !result.ok);
    if (selection !== 'auto' && selection !== 'none') {
      const failed = results.filter((result) => !result.ok);
      if (failed.length > 0)
        throw new Error(`Requested integration failed: ${failed.map((r) => r.runtime).join(', ')}`);
    }
    const agentSyncSelection = narrowAgentSyncSelection(selection);
    if (agentSyncSelection !== null) {
      if (!codexFailed) {
        runSync(agentSyncSelection);
      } else {
        // selection === 'auto' is the only surviving case here: an explicit
        // --integrations all/claude/codex codex failure already threw above,
        // so a silent codexFailed-guarded skip here would otherwise exit 0
        // with agent-sync never having run and no trace of why.
        console.log(
          '  \x1b[33m!\x1b[0m Skipped agent-sync: codex integration failed under --integrations auto (rerun with --integrations claude to sync Claude/hermes only, or fix codex and rerun).',
        );
      }
    }
    if (results.some((result) => result.runtime === 'codex' && result.ok && result.hookReviewRequired)) {
      console.log('  \x1b[33m!\x1b[0m Review Genie hooks with /hooks, then start a new Codex task.');
    }
    // Delivered-but-action-required (Codex generation deferred): exit 2 with the
    // one A-owned result trailer and no all-green footer. install.sh maps this to
    // an installer exit 2 (deliverable 3).
    if (results.some((result) => result.actionRequired === true)) {
      process.exitCode = 2;
      console.log(CODEX_DELIVERY_RESULT_TRAILER);
    }
  } finally {
    lease.release();
  }
}

/**
 * Gate the agent-sync scope for install. R2/A1 (agent-sync must never write
 * codex product skills into ~/.agents/skills) is now structural in
 * `runAgentSync` itself — there is no `codex` arm to narrow away from — so
 * this only needs to skip agent-sync where it has nothing to do: `none`
 * (nothing selected) and `codex` (codex converges entirely through
 * `installCodexIntegration`, never through agent-sync). Every other selection
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
