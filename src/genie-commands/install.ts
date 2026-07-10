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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { computeDirDigest } from '../lib/agent-sync.js';
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
 * Converge the extracted `<home>/bin/{plugins,skills,templates}` trees into
 * the canonical `<home>/{plugins,skills,templates}` layout that `genie update`
 * and the agent-sync source resolver expect.
 *
 * install.sh always extracts the tarball into `<home>/bin/`, so on a fresh
 * install the canonical targets are absent and a plain same-filesystem
 * `renameSync` (atomic — readers never observe a partial state) moves each
 * tree into place. On a REINSTALL over an existing install the canonical
 * targets already exist but are STALE — the fresh trees sit in bin/ and,
 * left there, agent-sync would converge agents from old content while
 * `genie update` reports "Already up to date". So when both sides exist,
 * the fresh tree is swapped in atomically unless it is provably identical:
 * the extracted `bin/VERSION` vs the canonical `<home>/VERSION` stamp when
 * both exist, per-tree content digest otherwise. A same-version reinstall
 * therefore stays an idempotent no-op. After adopting fresh trees the
 * canonical VERSION stamp is refreshed so the next run short-circuits.
 *
 * Best-effort per directory: a failure on one never aborts the rest or the
 * install.
 */
export function normalizeAuxLayout(genieHome: string): void {
  const binVersion = readVersionStamp(join(genieHome, 'bin', 'VERSION'));
  const homeVersion = readVersionStamp(join(genieHome, 'VERSION'));
  const sameVersion = binVersion !== null && homeVersion !== null ? binVersion === homeVersion : null;
  let adoptedFresh = false;
  for (const name of AUX_LAYOUT_DIRS) {
    try {
      const binPath = join(genieHome, 'bin', name);
      const homePath = join(genieHome, name);
      if (!existsSync(binPath)) continue;
      if (!existsSync(homePath)) {
        mkdirSync(dirname(homePath), { recursive: true });
        renameSync(binPath, homePath);
        continue;
      }
      // Reinstall over an existing install: bin/<name> is the freshly
      // extracted tree. Swap it in unless it is provably identical.
      const identical = sameVersion ?? computeDirDigest(binPath) === computeDirDigest(homePath);
      if (identical) continue;
      swapAuxTreeInPlace(binPath, homePath);
      adoptedFresh = true;
    } catch {
      // layout normalization is best-effort; never fail the install over it.
    }
  }
  if (adoptedFresh && binVersion !== null) {
    try {
      // Fresh trees adopted — refresh the canonical VERSION stamp so
      // resolveGenieSource/doctor report the just-installed version and the
      // next normalize run no-ops on the version match.
      writeFileSync(join(genieHome, 'VERSION'), `${binVersion}\n`);
    } catch {
      // best-effort; a stale stamp only costs a digest compare next run.
    }
  }
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
 * Atomic stage-next-to-target + rename dance for one auxiliary tree,
 * mirroring `swapAuxiliaryTree` in update.ts (not exported there; keep the
 * semantics in lockstep). Unlike update.ts — which copies out of a staging
 * extract dir — `src` here is the extracted `bin/<name>` tree under the same
 * `genieHome` filesystem, so it is MOVED into place (no copy, no bin/
 * residue). On failure the previous live tree is restored and the error
 * propagates to the caller's per-directory best-effort catch.
 */
function swapAuxTreeInPlace(src: string, dest: string): void {
  const staging = `${dest}.new`;
  const parked = `${dest}.old`;
  try {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    if (existsSync(parked)) rmSync(parked, { recursive: true, force: true });
    renameSync(src, staging); // fresh tree staged next to the target
    renameSync(dest, parked); // park the live tree
    renameSync(staging, dest); // fresh becomes live
    rmSync(parked, { recursive: true, force: true });
  } catch (err) {
    try {
      if (!existsSync(dest) && existsSync(parked)) renameSync(parked, dest);
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
    } catch {
      // give up; dest is in whatever state it's in
    }
    throw err;
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
