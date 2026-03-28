/**
 * Template CLI — CRUD for board templates.
 *
 * Commands:
 *   genie template list              — List available templates
 *   genie template show <name>       — Show template details
 *   genie template delete <name>     — Delete a template
 */

import type { Command } from 'commander';
import { padRight } from '../lib/term-format.js';

export function registerTemplateCommands(program: Command): void {
  const tmpl = program.command('template').description('Board template management');

  tmpl
    .command('list', { isDefault: true })
    .description('List available templates')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      const { listTemplates } = await import('../lib/template-service.js');
      const templates = await listTemplates();

      if (options.json) {
        console.log(JSON.stringify(templates, null, 2));
        return;
      }

      if (templates.length === 0) {
        console.log('No templates found.');
        return;
      }

      const maxName = Math.max(...templates.map((t) => t.name.length), 4);
      for (const t of templates) {
        const cols = t.columns?.length ?? 0;
        const tag = t.isBuiltin ? ' (builtin)' : '';
        console.log(`  ${padRight(t.name, maxName)}  ${cols} columns${tag}  ${t.id}`);
      }
      console.log(`\n  ${templates.length} template${templates.length === 1 ? '' : 's'}`);
    });

  tmpl
    .command('show <name>')
    .description('Show template details')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      const { getTemplate } = await import('../lib/template-service.js');
      const t = await getTemplate(name);
      if (!t) {
        console.error(`Template "${name}" not found.`);
        process.exit(1);
      }

      if (options.json) {
        console.log(JSON.stringify(t, null, 2));
        return;
      }

      console.log(`\nName:        ${t.name}`);
      console.log(`ID:          ${t.id}`);
      console.log(`Builtin:     ${t.isBuiltin}`);
      console.log(`Description: ${t.description ?? '(none)'}`);
      if (t.columns && t.columns.length > 0) {
        console.log(`Columns:     ${t.columns.map((c) => c.name).join(', ')}`);
      }
      console.log('');
    });

  tmpl
    .command('delete <name>')
    .description('Delete a template')
    .action(async (name: string) => {
      const { deleteTemplate, getTemplate } = await import('../lib/template-service.js');
      const t = await getTemplate(name);
      if (!t) {
        console.error(`Template "${name}" not found.`);
        process.exit(1);
      }

      const ok = await deleteTemplate(t.id);
      console.log(ok ? `Deleted template "${t.name}".` : 'Delete failed.');
    });
}
