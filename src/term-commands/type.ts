/**
 * Type commands — CLI interface for task type management.
 *
 * Commands:
 *   genie type list          — List all task types
 *   genie type show <id>     — Show type detail with stage pipeline
 *   genie type create <name> — Create a custom type with stages JSON
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

// ============================================================================
// Handlers
// ============================================================================

interface StageEntry {
  name: string;
  label?: string;
  gate?: string;
  action?: string;
  auto_advance?: boolean;
  color?: string;
}

function printTypeTable(types: taskServiceTypes.TaskTypeRow[]): void {
  console.log(`  ${padRight('ID', 20)} ${padRight('NAME', 30)} ${padRight('STAGES', 8)} ${'BUILTIN'}`);
  console.log(`  ${'─'.repeat(70)}`);

  for (const t of types) {
    const stageCount = Array.isArray(t.stages) ? t.stages.length : 0;
    const builtin = t.isBuiltin ? 'yes' : 'no';
    console.log(`  ${padRight(t.id, 20)} ${padRight(t.name, 30)} ${padRight(String(stageCount), 8)} ${builtin}`);
  }

  console.log(`\n  ${types.length} type${types.length === 1 ? '' : 's'}`);
}

function printTypePipeline(t: taskServiceTypes.TaskTypeRow): void {
  console.log(`\nType: ${t.name} (${t.id})`);
  if (t.description) console.log(`Description: ${t.description}`);
  if (t.icon) console.log(`Icon: ${t.icon}`);
  console.log(`Built-in: ${t.isBuiltin ? 'yes' : 'no'}`);
  console.log('─'.repeat(60));

  console.log('\nStage Pipeline:');
  const stages = t.stages as StageEntry[];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const arrow = i < stages.length - 1 ? ' →' : '';
    const gate = s.gate ? ` [gate: ${s.gate}]` : '';
    const action = s.action ? ` (action: ${s.action})` : '';
    const auto = s.auto_advance ? ' [auto]' : '';
    console.log(`  ${i + 1}. ${s.label ?? s.name}${gate}${action}${auto}${arrow}`);
  }
  console.log('');
}

async function handleTypeList(options: { json?: boolean }): Promise<void> {
  console.warn('Warning: `genie type` is deprecated. Use `genie board` instead.');
  const ts = await getTaskService();
  const types = await ts.listTypes();

  if (options.json) {
    console.log(JSON.stringify(types, null, 2));
    return;
  }

  printTypeTable(types);
}

async function handleTypeShow(id: string, options: { json?: boolean }): Promise<void> {
  console.warn('Warning: `genie type` is deprecated. Use `genie board` instead.');
  const ts = await getTaskService();
  const t = await ts.getType(id);
  if (!t) {
    console.error(`Error: Type not found: ${id}`);
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(t, null, 2));
    return;
  }

  printTypePipeline(t);
}

async function handleTypeCreate(
  name: string,
  options: { stages: string; description?: string; icon?: string },
): Promise<void> {
  console.warn('Warning: `genie type` is deprecated. Use `genie board` instead.');
  const ts = await getTaskService();

  let stages: unknown[];
  try {
    stages = JSON.parse(options.stages);
    if (!Array.isArray(stages)) throw new Error('Stages must be a JSON array');
  } catch (err) {
    console.error(`Error: Invalid stages JSON. ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  for (const s of stages) {
    if (typeof s !== 'object' || s === null || !('name' in s)) {
      console.error('Error: Each stage must have at least a "name" field.');
      process.exit(1);
    }
  }

  const id = name.toLowerCase().replace(/\s+/g, '-');
  const t = await ts.createType({
    id,
    name,
    description: options.description,
    icon: options.icon,
    stages,
  });

  console.log(`Created type "${t.name}" (${t.id}) with ${stages.length} stages.`);
}

// ============================================================================
// Registration
// ============================================================================

export function registerTypeCommands(program: Command): void {
  const type = program.command('type').description('Task type management');

  type
    .command('list')
    .description('List all task types')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        await handleTypeList(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  type
    .command('show <id>')
    .description('Show task type detail with stage pipeline')
    .option('--json', 'Output as JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        await handleTypeShow(id, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  type
    .command('create <name>')
    .description('Create a custom task type')
    .requiredOption('--stages <json>', 'Stages JSON array')
    .option('--description <text>', 'Type description')
    .option('--icon <icon>', 'Type icon')
    .action(async (name: string, options: { stages: string; description?: string; icon?: string }) => {
      try {
        await handleTypeCreate(name, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
