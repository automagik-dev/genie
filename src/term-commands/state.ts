/**
 * State commands — CLI interface for wish state machine.
 *
 * Commands:
 *   genie done <slug>#<group>    - Mark group as done, unblock dependents,
 *                                  push work, notify team-lead on wave completion,
 *                                  and auto-kill the calling agent's tmux pane.
 *   genie status <slug>          - Pretty-print wish state overview
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { isInteractive } from '../lib/interactivity.js';
import { formatTimestamp, padRight } from '../lib/term-format.js';
import * as wishState from '../lib/wish-state.js';
import { parseExecutionStrategy, parseWishGroups } from './dispatch.js';

// Lazy imports to avoid circular dependencies
async function loadExecutorInfo() {
  const [registryMod, executorMod, assignmentMod] = await Promise.all([
    import('../lib/agent-registry.js'),
    import('../lib/executor-registry.js'),
    import('../lib/assignment-registry.js'),
  ]);
  return { registry: registryMod, executorRegistry: executorMod, assignmentRegistry: assignmentMod };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the WISH.md path for a slug.
 * Search order: base/.genie/wishes/ → repoRoot/.genie/wishes/ (via git-common-dir)
 */
function normalizeGitPath(path: string): string {
  if (process.platform !== 'darwin') return path;
  if (!path.startsWith('/private/')) return path;
  const logicalPath = path.slice('/private'.length);
  return existsSync(logicalPath) ? logicalPath : path;
}

export function resolveWishPath(slug: string, cwd?: string): string | null {
  const base = cwd ?? process.cwd();
  const cwdPath = join(base, '.genie', 'wishes', slug, 'WISH.md');
  if (existsSync(cwdPath)) return cwdPath;

  // Fallback: check repo root via git-common-dir
  try {
    const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      encoding: 'utf-8',
      cwd: base,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const repoRoot = normalizeGitPath(dirname(commonDir));
    if (repoRoot !== base) {
      const repoPath = join(repoRoot, '.genie', 'wishes', slug, 'WISH.md');
      if (existsSync(repoPath)) return repoPath;
    }
  } catch {
    // Not in a git repo — no fallback available
  }

  return null;
}

/**
 * Parse a `slug#group` reference.
 * Examples: "auth-bug#2" → { slug: "auth-bug", group: "2" }
 */
export function parseRef(ref: string): { slug: string; group: string } {
  const hashIdx = ref.indexOf('#');
  if (hashIdx === -1) {
    throw new Error(`Invalid reference "${ref}". Expected format: <slug>#<group>`);
  }
  const slug = ref.slice(0, hashIdx);
  const group = ref.slice(hashIdx + 1);
  if (!slug || !group) {
    throw new Error(`Invalid reference "${ref}". Both slug and group are required.`);
  }
  return { slug, group };
}

// ============================================================================
// Status formatting
// ============================================================================

const STATUS_ICONS: Record<string, string> = {
  blocked: '🔒',
  ready: '🟢',
  in_progress: '🔄',
  done: '✅',
};

// ============================================================================
// Wave Detection
// ============================================================================

/**
 * Detect which wave a group belongs to and whether all groups in that wave are done.
 * Returns the wave name and list of groups if the wave is complete, null otherwise.
 */
export async function detectWaveCompletion(
  slug: string,
  groupName: string,
  cwd?: string,
): Promise<{ waveName: string; waveGroups: string[] } | null> {
  const wishPath = resolveWishPath(slug, cwd);
  if (!wishPath) return null;

  const content = await readFile(wishPath, 'utf-8');
  const waves = parseExecutionStrategy(content);

  // Find which wave contains this group
  const targetWave = waves.find((w) => w.groups.some((g) => g.group === groupName));
  if (!targetWave) return null;

  // Check if all groups in this wave are now done
  const state = await wishState.getState(slug, cwd);
  if (!state) return null;

  const waveGroupNames = targetWave.groups.map((g) => g.group);
  const allDone = waveGroupNames.every((g) => state.groups[g]?.status === 'done');

  if (!allDone) return null;
  return { waveName: targetWave.name, waveGroups: waveGroupNames };
}

// ============================================================================
// Push Enforcement
// ============================================================================

/**
 * Ensure all work is committed and pushed before exiting.
 * 1. If working tree is dirty → commit as WIP
 * 2. If there are unpushed commits → push
 */
export async function ensureWorkPushed(slug: string, group: string): Promise<void> {
  // 1. Commit dirty working tree as WIP
  try {
    const porcelain = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    if (porcelain) {
      console.log('   Committing dirty working tree...');
      execSync('git add -A', { encoding: 'utf-8' });
      execSync(`git commit -m "wip: ${slug}#${group}"`, { encoding: 'utf-8' });
      console.log(`   Committed as "wip: ${slug}#${group}"`);
    }
  } catch {
    // git status or commit failed — may not be in a git repo
  }

  // 2. Push unpushed commits
  try {
    const unpushed = execSync('git log @{u}..HEAD --oneline', { encoding: 'utf-8' }).trim();
    if (unpushed) {
      console.log('   Pushing unpushed commits...');
      execSync('git push', { encoding: 'utf-8', timeout: 30000 });
      console.log('   Push complete.');
    }
  } catch {
    // No upstream tracking or push failed — best-effort
    try {
      // Try pushing with --set-upstream for new branches
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
      if (branch && branch !== 'HEAD') {
        execSync(`git push -u origin ${branch}`, { encoding: 'utf-8', timeout: 30000 });
        console.log('   Push complete (set upstream).');
      }
    } catch {
      console.log('   ⚠️ Push failed — manual push may be needed.');
    }
  }
}

// ============================================================================
// Team Auto-Cleanup
// ============================================================================

/**
 * Auto-cleanup team when wish is fully complete.
 * Looks up the active team (via GENIE_TEAM env) and marks it done + kills members.
 * Best-effort — if team lookup fails, cleanup is skipped (manual `genie team done` still works).
 */
async function autoCleanupTeam(): Promise<void> {
  const teamName = process.env.GENIE_TEAM;
  if (!teamName) return;

  try {
    const teamManager = await import('../lib/team-manager.js');
    const config = await teamManager.getTeam(teamName);
    if (!config) return;

    // Only clean up if the team is still active
    if (config.status === 'done') return;

    console.log(`   🧹 Auto-cleaning team "${teamName}"...`);
    await teamManager.setTeamStatus(teamName, 'done');
    await teamManager.killTeamMembers(teamName);
    console.log(`   ✅ Team "${teamName}" marked done, members killed.`);
  } catch {
    // Best-effort — manual cleanup via `genie team done` still works
    console.log(`   ⚠️ Auto-cleanup skipped — run \`genie team done ${teamName}\` manually.`);
  }
}

// ============================================================================
// Pane Auto-Kill
// ============================================================================

/**
 * Kill the calling agent's tmux pane. If not in tmux, exit the process.
 */
function autoKillPane(): void {
  const paneId = process.env.TMUX_PANE;
  if (paneId) {
    // Small delay to ensure all output is flushed before killing the pane
    setTimeout(() => {
      try {
        const { genieTmuxCmd } = require('../lib/tmux-wrapper.js');
        execSync(genieTmuxCmd(`kill-pane -t '${paneId}'`), { encoding: 'utf-8' });
      } catch {
        // Pane already dead or not in tmux
        process.exit(0);
      }
    }, 1000);
  } else {
    process.exit(0);
  }
}

// ============================================================================
// Wave + Wish Completion Notifications
// ============================================================================

/**
 * Resolve the leader name and spawner for the current team context.
 * Never returns 'team-lead' — falls back to teamName via resolveLeaderName().
 */
async function resolveNotificationTargets(): Promise<{ leader: string; spawner?: string }> {
  const teamName = process.env.GENIE_TEAM;
  if (!teamName) return { leader: 'team-lead' };

  try {
    const teamManager = await import('../lib/team-manager.js');
    const leader = await teamManager.resolveLeaderName(teamName);
    const config = await teamManager.getTeam(teamName);
    return {
      leader,
      spawner: config?.spawner,
    };
  } catch {
    return { leader: teamName };
  }
}

/**
 * Notify leader (and spawner) of wave or wish completion via protocol-router.
 * Best-effort — failures are logged but do not block the done flow.
 */
async function notifyWaveCompletion(
  waveResult: { waveName: string; waveGroups: string[] },
  wishComplete: boolean,
): Promise<void> {
  console.log(`   🌊 ${waveResult.waveName} complete! All groups done: ${waveResult.waveGroups.join(', ')}`);
  try {
    const protocolRouter = await import('../lib/protocol-router.js');
    const repoPath = process.cwd();
    const { leader, spawner } = await resolveNotificationTargets();

    const message = wishComplete
      ? `WISH COMPLETE — all groups done: [${waveResult.waveGroups.join(', ')}]. Run \`genie team done\` to clean up.`
      : `${waveResult.waveName} complete. All groups done: [${waveResult.waveGroups.join(', ')}]. Run /review or advance to next wave.`;

    // Notify leader
    const result = await protocolRouter.sendMessage(repoPath, 'cli', leader, message);
    if (result && typeof result === 'object' && 'delivered' in result && !result.delivered) {
      console.warn(`   ⚠️ Wave-complete notification to ${leader} may not have been delivered.`);
    } else {
      console.log(`   Notified ${leader} of wave completion.`);
    }

    // Also notify spawner if different from leader
    if (spawner && spawner !== leader && spawner !== 'cli') {
      await protocolRouter.sendMessage(repoPath, 'cli', spawner, message).catch(() => {});
      console.log(`   Notified spawner (${spawner}) of wave completion.`);
    }
  } catch {
    console.warn('   ⚠️ Could not notify leader (messaging unavailable).');
  }
}

// ============================================================================
// Commands
// ============================================================================

/**
 * `genie done <slug>#<group>` — complete a group, push work, notify team-lead
 * on wave completion, and auto-kill the calling agent's tmux pane.
 */
export async function doneCommand(ref: string): Promise<void> {
  try {
    const { slug, group } = parseRef(ref);
    const result = await wishState.completeGroup(slug, group);
    console.log(`✅ Group "${group}" marked as done in wish "${slug}"`);

    if (result.completedAt) {
      console.log(`   Completed at: ${formatTimestamp(result.completedAt)}`);
    }

    // Show which groups were unblocked
    const state = await wishState.getState(slug);
    if (state) {
      const nowReady = Object.entries(state.groups)
        .filter(([, g]) => g.status === 'ready' && g.dependsOn.includes(group))
        .map(([name]) => name);

      if (nowReady.length > 0) {
        console.log(`   Unblocked: ${nowReady.join(', ')}`);
      }
    }

    // Push enforcement: commit dirty tree + push unpushed commits
    await ensureWorkPushed(slug, group);

    // Wish-level completion check — are ALL groups done?
    const wishComplete = await wishState.isWishComplete(slug);

    // Wave completion detection + team-lead notification
    const waveResult = await detectWaveCompletion(slug, group);
    if (waveResult) {
      await notifyWaveCompletion(waveResult, wishComplete);
    }

    // If entire wish is complete, auto-trigger team cleanup
    if (wishComplete) {
      console.log('   🎉 Wish fully complete — all groups done.');
      await autoCleanupTeam();
    }

    // Auto-kill the calling agent's tmux pane
    autoKillPane();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${message}`);
    process.exit(1);
  }
}

/**
 * `genie status <slug>` — pretty-print all groups with state/assignee/timestamps.
 */
async function autoInitWishState(slug: string): Promise<Awaited<ReturnType<typeof wishState.createState>>> {
  const wishPath = resolveWishPath(slug);
  if (!wishPath) {
    console.error(`❌ No state found for wish "${slug}" and no WISH.md found in cwd or repo root`);
    console.error(`   Create it first: genie wish <agent> ${slug}`);
    process.exit(1);
  }
  const content = await readFile(wishPath, 'utf-8');
  const groups = parseWishGroups(content);
  if (groups.length === 0) {
    console.error(`❌ No execution groups found in ${wishPath}`);
    process.exit(1);
  }
  const state = await wishState.createState(slug, groups);
  console.log(`📝 Auto-initialized state for wish "${slug}" (${groups.length} groups)`);
  return state;
}

async function printWishExecutors(slug: string): Promise<void> {
  try {
    const { registry, executorRegistry, assignmentRegistry } = await loadExecutorInfo();
    const agents = await registry.listAgents({ team: process.env.GENIE_TEAM });
    const executorInfoLines: string[] = [];

    for (const agent of agents) {
      if (!agent.currentExecutorId) continue;
      const executor = await executorRegistry.getExecutor(agent.currentExecutorId);
      if (!executor || executor.state === 'terminated' || executor.state === 'done') continue;

      const assignment = await assignmentRegistry.getActiveAssignment(executor.id);
      const taskLabel =
        assignment?.wishSlug === slug ? `Group ${assignment.groupNumber ?? '?'}` : (assignment?.wishSlug ?? '-');
      const name = agent.customName ?? agent.role ?? agent.id.slice(0, 12);
      executorInfoLines.push(
        `  Agent: ${padRight(name, 16)} | Executor: ${executor.id.slice(0, 12)} (${executor.provider}) | State: ${padRight(executor.state, 10)} | Task: ${taskLabel}`,
      );
    }

    if (executorInfoLines.length > 0) {
      console.log('\nActive Executors:');
      console.log('─'.repeat(60));
      for (const line of executorInfoLines) {
        console.log(line);
      }
    }
  } catch {
    // Executor info is best-effort — DB may be unavailable
  }
}

export async function statusCommand(slug: string): Promise<void> {
  try {
    const state = (await wishState.getState(slug)) ?? (await autoInitWishState(slug));

    console.log(`\nWish: ${state.wish}`);
    console.log('─'.repeat(60));

    const entries = Object.entries(state.groups);
    const maxNameLen = Math.max(...entries.map(([name]) => name.length), 5);

    console.log(`  ${padRight('GROUP', maxNameLen)}  STATUS        ASSIGNEE      STARTED        COMPLETED`);
    console.log(`  ${'─'.repeat(maxNameLen + 62)}`);

    for (const [name, group] of entries) {
      const icon = STATUS_ICONS[group.status] ?? '❓';
      const status = padRight(`${icon} ${group.status}`, 13);
      const assignee = padRight(group.assignee ?? '-', 13);
      const started = padRight(formatTimestamp(group.startedAt) || '-', 14);
      const completed = formatTimestamp(group.completedAt) || '-';

      console.log(`  ${padRight(name, maxNameLen)}  ${status} ${assignee} ${started} ${completed}`);
    }

    // Summary
    const total = entries.length;
    const done = entries.filter(([, g]) => g.status === 'done').length;
    const inProgress = entries.filter(([, g]) => g.status === 'in_progress').length;
    const ready = entries.filter(([, g]) => g.status === 'ready').length;
    const blocked = entries.filter(([, g]) => g.status === 'blocked').length;

    console.log('');
    console.log(`  Progress: ${done}/${total} done | ${inProgress} in progress | ${ready} ready | ${blocked} blocked`);

    await printWishExecutors(slug);

    console.log('');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${message}`);
    process.exit(1);
  }
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Reset action: dispatches to resetGroup (when ref has `#`) or resetWishCommand (bare slug).
 */
export async function resetAction(ref: string, options: { yes?: boolean }): Promise<void> {
  try {
    if (ref.includes('#')) {
      const { slug, group } = parseRef(ref);
      const result = await wishState.resetGroup(slug, group);
      console.log(`🔄 Group "${group}" reset to ready in wish "${slug}"`);
      if (result.status === 'ready') {
        console.log('   Status: ready (assignee cleared)');
      }
      return;
    }
    await resetWishCommand(ref, options?.yes ?? false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${message}`);
    process.exit(1);
  }
}

export function registerStateCommands(_program: Command): void {
  // Flat `done`, `status`, `reset` registrations removed in Group 2 of
  // wish-command-group-restructure. These verbs now live under `genie wish`:
  //   genie wish done <ref>
  //   genie wish status <slug>
  //   genie wish reset <ref>
  // Handler bodies are exported from this file and invoked by wish.ts.
}

/**
 * Confirm a destructive wipe. Returns false when the user aborted the
 * interactive prompt; throws via process.exit when a non-interactive shell
 * omits --yes.
 */
async function confirmWipe(
  slug: string,
  existing: NonNullable<Awaited<ReturnType<typeof wishState.getState>>>,
  confirmed: boolean,
): Promise<boolean> {
  const groupCount = Object.keys(existing.groups).length;
  const inProgress = Object.values(existing.groups).filter((g) => g.status === 'in_progress').length;
  const summary = `Wipe all state for "${slug}" (${groupCount} groups, ${inProgress} in-progress)?`;

  if (!isInteractive()) {
    if (confirmed) return true;
    console.error(`❌ ${summary}`);
    console.error('   Refusing to wipe in non-interactive mode. Pass --yes to confirm.');
    process.exit(2);
  }
  const { confirm } = await import('@inquirer/prompts');
  return confirm({ message: summary, default: false });
}

function printResetState(state: Awaited<ReturnType<typeof wishState.createState>>): void {
  console.log('');
  console.log(`Wish: ${state.wish}`);
  console.log('─'.repeat(60));
  for (const [name, group] of Object.entries(state.groups)) {
    const icon = STATUS_ICONS[group.status] ?? '❓';
    console.log(`  ${name}  ${icon} ${group.status}`);
  }
}

/**
 * `genie reset <slug>` (bare slug, no `#group`) — wipe all wish state and
 * recreate it from the current WISH.md. Use to recover from
 * `WishStateMismatchError` after the wish's group structure was edited.
 */
async function resetWishCommand(slug: string, confirmed: boolean): Promise<void> {
  const wishPath = resolveWishPath(slug);
  if (!wishPath) {
    throw new Error(`No WISH.md found for "${slug}" — searched cwd and repo root`);
  }

  const content = await readFile(wishPath, 'utf-8');
  const groups = parseWishGroups(content);
  if (groups.length === 0) {
    throw new Error(`No execution groups found in ${wishPath}`);
  }

  const existing = await wishState.getState(slug);
  if (existing) {
    const ok = await confirmWipe(slug, existing, confirmed);
    if (!ok) {
      console.log('Aborted.');
      return;
    }
    console.log(`🗑️  Replacing existing state for wish "${slug}"`);
  } else {
    console.log(`ℹ️  No existing state for wish "${slug}" — creating fresh`);
  }

  const state = await wishState.createState(slug, groups);
  console.log(`📝 Recreated state from ${wishPath} (${groups.length} groups)`);
  printResetState(state);
}
