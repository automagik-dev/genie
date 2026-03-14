/**
 * State commands — CLI interface for wish state machine.
 *
 * Commands:
 *   genie done <slug>#<group>    - Mark group as done, unblock dependents
 *   genie status <slug>          - Pretty-print wish state overview
 */

import type { Command } from 'commander';
import * as wishState from '../lib/wish-state.js';

// ============================================================================
// Helpers
// ============================================================================

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
// Commands
// ============================================================================

/**
 * `genie done <slug>#<group>` — complete a group and unblock dependents.
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
    const state = await wishState.getState(slug);
    if (!state) {
      console.error(`❌ No state found for wish "${slug}"`);
      console.error('   State file expected at: .genie/state/<slug>.json');
      process.exit(1);
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
}
