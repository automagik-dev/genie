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
  type IntegrationSelection,
  installRuntimeIntegrations,
  persistIntegrationConsent,
} from '../lib/runtime-integrations.js';
import { type AuxiliaryTreeOperations, type AuxiliaryTreeOutcome, convergeAuxiliaryTree } from './auxiliary-trees.js';
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
    // fallback retirement → role agents) through runIntegrations; agent-sync is
    // scoped to Claude only so it never re-writes Genie product skills into
    // ~/.agents/skills (R2). Integrations run BEFORE the Claude skill sync so a
    // plugin-incapable Codex leaves Claude trees byte-identical (R1/A2).
    const results = runIntegrations({ selection });
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
    if (agentSyncSelection !== null && !codexFailed) runSync(agentSyncSelection);
    if (results.some((result) => result.runtime === 'codex' && result.ok && result.hookReviewRequired)) {
      console.log('  \x1b[33m!\x1b[0m Review Genie hooks with /hooks, then start a new Codex task.');
    }
  } finally {
    lease.release();
  }
}

/**
 * Narrow a client selection to the agent-sync scope. Codex product skills now
 * live only in the plugin, so agent-sync (the sole ~/.agents/skills writer via
 * syncCodex) must never run for codex: `auto`/`all`/`claude` sync Claude only,
 * and `codex`/`none` skip agent-sync entirely (R2/A1). runIntegrations keeps the
 * full selection so codex still converges through installCodexIntegration.
 */
export function narrowAgentSyncSelection(selection: IntegrationSelection): 'claude' | null {
  return selection === 'auto' || selection === 'all' || selection === 'claude' ? 'claude' : null;
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
