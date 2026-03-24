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
import * as wishState from '../lib/wish-state.js';
import { parseExecutionStrategy, parseWishGroups } from './dispatch.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the WISH.md path for a slug.
 * Search order: base/.genie/wishes/ → repoRoot/.genie/wishes/ (via git-common-dir)
 */
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
    const repoRoot = dirname(commonDir);
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

function formatTimestamp(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

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
// Pane Auto-Kill
// ============================================================================

/**
 * Kill the calling agent's tmux pane. If not in tmux, exit the process.
 */
export function autoKillPane(): void {
  const paneId = process.env.TMUX_PANE;
  if (paneId) {
    // Small delay to ensure all output is flushed before killing the pane
    setTimeout(() => {
      try {
        execSync(`tmux kill-pane -t '${paneId}'`, { encoding: 'utf-8' });
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

    // Wave completion detection + team-lead notification
    const waveResult = await detectWaveCompletion(slug, group);
    if (waveResult) {
      console.log(`   🌊 ${waveResult.waveName} complete! All groups done: ${waveResult.waveGroups.join(', ')}`);
      try {
        const protocolRouter = await import('../lib/protocol-router.js');
        const repoPath = process.cwd();
        const message = `${waveResult.waveName} complete. All groups done: [${waveResult.waveGroups.join(', ')}]. Run /review or advance to next wave.`;
        const result = await protocolRouter.sendMessage(repoPath, 'cli', 'team-lead', message);
        if (result && typeof result === 'object' && 'delivered' in result && !result.delivered) {
          console.warn('   ⚠️ Wave-complete notification may not have been delivered.');
        } else {
          console.log('   Notified team-lead of wave completion.');
        }
      } catch {
        console.warn('   ⚠️ Could not notify team-lead (messaging unavailable).');
      }
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
export async function statusCommand(slug: string): Promise<void> {
  try {
    let state = await wishState.getState(slug);
    if (!state) {
      // Auto-initialize state from WISH.md instead of failing
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
      state = await wishState.createState(slug, groups);
      console.log(`📝 Auto-initialized state for wish "${slug}" (${groups.length} groups)`);
    }

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

export function registerStateCommands(program: Command): void {
  program
    .command('done <ref>')
    .description('Mark a wish group as done (format: <slug>#<group>)')
    .action(async (ref: string) => {
      await doneCommand(ref);
    });

  program
    .command('status <slug>')
    .description('Show wish state overview for all groups')
    .action(async (slug: string) => {
      await statusCommand(slug);
    });

  program
    .command('reset <ref>')
    .description('Reset an in-progress group back to ready (format: <slug>#<group>)')
    .action(async (ref: string) => {
      try {
        const { slug, group } = parseRef(ref);
        const result = await wishState.resetGroup(slug, group);
        console.log(`🔄 Group "${group}" reset to ready in wish "${slug}"`);
        if (result.status === 'ready') {
          console.log('   Status: ready (assignee cleared)');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ ${message}`);
        process.exit(1);
      }
    });
}
