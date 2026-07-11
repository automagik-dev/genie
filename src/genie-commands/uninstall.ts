/**
 * Genie Uninstall Command
 *
 * Removes Genie CLI entirely:
 * - Remove hook script from ~/.claude/hooks
 * - Delete ~/.genie directory
 * - Remove symlinks from ~/.local/bin
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { confirm } from '@inquirer/prompts';
import {
  MANAGED_BY,
  MANIFEST_NAME,
  acquireLifecycleLease,
  codexLegacyCuratedDir,
  computeDirDigest,
  inspectManagedWorkflow,
  resolveAgentsSkillsDir,
} from '../lib/agent-sync.js';
import { hookScriptExists, removeHookScript } from '../lib/claude-settings.js';
import { contractPath, getGenieDir } from '../lib/genie-config.js';
import { resolveClaudeDir, resolveCodexDir, resolveGenieHome, resolveHermesHome } from '../lib/genie-home.js';
import {
  inspectCodexAgentOwnership,
  inspectRuntimeIntegrationEvidence,
  removeRuntimeIntegrations,
} from '../lib/runtime-integrations.js';
import { orchestrationRulesPath } from './legacy-v4.js';

// Shared v4 legacy manifest owns this path — see legacy-v4.ts.
const ORCHESTRATION_RULES_PATH = orchestrationRulesPath();

const LOCAL_BIN = join(homedir(), '.local', 'bin');

// Symlinks that may have been created by source install
const SYMLINKS = ['genie', 'term'];

export interface PathContainmentApi {
  resolve: (...paths: string[]) => string;
  relative: (from: string, to: string) => string;
  isAbsolute: (path: string) => boolean;
  sep: string;
}

const HOST_PATH_CONTAINMENT_API: PathContainmentApi = { resolve, relative, isAbsolute, sep };

/** Return true only when `candidate` is the same path as `parent` or canonically beneath it. */
export function isSameOrContainedPath(
  parent: string,
  candidate: string,
  pathApi: PathContainmentApi = HOST_PATH_CONTAINMENT_API,
): boolean {
  const relativePath = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(candidate));
  return (
    relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relativePath))
  );
}

/** Prove a named link resolves to the corresponding canonical Genie binary, including dangling links. */
export function isGenieSymlink(path: string, genieDir = getGenieDir()): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) return false;
    const name = path.slice(path.lastIndexOf(sep) + 1);
    if (!SYMLINKS.includes(name)) return false;
    const resolvedTarget = resolve(dirname(path), readlinkSync(path));
    return resolvedTarget === resolve(genieDir, 'bin', name);
  } catch {
    return false;
  }
}

/**
 * Remove genie symlinks from ~/.local/bin
 */
export function removeSymlinks(
  localBin = LOCAL_BIN,
  genieDir = getGenieDir(),
): { removed: string[]; failures: Array<{ path: string; detail: string }> } {
  const removed: string[] = [];
  const failures: Array<{ path: string; detail: string }> = [];

  for (const name of SYMLINKS) {
    const symlinkPath = join(localBin, name);
    if (isGenieSymlink(symlinkPath, genieDir)) {
      try {
        unlinkSync(symlinkPath);
        removed.push(name);
      } catch (error) {
        failures.push({ path: symlinkPath, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return { removed, failures };
}

// ============================================================================
// agent-sync managed assets (wish agent-sync) — removed only when provably ours
// ============================================================================

// The managed-dir contract mirrored from src/lib/agent-sync.ts. Uninstall only
// removes what genie provably shipped: skill dirs carrying this manifest, the
// stamped council.js, and the hermes symlink that resolves into the genie home.
// Protocol identifiers imported from the engine — single source of truth.
const SYNC_MANIFEST_NAME = MANIFEST_NAME;
const SYNC_MANAGED_BY = MANAGED_BY;

interface AgentSyncRemovalTargets {
  claudeDir?: string;
  codexDir?: string;
  /** Shared `~/.agents/skills` tier codex skills are synced into (detection root stays `codexDir`). */
  agentsSkillsDir?: string;
  hermesHome?: string;
  genieHome?: string;
}

/** Legacy suffix used by older uninstalls; those relinquished dirs remain invisible. */
const LEGACY_KEPT_MARKER = '.genie-kept';

interface AgentSyncAsset {
  agent: 'claude' | 'codex' | 'hermes';
  kind: 'skill' | 'workflow' | 'link';
  path: string;
  /** True when content diverged or ownership metadata is corrupt; uninstall preserves it. */
  modified?: boolean;
  /** Workflow-only digest ownership sidecar removed together with a clean target. */
  metadataPath?: string;
}

/**
 * Classify a skill dir against the agent-sync ownership contract:
 * - `null` — no genie-agent-sync manifest → not ours, invisible to uninstall.
 * - `'clean'` — manifest present AND `computeDirDigest(dir)` matches its digest → provably shipped by genie.
 * - `'modified'` — manifest present but content diverged (or digest missing/uncomputable) → user data lives here.
 */
function classifyManagedSkillDir(dir: string): 'clean' | 'modified' | null {
  let parsed: { managedBy?: string; digest?: string };
  try {
    parsed = JSON.parse(readFileSync(join(dir, SYNC_MANIFEST_NAME), 'utf8')) as { managedBy?: string; digest?: string };
  } catch {
    return null;
  }
  if (parsed.managedBy !== SYNC_MANAGED_BY) return null;
  if (typeof parsed.digest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.digest)) return 'modified';
  try {
    return computeDirDigest(dir) === parsed.digest ? 'clean' : 'modified';
  } catch {
    return 'modified';
  }
}

function collectManagedSkillDirs(parent: string, agent: AgentSyncAsset['agent'], out: AgentSyncAsset[]): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    // Dirs a previous uninstall already relinquished are the user's now — never re-collect.
    if (name.includes(LEGACY_KEPT_MARKER)) continue;
    const dir = join(parent, name);
    let isDir = false;
    try {
      isDir = lstatSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    const disposition = classifyManagedSkillDir(dir);
    if (disposition) out.push({ agent, kind: 'skill', path: dir, modified: disposition === 'modified' });
  }
}

function collectManagedCouncil(claudeDir: string, out: AgentSyncAsset[]): void {
  const workflow = inspectManagedWorkflow(join(claudeDir, 'workflows'));
  if (workflow.state === 'unmanaged') return;
  out.push({
    agent: 'claude',
    kind: 'workflow',
    path: workflow.targetPath,
    metadataPath: workflow.manifestPath,
    modified: workflow.state !== 'managed-clean',
  });
}

/** The hermes plugin link is ours only when the symlink resolves into the genie home. */
function collectHermesLinkPath(linkPath: string, genieHome: string, out: AgentSyncAsset[]): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return;
  }
  if (!stat.isSymbolicLink()) return;
  try {
    const resolved = resolve(dirname(linkPath), readlinkSync(linkPath));
    const home = resolve(genieHome);
    if (isSameOrContainedPath(home, resolved)) out.push({ agent: 'hermes', kind: 'link', path: linkPath });
  } catch {
    /* unreadable symlink → leave it */
  }
}

function collectHermesLinks(hermesHome: string, genieHome: string, out: AgentSyncAsset[]): void {
  collectHermesLinkPath(join(hermesHome, 'plugins', 'genie'), genieHome, out);
  const profilesRoot = join(hermesHome, 'profiles');
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true }) as never;
  } catch {
    return;
  }
  for (const entry of entries as unknown as Array<{
    name: string;
    isDirectory: () => boolean;
    isSymbolicLink: () => boolean;
  }>) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.name) || entry.name === '.' || entry.name === '..') continue;
    const profileRoot = resolve(profilesRoot, entry.name);
    if (!isSameOrContainedPath(profilesRoot, profileRoot)) continue;
    collectHermesLinkPath(join(profileRoot, 'plugins', 'genie'), genieHome, out);
  }
}

/** Read-only scan for genie-managed agent assets (skills, stamped council.js, hermes link). */
export function collectAgentSyncAssets(targets: AgentSyncRemovalTargets = {}): AgentSyncAsset[] {
  const claudeDir = targets.claudeDir ?? resolveClaudeDir();
  const codexDir = targets.codexDir ?? resolveCodexDir();
  const hermesHome = targets.hermesHome ?? resolveHermesHome();
  const genieHome = targets.genieHome ?? resolveGenieHome();
  const out: AgentSyncAsset[] = [];
  collectManagedSkillDirs(join(claudeDir, 'skills'), 'claude', out);
  // Live codex tier + the retired `.curated` lane (machines that never synced
  // post-migration still carry managed dirs there). Manifest-gated either way —
  // unmanaged siblings in the shared ~/.agents/skills tier are invisible.
  collectManagedSkillDirs(targets.agentsSkillsDir ?? resolveAgentsSkillsDir(), 'codex', out);
  collectManagedSkillDirs(codexLegacyCuratedDir(codexDir), 'codex', out);
  collectManagedCouncil(claudeDir, out);
  collectHermesLinks(hermesHome, genieHome, out);
  return out;
}

export interface AgentSyncRemovalResult {
  /** Assets deleted outright (digest-clean skills, stamped council.js, hermes link). */
  removed: string[];
  /** User-modified/corrupt-metadata assets preserved byte-identically at their current paths. */
  kept: string[];
  /** Per-asset failures. Callers keep Genie installed so cleanup can be retried. */
  failures: Array<{ path: string; detail: string }>;
}

/**
 * Remove every asset {@link collectAgentSyncAssets} finds — except managed skill
 * dirs whose digest diverged from their manifest: those hold user edits and are
 * left byte-identical at the same path. Uninstall does not get to rename,
 * disable, rewrite, or relinquish ownership of a user-modified artifact.
 */
export function removeAgentSyncAssets(targets: AgentSyncRemovalTargets = {}): AgentSyncRemovalResult {
  const removed: string[] = [];
  const kept: string[] = [];
  const failures: AgentSyncRemovalResult['failures'] = [];
  for (const asset of collectAgentSyncAssets(targets)) {
    try {
      if (asset.modified) {
        kept.push(asset.path);
      } else if (asset.kind === 'workflow' && asset.metadataPath) {
        // Re-check immediately before deletion so a workflow edited after the
        // initial scan is preserved. Remove metadata first; if target removal
        // fails, restore the sidecar so the cleanup remains retryable.
        const current = inspectManagedWorkflow(join(targets.claudeDir ?? resolveClaudeDir(), 'workflows'));
        if (current.state !== 'managed-clean') {
          kept.push(asset.path);
          continue;
        }
        const metadata = readFileSync(asset.metadataPath);
        unlinkSync(asset.metadataPath);
        try {
          unlinkSync(asset.path);
        } catch (error) {
          writeFileSync(asset.metadataPath, metadata);
          throw error;
        }
        removed.push(asset.path);
      } else {
        if (asset.kind === 'skill') {
          // Revalidate immediately before the destructive step. The initial
          // scan is only a preview; user edits that land before confirmation
          // revoke Genie's deletion authority.
          if (classifyManagedSkillDir(asset.path) !== 'clean') {
            kept.push(asset.path);
            continue;
          }
          rmSync(asset.path, { recursive: true, force: true });
        } else unlinkSync(asset.path);
        removed.push(asset.path);
      }
    } catch (error) {
      failures.push({ path: asset.path, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed, kept, failures };
}

interface UninstallFailure {
  step: string;
  detail: string;
}

interface UninstallResult {
  failures: UninstallFailure[];
}

export interface UninstallWorkSnapshot {
  hasGenieDir: boolean;
  hasHookScript: boolean;
  hasOrchestrationRules: boolean;
  symlinkCount: number;
  hasAgentAssets: boolean;
  codexRoleInventoryStatus: 'missing' | 'valid' | 'corrupt';
  runtimeEvidence: { codex: boolean; claude: boolean };
  removeMarketplace: boolean;
}

export function hasUninstallWork(snapshot: UninstallWorkSnapshot): boolean {
  return (
    snapshot.hasGenieDir ||
    snapshot.hasHookScript ||
    snapshot.hasOrchestrationRules ||
    snapshot.symlinkCount > 0 ||
    snapshot.hasAgentAssets ||
    snapshot.codexRoleInventoryStatus !== 'missing' ||
    snapshot.runtimeEvidence.codex ||
    snapshot.runtimeEvidence.claude ||
    snapshot.removeMarketplace
  );
}

function removeSyncedAgentAssets(hasAgentAssets: boolean, failures: UninstallFailure[]): void {
  if (!hasAgentAssets) return;
  console.log('\x1b[2mRemoving synced agent assets...\x1b[0m');
  const { removed, kept, failures: assetFailures } = removeAgentSyncAssets();
  if (assetFailures.length === 0) {
    console.log(`  \x1b[32m+\x1b[0m Removed ${removed.length} managed asset(s) (skills / council.js / hermes link)`);
  }
  if (kept.length > 0) {
    console.log(`  \x1b[33m!\x1b[0m Kept ${kept.length} managed asset(s) byte-identical:`);
    for (const path of kept) console.log(`      \x1b[33m${contractPath(path)}\x1b[0m`);
  }
  for (const failure of assetFailures) {
    failures.push({ step: `Removing synced asset ${contractPath(failure.path)}`, detail: failure.detail });
  }
}

function removeIntegrationState(removeMarketplace: boolean, failures: UninstallFailure[]): void {
  const integrations = removeRuntimeIntegrations(removeMarketplace);
  for (const name of integrations.agents.keptModified) {
    console.log(`  \x1b[33m!\x1b[0m Kept modified Codex role agent byte-identical: ${name}`);
  }
  for (const failure of integrations.agents.failures) {
    failures.push({ step: `Removing Codex role agent ${failure.name}`, detail: failure.detail });
  }
  for (const step of integrations.steps) {
    if (!step.ok) failures.push({ step: `Removing ${step.runtime} ${step.operation}`, detail: step.detail });
  }
}

/** Try an uninstall step, logging success or warning and returning structured failure. */
function tryRemoveStep(label: string, successMsg: string, fn: () => void): UninstallFailure | null {
  console.log(`\x1b[2m${label}\x1b[0m`);
  try {
    fn();
    console.log(`  \x1b[32m+\x1b[0m ${successMsg}`);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  \x1b[33m!\x1b[0m ${label.replace('...', '')} failed: ${message}`);
    return { step: label.replace('...', ''), detail: message };
  }
}

/**
 * Uninstall Genie CLI entirely
 */
function performUninstall(
  hasHookScript: boolean,
  existingSymlinks: string[],
  genieDir: string,
  hasGenieDir: boolean,
  hasAgentAssets: boolean,
  removeMarketplace: boolean,
): UninstallResult {
  const failures: UninstallFailure[] = [];
  if (hasHookScript) {
    const failure = tryRemoveStep('Removing hook script...', 'Hook script removed', () => removeHookScript());
    if (failure) failures.push(failure);
  }

  if (existingSymlinks.length > 0) {
    console.log('\x1b[2mRemoving symlinks...\x1b[0m');
    const symlinks = removeSymlinks(LOCAL_BIN, genieDir);
    const removed = symlinks.removed;
    if (removed.length > 0) {
      console.log(`  \x1b[32m+\x1b[0m Removed: ${removed.join(', ')}`);
    }
    for (const failure of symlinks.failures) {
      failures.push({ step: `Removing symlink ${contractPath(failure.path)}`, detail: failure.detail });
    }
  }

  if (existsSync(ORCHESTRATION_RULES_PATH)) {
    const failure = tryRemoveStep(
      'Removing orchestration rules...',
      `Orchestration rules removed (${contractPath(ORCHESTRATION_RULES_PATH)})`,
      () => unlinkSync(ORCHESTRATION_RULES_PATH),
    );
    if (failure) failures.push(failure);
  }

  // Managed assets live outside GENIE_HOME, so remove them before deleting it.
  removeSyncedAgentAssets(hasAgentAssets, failures);
  removeIntegrationState(removeMarketplace, failures);

  // Preserve the CLI and external recovery root while any requested removal is
  // incomplete, otherwise the user loses the easiest retry path.
  if (hasGenieDir && failures.length === 0) {
    const failure = tryRemoveStep('Removing genie directory...', 'Directory removed', () =>
      rmSync(genieDir, { recursive: true, force: true }),
    );
    if (failure) failures.push(failure);
  }
  return { failures };
}

export async function uninstallCommand(options: { removeMarketplace?: boolean } = {}): Promise<void> {
  const lifecycleLease = acquireLifecycleLease(getGenieDir());
  if ('skipped' in lifecycleLease)
    throw new Error(`Another Genie lifecycle command is active: ${lifecycleLease.skipped}`);
  try {
    console.log();
    console.log('\x1b[1m\x1b[33m Uninstall Genie CLI\x1b[0m');
    console.log();

    const genieDir = getGenieDir();
    const hasGenieDir = existsSync(genieDir);
    const hasHookScript = hookScriptExists();
    const hasOrchestrationRules = existsSync(ORCHESTRATION_RULES_PATH);
    const existingSymlinks = SYMLINKS.filter((name) => isGenieSymlink(join(LOCAL_BIN, name), genieDir));
    const agentAssets = collectAgentSyncAssets();
    const hasAgentAssets = agentAssets.length > 0;
    const codexRoleAgents = inspectCodexAgentOwnership();
    const managedRoleAgents = codexRoleAgents.entries.filter((entry) => entry.ownership.startsWith('managed-'));
    const runtimeEvidence = inspectRuntimeIntegrationEvidence();

    console.log('\x1b[2mThis will remove:\x1b[0m');
    console.log('  \x1b[31m-\x1b[0m Genie plugins and digest-owned Codex role agents');
    if (options.removeMarketplace) console.log('  \x1b[31m-\x1b[0m Automagik client marketplace registrations');
    if (hasHookScript) console.log('  \x1b[31m-\x1b[0m Hook script (~/.claude/hooks/genie-bash-hook.sh)');
    if (hasOrchestrationRules)
      console.log(`  \x1b[31m-\x1b[0m Orchestration rules (${contractPath(ORCHESTRATION_RULES_PATH)})`);
    if (hasGenieDir) console.log(`  \x1b[31m-\x1b[0m Genie directory (${contractPath(genieDir)})`);
    if (existingSymlinks.length > 0)
      console.log(`  \x1b[31m-\x1b[0m Symlinks from ~/.local/bin: ${existingSymlinks.join(', ')}`);
    const keptAssets = agentAssets.filter((asset) => asset.modified);
    const removableAssets = agentAssets.length - keptAssets.length;
    if (removableAssets > 0)
      console.log(
        `  \x1b[31m-\x1b[0m Synced agent assets: ${removableAssets} unmodified managed skill dir(s)/council.js/hermes link across claude/codex/hermes`,
      );
    if (keptAssets.length > 0) {
      console.log(
        `  \x1b[33m~\x1b[0m KEPT byte-identical (modified or ownership metadata needs review): ${keptAssets.length} managed asset(s):`,
      );
      for (const asset of keptAssets) console.log(`      \x1b[33m${contractPath(asset.path)}\x1b[0m`);
    }
    if (managedRoleAgents.length > 0) {
      const modified = managedRoleAgents.filter((entry) => entry.ownership === 'managed-modified').length;
      console.log(
        `  \x1b[31m-\x1b[0m Codex role agents: ${managedRoleAgents.length - modified} clean; ${modified} modified will be kept byte-identical`,
      );
    }
    if (codexRoleAgents.status === 'corrupt') {
      console.log('  \x1b[33m!\x1b[0m Codex role-agent ownership inventory is corrupt and requires review');
    }
    console.log();

    if (
      !hasUninstallWork({
        hasGenieDir,
        hasHookScript,
        hasOrchestrationRules,
        symlinkCount: existingSymlinks.length,
        hasAgentAssets,
        codexRoleInventoryStatus: codexRoleAgents.status,
        runtimeEvidence,
        removeMarketplace: options.removeMarketplace ?? false,
      })
    ) {
      console.log('\x1b[33mNothing to uninstall.\x1b[0m');
      console.log();
      return;
    }

    const proceed = await confirm({ message: 'Are you sure you want to uninstall Genie CLI?', default: false });
    if (!proceed) {
      console.log();
      console.log('\x1b[2mUninstall cancelled.\x1b[0m');
      console.log();
      return;
    }

    console.log();
    const result = performUninstall(
      hasHookScript,
      existingSymlinks,
      genieDir,
      hasGenieDir,
      hasAgentAssets,
      options.removeMarketplace ?? false,
    );

    console.log();
    if (result.failures.length > 0) {
      process.exitCode = 1;
      console.log('\x1b[31m!\x1b[0m Genie CLI uninstall is incomplete; no success was reported.');
      for (const failure of result.failures) {
        console.log(`  \x1b[31m-\x1b[0m ${failure.step}: ${failure.detail}`);
      }
      if (hasGenieDir && existsSync(genieDir)) {
        console.log(`  \x1b[33m!\x1b[0m Kept ${contractPath(genieDir)} so you can retry \`genie uninstall\`.`);
      }
      console.log();
      return;
    }
    console.log('\x1b[32m+\x1b[0m Genie CLI uninstalled.');
    console.log();
    console.log('\x1b[2mNote: If you installed via npm/bun, also run:\x1b[0m');
    console.log('  \x1b[36mbun remove -g @automagik/genie\x1b[0m');
    console.log('  \x1b[2mor\x1b[0m');
    console.log('  \x1b[36mnpm uninstall -g @automagik/genie\x1b[0m');
    console.log();
  } finally {
    lifecycleLease.release();
  }
}
