/**
 * Notify commands — CLI interface for notification preference management.
 *
 * Commands:
 *   genie notify set --channel <channel> [--priority <p>] [--default]  — Set preference
 *   genie notify list                                                   — List preferences
 *   genie notify remove --channel <channel>                             — Remove preference
 */

import type { Command } from 'commander';
import type * as taskServiceTypes from '../lib/task-service.js';
import { padRight } from '../lib/term-format.js';

let _taskService: typeof taskServiceTypes | undefined;
async function getTaskService(): Promise<typeof taskServiceTypes> {
  if (!_taskService) _taskService = await import('../lib/task-service.js');
  return _taskService;
}

function currentActor(): taskServiceTypes.Actor {
  const name = process.env.GENIE_AGENT_NAME ?? 'cli';
  return { actorType: 'local', actorId: name };
}

// ============================================================================
// Handlers
// ============================================================================

async function handleNotifySet(options: { channel: string; priority?: string; default?: boolean }): Promise<void> {
  const ts = await getTaskService();
  const actor = currentActor();
  const pref = await ts.setPreference(actor, options.channel, {
    priorityThreshold: options.priority,
    isDefault: options.default,
  });
  const defaultLabel = pref.isDefault ? ', default' : '';
  console.log(`Notification preference set: ${pref.channel} (threshold: ${pref.priorityThreshold}${defaultLabel}).`);
}

function printPrefsTable(prefs: taskServiceTypes.NotificationPrefRow[]): void {
  console.log(`  ${padRight('CHANNEL', 15)} ${padRight('THRESHOLD', 12)} ${padRight('DEFAULT', 10)} ${'ENABLED'}`);
  console.log(`  ${'─'.repeat(45)}`);

  for (const p of prefs) {
    const dflt = p.isDefault ? 'yes' : 'no';
    const enabled = p.enabled ? 'yes' : 'no';
    console.log(`  ${padRight(p.channel, 15)} ${padRight(p.priorityThreshold, 12)} ${padRight(dflt, 10)} ${enabled}`);
  }

  console.log(`\n  ${prefs.length} preference${prefs.length === 1 ? '' : 's'}`);
}

async function handleNotifyList(options: { json?: boolean }): Promise<void> {
  const ts = await getTaskService();
  const actor = currentActor();
  const prefs = await ts.getPreferences(actor);

  if (options.json) {
    console.log(JSON.stringify(prefs, null, 2));
    return;
  }

  if (prefs.length === 0) {
    console.log('No notification preferences configured.');
    return;
  }

  printPrefsTable(prefs);
}

async function handleNotifyRemove(options: { channel: string }): Promise<void> {
  const ts = await getTaskService();
  const actor = currentActor();
  const removed = await ts.deletePreference(actor, options.channel);
  if (removed) {
    console.log(`Removed notification preference for channel: ${options.channel}`);
  } else {
    console.log(`No preference found for channel: ${options.channel}`);
  }
}

// ============================================================================
// Registration
// ============================================================================

export function registerNotifyCommands(program: Command): void {
  const notify = program.command('notify').description('Notification preference management');

  notify
    .command('set')
    .description('Set notification preference for a channel')
    .requiredOption('--channel <channel>', 'Channel: whatsapp, telegram, email, slack, discord, tmux')
    .option('--priority <priority>', 'Minimum priority threshold', 'normal')
    .option('--default', 'Set as default channel')
    .action(async (options: { channel: string; priority?: string; default?: boolean }) => {
      try {
        await handleNotifySet(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  notify
    .command('list')
    .description('List notification preferences')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        await handleNotifyList(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  notify
    .command('remove')
    .description('Remove a notification preference')
    .requiredOption('--channel <channel>', 'Channel to remove')
    .action(async (options: { channel: string }) => {
      try {
        await handleNotifyRemove(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
