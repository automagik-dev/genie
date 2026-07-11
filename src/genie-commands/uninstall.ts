/**
 * Genie Uninstall Command
 *
 * Removes Genie CLI entirely:
 * - Remove hook script from ~/.claude/hooks
 * - Delete ~/.genie directory
 * - Remove symlinks from ~/.local/bin
 */

import {
  type Dirent,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { confirm } from '@inquirer/prompts';
import {
  acquireLifecycleLease,
  codexLegacyCuratedDir,
  inspectManagedSkillTree,
  inspectManagedWorkflow,
  recoverManagedWorkflowTransactions,
  removeManagedSkillTree,
  removeManagedWorkflow,
  resolveAgentsSkillsDir,
} from '../lib/agent-sync.js';
import { hookScriptExists } from '../lib/claude-settings.js';
import { contractPath, getGenieDir } from '../lib/genie-config.js';
import { resolveClaudeDir, resolveCodexDir, resolveGenieHome, resolveHermesHome } from '../lib/genie-home.js';
import {
  inspectCodexAgentOwnership,
  inspectRuntimeIntegrationEvidence,
  removeRuntimeIntegrations,
} from '../lib/runtime-integrations.js';
import { detectV4Install } from './legacy-v4.js';

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

export interface AgentSyncRemovalTargets {
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
  const state = inspectManagedSkillTree(dir).state;
  if (state === 'unmanaged') return null;
  return state === 'managed-clean' ? 'clean' : 'modified';
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
  let entries: Dirent[];
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
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

export interface AgentSyncRemovalOptions {
  beforeManagedDirRemoval?: (destDir: string, stage: 'before-park' | 'before-delete') => void;
  beforeWorkflowRemoval?: (stage: 'before-park' | 'before-delete') => void;
}

function recoverCouncilBeforeRemoval(targets: AgentSyncRemovalTargets): { path: string; detail: string } | null {
  const workflowDir = join(targets.claudeDir ?? resolveClaudeDir(), 'workflows');
  try {
    recoverManagedWorkflowTransactions(workflowDir);
    return null;
  } catch (error) {
    return {
      path: workflowDir,
      detail: `pending council workflow transaction could not be recovered; no agent assets were removed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Remove every asset {@link collectAgentSyncAssets} finds — except managed skill
 * dirs whose digest diverged from their manifest: those hold user edits and are
 * left byte-identical at the same path. Uninstall does not get to rename,
 * disable, rewrite, or relinquish ownership of a user-modified artifact.
 */
export function removeAgentSyncAssets(
  targets: AgentSyncRemovalTargets = {},
  options: AgentSyncRemovalOptions = {},
): AgentSyncRemovalResult {
  const removed: string[] = [];
  const kept: string[] = [];
  const failures: AgentSyncRemovalResult['failures'] = [];
  const recoveryFailure = recoverCouncilBeforeRemoval(targets);
  if (recoveryFailure) return { removed, kept, failures: [recoveryFailure] };
  removeCollectedAgentAssets(collectAgentSyncAssets(targets), targets, options, { removed, kept, failures });
  return { removed, kept, failures };
}

function removeCollectedAgentAssets(
  assets: AgentSyncAsset[],
  targets: AgentSyncRemovalTargets,
  options: AgentSyncRemovalOptions,
  result: AgentSyncRemovalResult,
): void {
  for (const asset of assets) {
    try {
      if (asset.modified) {
        result.kept.push(asset.path);
      } else if (asset.kind === 'workflow' && asset.metadataPath) {
        const disposition = removeManagedWorkflow(join(targets.claudeDir ?? resolveClaudeDir(), 'workflows'), {
          beforeRemoval: options.beforeWorkflowRemoval,
        });
        if (disposition !== 'removed') {
          result.kept.push(asset.path);
          continue;
        }
        result.removed.push(asset.path);
      } else {
        if (asset.kind === 'skill') {
          const disposition = removeManagedSkillTree(asset.path, {
            genieHome: targets.genieHome,
            agent: asset.agent,
            beforeManagedDirRemoval: options.beforeManagedDirRemoval,
          });
          if (disposition !== 'removed') {
            result.kept.push(asset.path);
            continue;
          }
        } else unlinkSync(asset.path);
        result.removed.push(asset.path);
      }
    } catch (error) {
      result.failures.push({ path: asset.path, detail: error instanceof Error ? error.message : String(error) });
    }
  }
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

export interface UninstallPlan {
  genieDir: string;
  hasGenieDir: boolean;
  hasUnprovenHookScript: boolean;
  legacyReport: ReturnType<typeof detectV4Install>;
  hasOwnedRules: boolean;
  existingSymlinks: string[];
  agentAssets: AgentSyncAsset[];
  hasAgentAssets: boolean;
  codexRoleAgents: ReturnType<typeof inspectCodexAgentOwnership>;
  managedRoleAgents: ReturnType<typeof inspectCodexAgentOwnership>['entries'];
  runtimeEvidence: ReturnType<typeof inspectRuntimeIntegrationEvidence>;
  removeMarketplace: boolean;
}

export interface UninstallPlanInspectors {
  hasGenieDir?: (path: string) => boolean;
  hookScriptExists?: () => boolean;
  detectV4Install?: typeof detectV4Install;
  existingSymlinks?: (genieDir: string) => string[];
  collectAgentSyncAssets?: typeof collectAgentSyncAssets;
  inspectCodexAgentOwnership?: typeof inspectCodexAgentOwnership;
  inspectRuntimeIntegrationEvidence?: typeof inspectRuntimeIntegrationEvidence;
}

/** Build a complete read-only uninstall plan. Call again under the lease before mutation. */
export function inspectUninstallPlan(
  genieDir = getGenieDir(),
  removeMarketplace = false,
  inspectors: UninstallPlanInspectors = {},
): UninstallPlan {
  const legacyReport = (inspectors.detectV4Install ?? detectV4Install)();
  const agentAssets = (inspectors.collectAgentSyncAssets ?? collectAgentSyncAssets)();
  const codexRoleAgents = (inspectors.inspectCodexAgentOwnership ?? inspectCodexAgentOwnership)();
  return {
    genieDir,
    hasGenieDir: (inspectors.hasGenieDir ?? existsSync)(genieDir),
    hasUnprovenHookScript: (inspectors.hookScriptExists ?? hookScriptExists)(),
    legacyReport,
    hasOwnedRules: legacyReport.rulesFile.status === 'v4-markers',
    existingSymlinks:
      inspectors.existingSymlinks?.(genieDir) ??
      SYMLINKS.filter((name) => isGenieSymlink(join(LOCAL_BIN, name), genieDir)),
    agentAssets,
    hasAgentAssets: agentAssets.length > 0,
    codexRoleAgents,
    managedRoleAgents: codexRoleAgents.entries.filter((entry) => entry.ownership.startsWith('managed-')),
    runtimeEvidence: (inspectors.inspectRuntimeIntegrationEvidence ?? inspectRuntimeIntegrationEvidence)(),
    removeMarketplace,
  };
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

/** Remove only marker-proven v4 rules, with recovery outside the deleted Genie home. */
function removeProvenV4Rules(genieDir: string): void {
  const report = detectV4Install();
  if (report.rulesFile.status !== 'v4-markers') return;
  const recoveryRoot = join(dirname(resolve(genieDir)), '.genie-recovery', 'uninstall-v4');
  mkdirSync(recoveryRoot, { recursive: true });
  const backup = join(recoveryRoot, `${basename(report.rulesFile.path)}.${Date.now()}`);
  copyFileSync(report.rulesFile.path, backup);
  unlinkSync(report.rulesFile.path);
}

/**
 * Uninstall Genie CLI entirely
 */
function performUninstall(
  ownedRulesPath: string | null,
  existingSymlinks: string[],
  genieDir: string,
  hasGenieDir: boolean,
  hasAgentAssets: boolean,
  removeMarketplace: boolean,
): UninstallResult {
  const failures: UninstallFailure[] = [];
  if (ownedRulesPath) {
    const failure = tryRemoveStep(
      'Backing up and removing marker-proven v4 orchestration rules...',
      `Marker-proven orchestration rules removed (${contractPath(ownedRulesPath)})`,
      () => removeProvenV4Rules(genieDir),
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
  // Keep the normal command path available whenever any failure-prone cleanup
  // or GENIE_HOME removal failed. Once the home is gone, only dangling source-
  // install links remain and can be removed as the final commit step.
  if (existingSymlinks.length > 0 && failures.length === 0) {
    console.log('\x1b[2mRemoving symlinks...\x1b[0m');
    const symlinks = removeSymlinks(LOCAL_BIN, genieDir);
    if (symlinks.removed.length > 0) console.log(`  \x1b[32m+\x1b[0m Removed: ${symlinks.removed.join(', ')}`);
    for (const failure of symlinks.failures) {
      failures.push({ step: `Removing symlink ${contractPath(failure.path)}`, detail: failure.detail });
    }
  }
  return { failures };
}

function performFreshUninstallPlan(
  genieDir: string,
  removeMarketplace: boolean,
): {
  execution: UninstallPlan;
  result: UninstallResult;
} {
  const execution = inspectUninstallPlan(genieDir, removeMarketplace);
  const ownedRulesPath = execution.hasOwnedRules ? execution.legacyReport.rulesFile.path : null;
  return {
    execution,
    result: performUninstall(
      ownedRulesPath,
      execution.existingSymlinks,
      genieDir,
      execution.hasGenieDir,
      execution.hasAgentAssets,
      execution.removeMarketplace,
    ),
  };
}

export async function uninstallCommand(options: { removeMarketplace?: boolean } = {}): Promise<void> {
  console.log();
  console.log('\x1b[1m\x1b[33m Uninstall Genie CLI\x1b[0m');
  console.log();

  // Preview is strictly read-only. Recovery and the lifecycle lease begin only
  // after confirmation, and destructive helpers revalidate ownership again.
  const preview = inspectUninstallPlan(getGenieDir(), options.removeMarketplace ?? false);
  const {
    genieDir,
    hasGenieDir,
    hasUnprovenHookScript,
    legacyReport,
    hasOwnedRules,
    existingSymlinks,
    agentAssets,
    hasAgentAssets,
    codexRoleAgents,
    managedRoleAgents,
    runtimeEvidence,
  } = preview;
  const rulesStatus = legacyReport.rulesFile.status;
  const rulesPath = legacyReport.rulesFile.path;

  console.log('\x1b[2mThis will remove:\x1b[0m');
  console.log('  \x1b[31m-\x1b[0m Genie plugins and digest-owned Codex role agents');
  if (options.removeMarketplace) console.log('  \x1b[31m-\x1b[0m Automagik client marketplace registrations');
  if (hasOwnedRules)
    console.log(`  \x1b[31m-\x1b[0m Marker-proven v4 orchestration rules (${contractPath(rulesPath)})`);
  if (hasUnprovenHookScript)
    console.log('  \x1b[33m~\x1b[0m KEPT unproven hook script (~/.claude/hooks/genie-bash-hook.sh)');
  if (rulesStatus === 'user-modified')
    console.log(`  \x1b[33m~\x1b[0m KEPT unproven orchestration rules (${contractPath(rulesPath)})`);
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
      hasHookScript: false,
      hasOrchestrationRules: hasOwnedRules,
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

  const lifecycleLease = acquireLifecycleLease(genieDir);
  if ('skipped' in lifecycleLease)
    throw new Error(`Another Genie lifecycle command is active: ${lifecycleLease.skipped}`);
  try {
    console.log();
    // The prompt may remain open while another lifecycle process finishes.
    // Discard every preview decision and rebuild the complete plan under the
    // lease; destructive helpers still perform their per-artifact CAS checks.
    const { execution, result } = performFreshUninstallPlan(genieDir, options.removeMarketplace ?? false);

    console.log();
    if (result.failures.length > 0) {
      process.exitCode = 1;
      console.log('\x1b[31m!\x1b[0m Genie CLI uninstall is incomplete; no success was reported.');
      for (const failure of result.failures) {
        console.log(`  \x1b[31m-\x1b[0m ${failure.step}: ${failure.detail}`);
      }
      if (execution.hasGenieDir && existsSync(genieDir)) {
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
