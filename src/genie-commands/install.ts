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

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type InstallIntegrationsOptions,
  type IntegrationSelection,
  installRuntimeIntegrations,
} from '../lib/runtime-integrations.js';
import { cleanupV4 } from './legacy-v4.js';
import { runAgentSyncSafe } from './update.js';

const GENIE_HOME = process.env.GENIE_HOME || join(homedir(), '.genie');

/** Auxiliary trees managed by `genie update`'s syncAuxiliaryContent. */
const AUX_LAYOUT_DIRS = ['plugins', 'skills', 'templates'] as const;

export interface InstallOptions {
  /** Set by --skip-v4-cleanup: leave v4-era artifacts in place. */
  skipV4Cleanup?: boolean;
  /** Which detected client integrations to install. Default: auto. */
  integrations?: IntegrationSelection;
  /** Alias for --integrations none. */
  skipIntegrations?: boolean;
}

type V4CleanupRunner = typeof cleanupV4;
type NormalizeAuxLayoutFn = (genieHome: string) => void;
type AgentSyncRunner = () => void;
type IntegrationRunner = (options?: InstallIntegrationsOptions) => ReturnType<typeof installRuntimeIntegrations>;

/**
 * Migrate the legacy `<home>/bin/{plugins,skills,templates}` layout (install.sh
 * pre-cutover) to the canonical `<home>/{plugins,skills,templates}` that
 * `genie update` and the agent-sync source resolver expect. Only moves a tree
 * when the bin/ copy exists AND the canonical target does not — a plain
 * same-filesystem `renameSync` is atomic, so readers never observe a partial
 * state. Best-effort per directory: a failure on one never aborts the rest or
 * the install.
 */
export function normalizeAuxLayout(genieHome: string): void {
  for (const name of AUX_LAYOUT_DIRS) {
    try {
      const binPath = join(genieHome, 'bin', name);
      const homePath = join(genieHome, name);
      if (existsSync(binPath) && !existsSync(homePath)) {
        mkdirSync(dirname(homePath), { recursive: true });
        renameSync(binPath, homePath);
      }
    } catch {
      // layout normalization is best-effort; never fail the install over it.
    }
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
  runSync: AgentSyncRunner = runAgentSyncSafe,
  runIntegrations: IntegrationRunner = installRuntimeIntegrations,
): void {
  if (options.skipV4Cleanup) {
    console.log('\x1b[2mSkipping v4 legacy cleanup (--skip-v4-cleanup).\x1b[0m');
  } else {
    runV4Cleanup();
  }
  // Always converge agents: fix the bin/ layout mismatch, then sync in-process
  // (the freshly-linked binary is already this version, so no re-exec needed).
  normalizeLayout(GENIE_HOME);
  runSync();

  const selection = options.skipIntegrations ? 'none' : (options.integrations ?? 'auto');
  if (!['auto', 'codex', 'claude', 'all', 'none'].includes(selection)) {
    throw new Error(`Invalid --integrations value: ${selection}`);
  }
  const results = runIntegrations({ selection });
  for (const result of results) {
    const glyph = result.ok ? '\x1b[32m+\x1b[0m' : '\x1b[33m!\x1b[0m';
    const disabled = result.preservedDisabled ? '; disabled state preserved' : '';
    console.log(`  ${glyph} ${result.runtime}: ${result.detail}${disabled}`);
  }
  if (selection !== 'auto' && selection !== 'none') {
    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0) throw new Error(`Requested integration failed: ${failed.map((r) => r.runtime).join(', ')}`);
  }
  if (results.some((result) => result.runtime === 'codex' && result.ok)) {
    console.log('  \x1b[33m!\x1b[0m Review Genie hooks with /hooks, then start a new Codex task.');
  }
}
