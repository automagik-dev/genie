/**
 * Release commands — CLI interface for release management.
 *
 * Commands:
 *   genie release create <name> --tasks <id1> [id2...]  — Create a release
 *   genie release list                                   — List releases
 */

import type { Command } from 'commander';
import type * as taskServiceTypes from '../lib/task-service.js';

let _taskService: typeof taskServiceTypes | undefined;
async function getTaskService(): Promise<typeof taskServiceTypes> {
  if (!_taskService) _taskService = await import('../lib/task-service.js');
  return _taskService;
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

export function registerReleaseCommands(program: Command): void {
  const release = program.command('release').description('Release management');

  // ── release create ──
  release
    .command('create <name>')
    .description('Create a release and assign tasks to it')
    .requiredOption('--tasks <ids...>', 'Task IDs or #seqs to include')
    .action(async (name: string, options: { tasks: string[] }) => {
      try {
        const ts = await getTaskService();
        const updated = await ts.setRelease(options.tasks, name);
        console.log(`Release "${name}" created with ${updated} task${updated === 1 ? '' : 's'}.`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── release list ──
  release
    .command('list')
    .description('List all releases')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const ts = await getTaskService();
        const releases = await ts.listReleases();

        if (options.json) {
          console.log(JSON.stringify(releases, null, 2));
          return;
        }

        if (releases.length === 0) {
          console.log('No releases found.');
          return;
        }

        console.log(`  ${padRight('RELEASE', 30)} ${'TASKS'}`);
        console.log(`  ${'─'.repeat(40)}`);

        for (const r of releases) {
          console.log(`  ${padRight(r.releaseId, 30)} ${r.count}`);
        }

        console.log(`\n  ${releases.length} release${releases.length === 1 ? '' : 's'}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
