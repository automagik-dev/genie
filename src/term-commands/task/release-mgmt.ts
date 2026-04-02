/**
 * genie task releases — Release management delegated under task namespace.
 *
 * Named `releases` (plural) to avoid conflict with existing `task release <id>`
 * which releases a task checkout claim. This creates `genie task releases create/list`.
 */

import type { Command } from 'commander';
import type * as taskServiceTypes from '../../lib/task-service.js';
import { padRight } from '../../lib/term-format.js';

let _taskService: typeof taskServiceTypes | undefined;
async function getTaskService(): Promise<typeof taskServiceTypes> {
  if (!_taskService) _taskService = await import('../../lib/task-service.js');
  return _taskService;
}

export function registerTaskReleaseMgmt(parent: Command): void {
  const releases = parent.command('releases').description('Release management (create, list)');

  releases
    .command('create <name>')
    .description('Create a release and assign tasks to it')
    .requiredOption('--tasks <ids...>', 'Task IDs or #seqs to include')
    .action(async (name: string, options: { tasks: string[] }) => {
      try {
        const ts = await getTaskService();
        const updated = await ts.setRelease(options.tasks, name);
        console.log(`Release "${name}" created with ${updated} task(s).`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  releases
    .command('list')
    .description('List releases')
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

        console.log('');
        console.log('RELEASES');
        console.log('─'.repeat(60));
        console.log(`  ${padRight('NAME', 25)} TASKS`);
        console.log(`  ${'─'.repeat(55)}`);
        for (const r of releases) {
          console.log(`  ${padRight(r.releaseId, 25)} ${r.count}`);
        }
        console.log('');
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
