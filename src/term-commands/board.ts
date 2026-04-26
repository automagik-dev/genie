/**
 * Board commands — CLI interface for board and template management.
 *
 * Commands:
 *   genie board create <name>       — Create a new board
 *   genie board list                — List all boards
 *   genie board show <name>         — Show board detail
 *   genie board edit <name>         — Edit board or column properties
 *   genie board delete <name>       — Delete a board
 *   genie board columns <name>      — Show board column pipeline
 *   genie board use <name>          — Set active board for current repo
 *   genie board export <name>       — Export board as JSON
 *   genie board import              — Import board from JSON file
 *   genie board template list       — List templates
 *   genie board template show <n>   — Show template detail
 *   genie board template create <n> — Create a template
 *   genie board template edit <n>   — Edit a template column
 *   genie board template rename     — Rename a template
 *   genie board template delete <n> — Delete a template
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { palette } from '../../packages/genie-tokens';
import type * as boardServiceTypes from '../lib/board-service.js';
import type * as taskServiceTypes from '../lib/task-service.js';
import type * as templateServiceTypes from '../lib/template-service.js';
import { formatDate, padRight, truncate } from '../lib/term-format.js';

// ============================================================================
// Lazy Loaders
// ============================================================================

let _boardService: typeof boardServiceTypes | undefined;
async function getBoardService(): Promise<typeof boardServiceTypes> {
  if (!_boardService) _boardService = await import('../lib/board-service.js');
  return _boardService;
}

let _taskService: typeof taskServiceTypes | undefined;
async function getTaskService(): Promise<typeof taskServiceTypes> {
  if (!_taskService) _taskService = await import('../lib/task-service.js');
  return _taskService;
}

let _templateService: typeof templateServiceTypes | undefined;
async function getTemplateService(): Promise<typeof templateServiceTypes> {
  if (!_templateService) _templateService = await import('../lib/template-service.js');
  return _templateService;
}

async function resolveProjectId(name: string): Promise<string> {
  const ts = await getTaskService();
  const project = await ts.getProjectByName(name);
  if (!project) {
    throw new Error(`Project not found: ${name}`);
  }
  return project.id;
}

async function resolveBoard(name: string, projectName?: string): Promise<boardServiceTypes.BoardRow> {
  const bs = await getBoardService();
  let projectId: string | undefined;
  if (projectName) {
    projectId = await resolveProjectId(projectName);
  }
  const board = await bs.getBoard(name, projectId);
  if (!board) {
    throw new Error(`Board not found: ${name}`);
  }
  return board;
}

// ============================================================================
// Display Helpers
// ============================================================================

function printBoardTable(boards: boardServiceTypes.BoardRow[], projectMap: Map<string, string>): void {
  console.log(`  ${padRight('NAME', 24)} ${padRight('PROJECT', 20)} ${padRight('COLUMNS', 10)} ${'CREATED'}`);
  console.log(`  ${'─'.repeat(70)}`);

  for (const b of boards) {
    const projName = b.projectId ? (projectMap.get(b.projectId) ?? b.projectId) : '-';
    const colCount = String(b.columns.length);
    const created = formatDate(b.createdAt);
    console.log(
      `  ${padRight(truncate(b.name, 22), 24)} ${padRight(truncate(projName, 18), 20)} ${padRight(colCount, 10)} ${created}`,
    );
  }

  console.log(`\n  ${boards.length} board${boards.length === 1 ? '' : 's'}`);
}

function printColumnPipeline(columns: boardServiceTypes.BoardColumn[], header: string): void {
  console.log(`\n${header}`);
  console.log('─'.repeat(60));

  const sorted = [...columns].sort((a, b) => a.position - b.position);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const arrow = i < sorted.length - 1 ? ' →' : '';
    const gate = ` [gate: ${c.gate}]`;
    const action = c.action ? ` (action: ${c.action})` : '';
    console.log(`  ${i + 1}. ${c.label ?? c.name}${gate}${action}${arrow}`);
  }
  console.log('');
}

function printTemplateTable(templates: boardServiceTypes.BoardTemplateRow[]): void {
  console.log(`  ${padRight('NAME', 24)} ${padRight('COLUMNS', 10)} ${padRight('BUILTIN', 10)} ${'DESCRIPTION'}`);
  console.log(`  ${'─'.repeat(80)}`);

  for (const t of templates) {
    const colCount = String(t.columns.length);
    const builtin = t.isBuiltin ? 'yes' : 'no';
    const desc = t.description ? truncate(t.description, 30) : '-';
    console.log(`  ${padRight(truncate(t.name, 22), 24)} ${padRight(colCount, 10)} ${padRight(builtin, 10)} ${desc}`);
  }

  console.log(`\n  ${templates.length} template${templates.length === 1 ? '' : 's'}`);
}

// ============================================================================
// Board Command Handlers
// ============================================================================

async function handleBoardCreate(
  name: string,
  options: { project?: string; from?: string; columns?: string; description?: string },
): Promise<void> {
  const bs = await getBoardService();
  const tmpl = await getTemplateService();

  let projectId: string | undefined;
  if (options.project) {
    projectId = await resolveProjectId(options.project);
  }

  let columns: Partial<boardServiceTypes.BoardColumn>[] | undefined;

  if (options.from) {
    const template = await tmpl.getTemplate(options.from);
    if (!template) {
      throw new Error(`Template not found: ${options.from}`);
    }
    columns = template.columns;
  } else if (options.columns) {
    columns = options.columns.split(',').map((colName, i) => ({
      name: colName.trim(),
      label: colName.trim(),
      gate: 'human' as const,
      position: i,
    }));
  }

  const board = await bs.createBoard({
    name,
    projectId,
    description: options.description,
    columns,
  });

  console.log(`Created board "${board.name}" (${board.id}) with ${board.columns.length} columns`);
}

async function handleBoardList(options: { project?: string; all?: boolean; json?: boolean }): Promise<void> {
  const bs = await getBoardService();
  const ts = await getTaskService();

  let projectId: string | undefined;
  if (options.project) {
    projectId = await resolveProjectId(options.project);
  }

  const boards = await bs.listBoards(projectId, options.all);

  if (options.json) {
    console.log(JSON.stringify(boards, null, 2));
    return;
  }

  // Build project name lookup
  const projects = await ts.listProjects();
  const projectMap = new Map<string, string>();
  for (const p of projects) {
    projectMap.set(p.id, p.name);
  }

  printBoardTable(boards, projectMap);
}

async function handleBoardShow(name: string, options: { project?: string; json?: boolean }): Promise<void> {
  const ts = await getTaskService();
  const board = await resolveBoard(name, options.project);

  if (options.json) {
    console.log(JSON.stringify(board, null, 2));
    return;
  }

  // Resolve project name
  let projectName = '-';
  if (board.projectId) {
    const projects = await ts.listProjects();
    const proj = projects.find((p) => p.id === board.projectId);
    if (proj) projectName = proj.name;
  }

  console.log(`\nBoard: ${board.name} (${board.id})`);
  if (board.description) console.log(`Description: ${board.description}`);
  console.log(`Project: ${projectName}`);
  console.log(`Columns: ${board.columns.length}`);
  console.log('─'.repeat(60));

  // Task counts per column
  const tasks = await ts.listTasks({ boardId: board.id, allProjects: true });
  const countByColumn = new Map<string, number>();
  for (const t of tasks) {
    const colId = t.stage;
    countByColumn.set(colId, (countByColumn.get(colId) ?? 0) + 1);
  }

  const sorted = [...board.columns].sort((a, b) => a.position - b.position);
  console.log('\nColumns:');
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const count = countByColumn.get(c.name) ?? countByColumn.get(c.id) ?? 0;
    const gate = ` [gate: ${c.gate}]`;
    const action = c.action ? ` (action: ${c.action})` : '';
    console.log(`  ${i + 1}. ${c.label ?? c.name}${gate}${action} — ${count} task${count === 1 ? '' : 's'}`);
  }
  console.log('');
}

function buildColumnUpdates(options: {
  gate?: string;
  action?: string;
  color?: string;
  rename?: string;
}): Partial<boardServiceTypes.BoardColumn> {
  const updates: Partial<boardServiceTypes.BoardColumn> = {};
  if (options.gate) updates.gate = options.gate as 'human' | 'agent' | 'human+agent';
  if (options.action) updates.action = options.action;
  if (options.color) updates.color = options.color;
  if (options.rename) {
    updates.name = options.rename;
    updates.label = options.rename;
  }
  return updates;
}

async function handleBoardEdit(
  name: string,
  options: {
    project?: string;
    column?: string;
    gate?: string;
    action?: string;
    color?: string;
    rename?: string;
    name?: string;
    description?: string;
  },
): Promise<void> {
  const bs = await getBoardService();
  const board = await resolveBoard(name, options.project);

  // Column-level edits
  if (options.column) {
    const col = board.columns.find((c) => c.name === options.column || c.label === options.column);
    if (!col) {
      throw new Error(`Column not found: ${options.column}`);
    }

    const updates = buildColumnUpdates(options);
    const updated = await bs.updateColumn(board.id, col.id, updates);
    if (!updated) {
      throw new Error(`Failed to update column: ${options.column}`);
    }
    console.log(`Updated column "${options.column}" on board "${board.name}".`);
    return;
  }

  // Board-level edits
  const boardUpdates: { name?: string; description?: string } = {};
  if (options.name) boardUpdates.name = options.name;
  if (options.description) boardUpdates.description = options.description;

  if (Object.keys(boardUpdates).length === 0) {
    console.error('Error: No updates specified. Use --column, --name, or --description.');
    process.exit(1);
  }

  const updated = await bs.updateBoard(board.id, boardUpdates);
  if (!updated) {
    throw new Error(`Failed to update board: ${name}`);
  }
  console.log(`Updated board "${updated.name}" (${updated.id}).`);
}

async function handleBoardDelete(name: string, options: { project?: string; force?: boolean }): Promise<void> {
  const bs = await getBoardService();
  const board = await resolveBoard(name, options.project);

  if (!options.force) {
    console.log(`Deleting board "${board.name}" (${board.id})...`);
  }

  const deleted = await bs.deleteBoard(board.id);
  if (!deleted) {
    throw new Error(`Failed to delete board: ${name}`);
  }
  console.log(`Deleted board "${board.name}" (${board.id}).`);
}

async function handleBoardColumns(name: string, options: { project?: string; json?: boolean }): Promise<void> {
  const board = await resolveBoard(name, options.project);

  if (options.json) {
    console.log(JSON.stringify(board.columns, null, 2));
    return;
  }

  printColumnPipeline(board.columns, `Board: ${board.name} (${board.columns.length} columns)`);
}

async function handleBoardUse(name: string, options: { project?: string }): Promise<void> {
  const board = await resolveBoard(name, options.project);

  const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  const genieDir = join(repoRoot, '.genie');
  const configPath = join(genieDir, 'config.json');

  if (!existsSync(genieDir)) {
    mkdirSync(genieDir, { recursive: true });
  }

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Start fresh if corrupt
    }
  }

  config.activeBoard = board.id;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  console.log(`Active board set to "${board.name}" (${board.id})`);
}

async function handleBoardExport(name: string, options: { project?: string; output?: string }): Promise<void> {
  const bs = await getBoardService();
  const board = await resolveBoard(name, options.project);

  const exported = await bs.exportBoard(board.id);
  const json = JSON.stringify(exported, null, 2);

  if (options.output) {
    const dir = dirname(options.output);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(options.output, `${json}\n`);
    console.log(`Exported board "${board.name}" to ${options.output}`);
  } else {
    console.log(json);
  }
}

async function handleBoardReconcile(name: string, options: { project?: string; json?: boolean }): Promise<void> {
  const { reconcileBoard } = await import('../lib/board-service.js');
  const board = await resolveBoard(name, options.project);
  const result = await reconcileBoard(board.id);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.fixed === 0 && result.orphaned === 0) {
    console.log(`Board "${board.name}": all tasks have valid column_ids.`);
    return;
  }

  console.log(`Board "${board.name}" reconciliation:`);
  console.log(`  Fixed: ${result.fixed} task${result.fixed === 1 ? '' : 's'}`);
  if (result.orphaned > 0) {
    const count = result.orphaned;
    console.log(`  Still orphaned: ${count} task${count === 1 ? '' : 's'} (stage doesn't match any column)`);
  }
}

async function handleBoardImport(options: { json: string; project: string }): Promise<void> {
  const bs = await getBoardService();

  const projectId = await resolveProjectId(options.project);

  const raw = readFileSync(options.json, 'utf-8');
  const data = JSON.parse(raw) as boardServiceTypes.BoardExport;

  const board = await bs.importBoard(data, projectId);
  console.log(`Imported board "${board.name}" (${board.id}) with ${board.columns.length} columns`);
}

// ============================================================================
// Template Command Handlers
// ============================================================================

async function handleTemplateList(options: { json?: boolean }): Promise<void> {
  const tmpl = await getTemplateService();
  const templates = await tmpl.listTemplates();

  if (options.json) {
    console.log(JSON.stringify(templates, null, 2));
    return;
  }

  printTemplateTable(templates);
}

async function handleTemplateShow(name: string, options: { json?: boolean }): Promise<void> {
  const tmpl = await getTemplateService();
  const template = await tmpl.getTemplate(name);
  if (!template) {
    throw new Error(`Template not found: ${name}`);
  }

  if (options.json) {
    console.log(JSON.stringify(template, null, 2));
    return;
  }

  console.log(`\nTemplate: ${template.name} (${template.id})`);
  if (template.description) console.log(`Description: ${template.description}`);
  if (template.icon) console.log(`Icon: ${template.icon}`);
  console.log(`Built-in: ${template.isBuiltin ? 'yes' : 'no'}`);

  printColumnPipeline(template.columns, `Pipeline (${template.columns.length} columns)`);
}

async function handleTemplateCreate(
  name: string,
  options: { fromBoard?: string; columns?: string; description?: string },
): Promise<void> {
  const tmpl = await getTemplateService();

  if (options.fromBoard) {
    const bs = await getBoardService();
    const board = await bs.getBoard(options.fromBoard);
    if (!board) {
      throw new Error(`Board not found: ${options.fromBoard}`);
    }
    const template = await tmpl.snapshotFromBoard(board.id, name);
    console.log(
      `Created template "${template.name}" (${template.id}) from board "${board.name}" with ${template.columns.length} columns`,
    );
    return;
  }

  let columns: boardServiceTypes.BoardColumn[] | undefined;
  if (options.columns) {
    columns = options.columns.split(',').map((colName, i) => ({
      id: crypto.randomUUID(),
      name: colName.trim(),
      label: colName.trim(),
      gate: 'human' as const,
      action: null,
      auto_advance: false,
      transitions: [],
      roles: ['*'],
      color: palette.textDim,
      parallel: false,
      on_fail: null,
      position: i,
    }));
  }

  const template = await tmpl.createTemplate({
    name,
    description: options.description,
    columns,
  });

  console.log(`Created template "${template.name}" (${template.id}) with ${template.columns.length} columns`);
}

async function handleTemplateEdit(
  name: string,
  options: { column?: string; gate?: string; action?: string; rename?: string; color?: string },
): Promise<void> {
  const tmpl = await getTemplateService();
  const template = await tmpl.getTemplate(name);
  if (!template) {
    throw new Error(`Template not found: ${name}`);
  }

  if (!options.column) {
    console.error('Error: --column is required for template edit.');
    process.exit(1);
  }

  const updates: Partial<boardServiceTypes.BoardColumn> = {};
  if (options.gate) updates.gate = options.gate as 'human' | 'agent' | 'human+agent';
  if (options.action) updates.action = options.action;
  if (options.color) updates.color = options.color;
  if (options.rename) {
    updates.name = options.rename;
    updates.label = options.rename;
  }

  const updated = await tmpl.updateTemplateColumn(template.id, options.column, updates);
  if (!updated) {
    throw new Error(`Failed to update template: ${name}`);
  }
  console.log(`Updated column "${options.column}" on template "${template.name}".`);
}

async function handleTemplateRename(oldName: string, newName: string): Promise<void> {
  const tmpl = await getTemplateService();
  const template = await tmpl.getTemplate(oldName);
  if (!template) {
    throw new Error(`Template not found: ${oldName}`);
  }

  const updated = await tmpl.renameTemplate(template.id, newName);
  if (!updated) {
    throw new Error(`Failed to rename template: ${oldName}`);
  }
  console.log(`Renamed template "${oldName}" to "${updated.name}".`);
}

async function handleTemplateDelete(name: string): Promise<void> {
  const tmpl = await getTemplateService();
  const template = await tmpl.getTemplate(name);
  if (!template) {
    throw new Error(`Template not found: ${name}`);
  }

  const deleted = await tmpl.deleteTemplate(template.id);
  if (!deleted) {
    throw new Error(`Failed to delete template: ${name}`);
  }
  console.log(`Deleted template "${template.name}" (${template.id}).`);
}

// ============================================================================
// Registration
// ============================================================================

export function registerBoardCommands(program: Command): void {
  const board = program.command('board').description('Board and pipeline management');

  // ── board create ──
  board
    .command('create <name>')
    .description('Create a new board')
    .option('--project <project>', 'Project name')
    .option('--from <template>', 'Create from template name')
    .option('--columns <columns>', 'Comma-separated column names')
    .option('--description <text>', 'Board description')
    .action(
      async (name: string, options: { project?: string; from?: string; columns?: string; description?: string }) => {
        try {
          await handleBoardCreate(name, options);
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }
      },
    );

  // ── board list ──
  board
    .command('list')
    .description('List all boards')
    .option('--project <project>', 'Filter by project')
    .option('--all', 'Include archived boards')
    .option('--json', 'Output as JSON')
    .action(async (options: { project?: string; all?: boolean; json?: boolean }) => {
      try {
        await handleBoardList(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── board show ──
  board
    .command('show <name...>')
    .description('Show board detail')
    .option('--project <project>', 'Disambiguate by project')
    .option('--json', 'Output as JSON')
    .action(async (nameParts: string[], options: { project?: string; json?: boolean }) => {
      try {
        await handleBoardShow(nameParts.join(' '), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── board edit ──
  board
    .command('edit <name...>')
    .description('Edit board or column properties')
    .option('--project <project>', 'Disambiguate by project')
    .option('--column <col>', 'Column name to edit')
    .option('--gate <gate>', 'New gate value (human|agent|human+agent)')
    .option('--action <action>', 'New action skill')
    .option('--color <color>', 'New color hex')
    .option('--rename <new>', 'Rename the column')
    .option('--name <new>', 'Rename the board itself')
    .option('--description <text>', 'Update description')
    .action(
      async (
        nameParts: string[],
        options: {
          project?: string;
          column?: string;
          gate?: string;
          action?: string;
          color?: string;
          rename?: string;
          name?: string;
          description?: string;
        },
      ) => {
        try {
          await handleBoardEdit(nameParts.join(' '), options);
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }
      },
    );

  // ── board delete ──
  board
    .command('delete <name...>')
    .description('Delete a board')
    .option('--project <project>', 'Disambiguate by project')
    .option('--force', 'Skip confirmation')
    .action(async (nameParts: string[], options: { project?: string; force?: boolean }) => {
      try {
        await handleBoardDelete(nameParts.join(' '), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── board columns ──
  board
    .command('columns <name...>')
    .description('Show board column pipeline')
    .option('--project <project>', 'Disambiguate by project')
    .option('--json', 'Output as JSON')
    .action(async (nameParts: string[], options: { project?: string; json?: boolean }) => {
      try {
        await handleBoardColumns(nameParts.join(' '), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── board use ──
  board
    .command('use <name...>')
    .description('Set active board for current repo')
    .option('--project <project>', 'Disambiguate by project')
    .action(async (nameParts: string[], options: { project?: string }) => {
      try {
        await handleBoardUse(nameParts.join(' '), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── board export ──
  board
    .command('export <name...>')
    .description('Export board as JSON')
    .option('--project <project>', 'Disambiguate by project')
    .option('--output <file>', 'Write to file instead of stdout')
    .option('--json', 'Output as JSON (default, accepted for consistency)')
    .action(async (nameParts: string[], options: { project?: string; output?: string; json?: boolean }) => {
      try {
        await handleBoardExport(nameParts.join(' '), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── board reconcile ──
  board
    .command('reconcile <name...>')
    .description('Fix orphaned column_ids by matching task stage to board columns')
    .option('--project <project>', 'Disambiguate by project')
    .option('--json', 'Output as JSON')
    .action(async (nameParts: string[], options: { project?: string; json?: boolean }) => {
      try {
        await handleBoardReconcile(nameParts.join(' '), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── board archive ──
  board
    .command('archive <name...>')
    .description('Archive a board and its unfinished tasks')
    .option('--project <project>', 'Disambiguate by project')
    .action(async (nameParts: string[], options: { project?: string }) => {
      try {
        const ts = await getTaskService();
        const board = await resolveBoard(nameParts.join(' '), options.project);
        await ts.archiveBoard(board.id);
        console.log(`Archived board "${board.name}" and its unfinished tasks.`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── board import ──
  board
    .command('import')
    .description('Import board from JSON file')
    .requiredOption('--json <file>', 'JSON file to import')
    .requiredOption('--project <project>', 'Target project')
    .action(async (options: { json: string; project: string }) => {
      try {
        await handleBoardImport(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── board template ──
  const template = board.command('template').description('Board template management');

  // ── template list ──
  template
    .command('list')
    .description('List all board templates')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        await handleTemplateList(options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── template show ──
  template
    .command('show <name>')
    .description('Show template detail with pipeline view')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      try {
        await handleTemplateShow(name, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── template create ──
  template
    .command('create <name>')
    .description('Create a board template')
    .option('--from-board <board>', 'Create from existing board')
    .option('--columns <columns>', 'Comma-separated column names')
    .option('--description <text>', 'Template description')
    .action(async (name: string, options: { fromBoard?: string; columns?: string; description?: string }) => {
      try {
        await handleTemplateCreate(name, options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── template edit ──
  template
    .command('edit <name>')
    .description('Edit a template column')
    .option('--column <col>', 'Column name to edit')
    .option('--gate <gate>', 'New gate value (human|agent|human+agent)')
    .option('--action <action>', 'New action skill')
    .option('--rename <new>', 'Rename the column')
    .option('--color <color>', 'New color hex')
    .action(
      async (
        name: string,
        options: { column?: string; gate?: string; action?: string; rename?: string; color?: string },
      ) => {
        try {
          await handleTemplateEdit(name, options);
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        }
      },
    );

  // ── template rename ──
  template
    .command('rename <old> <new>')
    .description('Rename a template')
    .action(async (oldName: string, newName: string) => {
      try {
        await handleTemplateRename(oldName, newName);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── template delete ──
  template
    .command('delete <name>')
    .description('Delete a template')
    .action(async (name: string) => {
      try {
        await handleTemplateDelete(name);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
