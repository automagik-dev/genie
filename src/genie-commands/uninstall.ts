/**
 * Genie Uninstall Command
 *
 * Removes Genie CLI entirely:
 * - Remove hook script from ~/.claude/hooks
 * - Delete ~/.genie directory
 * - Remove symlinks from ~/.local/bin
 */

import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { MANAGED_BY, MANIFEST_NAME } from '../lib/agent-sync.js';
import { hookScriptExists, removeHookScript } from '../lib/claude-settings.js';
import { contractPath, getGenieDir } from '../lib/genie-config.js';
import { resolveClaudeDir, resolveCodexDir, resolveGenieHome, resolveHermesHome } from '../lib/genie-home.js';
import { orchestrationRulesPath } from './legacy-v4.js';

// Shared v4 legacy manifest owns this path — see legacy-v4.ts.
const ORCHESTRATION_RULES_PATH = orchestrationRulesPath();

const LOCAL_BIN = join(homedir(), '.local', 'bin');

// Symlinks that may have been created by source install
const SYMLINKS = ['genie', 'term'];

/**
 * Check if a path is a symlink pointing to genie bin
 */
function isGenieSymlink(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) return false;
    // We don't need to check target - if it's our binary name, remove it
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove genie symlinks from ~/.local/bin
 */
function removeSymlinks(): string[] {
  const removed: string[] = [];

  for (const name of SYMLINKS) {
    const symlinkPath = join(LOCAL_BIN, name);
    if (isGenieSymlink(symlinkPath)) {
      try {
        unlinkSync(symlinkPath);
        removed.push(name);
      } catch {
        // Ignore errors - may not have permission
      }
    }
  }

  return removed;
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
  hermesHome?: string;
  genieHome?: string;
}

interface AgentSyncAsset {
  agent: 'claude' | 'codex' | 'hermes';
  kind: 'skill' | 'workflow' | 'link';
  path: string;
}

/** True only when `dir` carries a genie-agent-sync manifest — i.e. we shipped it. */
function isManagedSkillDir(dir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, SYNC_MANIFEST_NAME), 'utf8')) as { managedBy?: string };
    return parsed.managedBy === SYNC_MANAGED_BY;
  } catch {
    return false;
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
    const dir = join(parent, name);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir && isManagedSkillDir(dir)) out.push({ agent, kind: 'skill', path: dir });
  }
}

/** The stamped council.js carries `const LENS_ROOT = '…'` plus the `name: 'council'` meta. */
function isStampedCouncil(councilPath: string): boolean {
  try {
    const content = readFileSync(councilPath, 'utf8');
    return content.includes('const LENS_ROOT =') && /name:\s*'council'/.test(content);
  } catch {
    return false;
  }
}

function collectStampedCouncil(claudeDir: string, out: AgentSyncAsset[]): void {
  const councilPath = join(claudeDir, 'workflows', 'council.js');
  if (isStampedCouncil(councilPath)) out.push({ agent: 'claude', kind: 'workflow', path: councilPath });
}

/** The hermes plugin link is ours only when the symlink resolves into the genie home. */
function collectHermesLink(hermesHome: string, genieHome: string, out: AgentSyncAsset[]): void {
  const linkPath = join(hermesHome, 'plugins', 'genie');
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return;
  }
  if (!stat.isSymbolicLink()) return;
  try {
    const resolved = resolve(join(hermesHome, 'plugins'), readlinkSync(linkPath));
    const home = resolve(genieHome);
    if (resolved === home || resolved.startsWith(`${home}/`))
      out.push({ agent: 'hermes', kind: 'link', path: linkPath });
  } catch {
    /* unreadable symlink → leave it */
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
  collectManagedSkillDirs(join(codexDir, 'skills', '.curated'), 'codex', out);
  collectStampedCouncil(claudeDir, out);
  collectHermesLink(hermesHome, genieHome, out);
  return out;
}

/** Remove every asset {@link collectAgentSyncAssets} finds; returns the removed paths. */
export function removeAgentSyncAssets(targets: AgentSyncRemovalTargets = {}): string[] {
  const removed: string[] = [];
  for (const asset of collectAgentSyncAssets(targets)) {
    try {
      if (asset.kind === 'skill') rmSync(asset.path, { recursive: true, force: true });
      else unlinkSync(asset.path);
      removed.push(asset.path);
    } catch {
      // best-effort — a failed asset removal never blocks the rest of uninstall
    }
  }
  return removed;
}

/** Try an uninstall step, logging success or warning on failure. */
function tryRemoveStep(label: string, successMsg: string, fn: () => void): void {
  console.log(`\x1b[2m${label}\x1b[0m`);
  try {
    fn();
    console.log(`  \x1b[32m+\x1b[0m ${successMsg}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  \x1b[33m!\x1b[0m ${label.replace('...', '')} failed: ${message}`);
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
): void {
  if (hasHookScript) {
    tryRemoveStep('Removing hook script...', 'Hook script removed', () => removeHookScript());
  }

  if (existingSymlinks.length > 0) {
    console.log('\x1b[2mRemoving symlinks...\x1b[0m');
    const removed = removeSymlinks();
    if (removed.length > 0) {
      console.log(`  \x1b[32m+\x1b[0m Removed: ${removed.join(', ')}`);
    }
  }

  if (existsSync(ORCHESTRATION_RULES_PATH)) {
    tryRemoveStep(
      'Removing orchestration rules...',
      `Orchestration rules removed (${contractPath(ORCHESTRATION_RULES_PATH)})`,
      () => unlinkSync(ORCHESTRATION_RULES_PATH),
    );
  }

  // Managed agent assets live OUTSIDE the genie home (~/.claude, ~/.codex,
  // ~/.hermes), so removing them is a distinct step from deleting ~/.genie.
  if (hasAgentAssets) {
    console.log('\x1b[2mRemoving synced agent assets...\x1b[0m');
    const removed = removeAgentSyncAssets();
    console.log(`  \x1b[32m+\x1b[0m Removed ${removed.length} managed asset(s) (skills / council.js / hermes link)`);
  }

  if (hasGenieDir) {
    tryRemoveStep('Removing genie directory...', 'Directory removed', () =>
      rmSync(genieDir, { recursive: true, force: true }),
    );
  }
}

export async function uninstallCommand(): Promise<void> {
  console.log();
  console.log('\x1b[1m\x1b[33m Uninstall Genie CLI\x1b[0m');
  console.log();

  const genieDir = getGenieDir();
  const hasGenieDir = existsSync(genieDir);
  const hasHookScript = hookScriptExists();
  const hasOrchestrationRules = existsSync(ORCHESTRATION_RULES_PATH);
  const existingSymlinks = SYMLINKS.filter((name) => isGenieSymlink(join(LOCAL_BIN, name)));
  const agentAssets = collectAgentSyncAssets();
  const hasAgentAssets = agentAssets.length > 0;

  console.log('\x1b[2mThis will remove:\x1b[0m');
  if (hasHookScript) console.log('  \x1b[31m-\x1b[0m Hook script (~/.claude/hooks/genie-bash-hook.sh)');
  if (hasOrchestrationRules)
    console.log(`  \x1b[31m-\x1b[0m Orchestration rules (${contractPath(ORCHESTRATION_RULES_PATH)})`);
  if (hasGenieDir) console.log(`  \x1b[31m-\x1b[0m Genie directory (${contractPath(genieDir)})`);
  if (existingSymlinks.length > 0)
    console.log(`  \x1b[31m-\x1b[0m Symlinks from ~/.local/bin: ${existingSymlinks.join(', ')}`);
  if (hasAgentAssets)
    console.log(
      `  \x1b[31m-\x1b[0m Synced agent assets: ${agentAssets.length} managed skill dir(s)/council.js/hermes link across claude/codex/hermes`,
    );
  console.log();

  if (!hasGenieDir && !hasHookScript && !hasOrchestrationRules && existingSymlinks.length === 0 && !hasAgentAssets) {
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
  performUninstall(hasHookScript, existingSymlinks, genieDir, hasGenieDir, hasAgentAssets);

  console.log();
  console.log('\x1b[32m+\x1b[0m Genie CLI uninstalled.');
  console.log();
  console.log('\x1b[2mNote: If you installed via npm/bun, also run:\x1b[0m');
  console.log('  \x1b[36mbun remove -g @automagik/genie\x1b[0m');
  console.log('  \x1b[2mor\x1b[0m');
  console.log('  \x1b[36mnpm uninstall -g @automagik/genie\x1b[0m');
  console.log();
}
