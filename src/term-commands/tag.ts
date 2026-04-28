/**
 * Tag commands — CLI interface for tag management.
 *
 * Commands:
 *   genie tag list              — List all tags
 *   genie tag create <name>     — Create a custom tag
 */

import type { Command } from 'commander';
import { palette } from '../../packages/genie-tokens';
import type * as taskServiceTypes from '../lib/task-service.js';
import { padRight } from '../lib/term-format.js';

let _taskService: typeof taskServiceTypes | undefined;
async function getTaskService(): Promise<typeof taskServiceTypes> {
  if (!_taskService) _taskService = await import('../lib/task-service.js');
  return _taskService;
}

export function registerTagCommands(program: Command): void {
  const tag = program.command('tag').description('Tag management');

  // ── tag list ──
  tag
    .command('list')
    .description('List all tags')
    .option('--type <typeId>', 'Filter by task type')
    .option('--json', 'Output as JSON')
    .action(async (options: { type?: string; json?: boolean }) => {
      try {
        const ts = await getTaskService();
        const tags = await ts.listTags(options.type);

        if (options.json) {
          console.log(JSON.stringify(tags, null, 2));
          return;
        }

        console.log(`  ${padRight('ID', 20)} ${padRight('NAME', 20)} ${padRight('COLOR', 10)} ${'TYPE'}`);
        console.log(`  ${'─'.repeat(55)}`);

        for (const t of tags) {
          console.log(`  ${padRight(t.id, 20)} ${padRight(t.name, 20)} ${padRight(t.color, 10)} ${t.typeId ?? '-'}`);
        }

        console.log(`\n  ${tags.length} tag${tags.length === 1 ? '' : 's'}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── tag create ──
  tag
    .command('create <name>')
    .description('Create a custom tag')
    .option('--color <hex>', 'Tag color (hex)', palette.textDim)
    .option('--type <typeId>', 'Associate with a task type')
    .action(async (name: string, options: { color?: string; type?: string }) => {
      try {
        const ts = await getTaskService();
        const id = name.toLowerCase().replace(/\s+/g, '-');
        const t = await ts.createTag({
          id,
          name,
          color: options.color,
          typeId: options.type,
        });
        console.log(`Created tag "${t.name}" (${t.id}) with color ${t.color}.`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
