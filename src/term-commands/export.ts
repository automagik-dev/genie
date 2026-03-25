/**
 * Export commands — dump genie data as schema-versioned JSON.
 *
 * Commands:
 *   genie export all                — Full backup (all present tables)
 *   genie export boards [name]      — Boards, templates, task_types
 *   genie export tasks [--project]  — Tasks with deps/actors/stage_log
 *   genie export tags               — Tags
 *   genie export projects           — Projects
 *   genie export schedules [name]   — Schedules with run_spec
 *   genie export agents             — Agents, templates, checkpoints
 *   genie export apps               — App store (KhalOS, graceful skip)
 *   genie export comms              — Conversations, messages, mailbox
 *   genie export config             — OS config (KhalOS, graceful skip)
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import type postgres from 'postgres';
import {
  ALL_GROUPS,
  type ExportDocument,
  type ExportGroup,
  GROUP_TABLES,
  createExportDocument,
} from '../lib/export-format.js';

type Sql = postgres.Sql;

// ============================================================================
// Lazy loaders
// ============================================================================

async function getSql(): Promise<Sql> {
  const { getConnection } = await import('../lib/db.js');
  return getConnection();
}

async function getVersion(): Promise<string> {
  const { VERSION } = await import('../lib/version.js');
  return VERSION;
}

async function getActorName(): Promise<string> {
  const { getActor } = await import('../lib/audit.js');
  return getActor();
}

async function detectTables(sql: Sql, tables: string[]): Promise<{ available: string[]; skipped: string[] }> {
  const { filterAvailableTables } = await import('../lib/table-detect.js');
  return filterAvailableTables(sql, tables);
}

// ============================================================================
// Output helper
// ============================================================================

interface ExportOptions {
  output?: string;
  pretty?: boolean;
}

function outputDocument(doc: ExportDocument, options: ExportOptions): void {
  const json = options.pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc);
  if (options.output) {
    const dir = dirname(options.output);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(options.output, `${json}\n`);
    const tables = Object.keys(doc.data);
    const rows = Object.values(doc.data).reduce((sum, arr) => sum + (arr as unknown[]).length, 0);
    console.log(`Exported ${tables.length} tables (${rows} rows) to ${options.output}`);
    if (doc.skippedTables.length > 0) {
      console.log(`Skipped tables (not found): ${doc.skippedTables.join(', ')}`);
    }
  } else {
    console.log(json);
  }
}

function autoOutputName(): string {
  const d = new Date();
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `genie-backup-${date}.json`;
}

// ============================================================================
// Export group handlers
// ============================================================================

async function exportGroup(
  sql: Sql,
  group: ExportGroup,
  filter?: { column: string; value: string },
): Promise<{ data: Record<string, unknown[]>; skipped: string[] }> {
  const tables = GROUP_TABLES[group];
  const { available, skipped } = await detectTables(sql, tables);
  const data: Record<string, unknown[]> = {};

  for (const table of available) {
    if (filter) {
      data[table] = [...(await sql.unsafe(`SELECT * FROM ${table} WHERE ${filter.column} = $1`, [filter.value]))];
    } else {
      data[table] = [...(await sql.unsafe(`SELECT * FROM ${table}`))];
    }
  }

  return { data, skipped };
}

async function exportBoards(sql: Sql, name?: string): Promise<{ data: Record<string, unknown[]>; skipped: string[] }> {
  const tables = GROUP_TABLES.boards;
  const { available, skipped } = await detectTables(sql, tables);
  const data: Record<string, unknown[]> = {};

  for (const table of available) {
    if (name && table === 'boards') {
      data[table] = [...(await sql`SELECT * FROM boards WHERE name = ${name}`)];
    } else if (table === 'task_types') {
      data[table] = [...(await sql`SELECT * FROM task_types WHERE is_builtin = false`)];
    } else {
      data[table] = [...(await sql.unsafe(`SELECT * FROM ${table}`))];
    }
  }

  return { data, skipped };
}

/** Task-related tables that can be filtered by project via JOIN */
const TASK_JOIN_ALIASES: Record<string, string> = {
  task_tags: 'tt',
  task_actors: 'ta',
  task_dependencies: 'td',
  task_stage_log: 'tsl',
};

async function resolveProjectId(sql: Sql, projectName: string): Promise<string> {
  const projects = await sql<{ id: string }[]>`SELECT id FROM projects WHERE name = ${projectName}`;
  if (projects.length === 0) throw new Error(`Project not found: ${projectName}`);
  return projects[0].id;
}

function stripEphemeralFields(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const { checkout_run_id, execution_locked_at, session_id, pane_id, ...rest } = r;
    return rest;
  });
}

async function exportTaskTable(sql: Sql, table: string, projectId: string | null): Promise<unknown[]> {
  const alias = TASK_JOIN_ALIASES[table];
  if (table === 'tasks') {
    const rows = projectId
      ? [...(await sql.unsafe('SELECT * FROM tasks WHERE project_id = $1', [projectId]))]
      : [...(await sql`SELECT * FROM tasks`)];
    return stripEphemeralFields(rows as Record<string, unknown>[]);
  }
  if (alias && projectId) {
    return [
      ...(await sql.unsafe(
        `SELECT ${alias}.* FROM ${table} ${alias} JOIN tasks t ON ${alias}.task_id = t.id WHERE t.project_id = $1`,
        [projectId],
      )),
    ];
  }
  return [...(await sql.unsafe(`SELECT * FROM ${table}`))];
}

async function exportTasks(
  sql: Sql,
  projectName?: string,
): Promise<{ data: Record<string, unknown[]>; skipped: string[] }> {
  const tables = GROUP_TABLES.tasks;
  const { available, skipped } = await detectTables(sql, tables);
  const data: Record<string, unknown[]> = {};
  const projectId = projectName ? await resolveProjectId(sql, projectName) : null;

  for (const table of available) {
    data[table] = await exportTaskTable(sql, table, projectId);
  }

  return { data, skipped };
}

async function exportSchedules(
  sql: Sql,
  name?: string,
): Promise<{ data: Record<string, unknown[]>; skipped: string[] }> {
  const { available, skipped } = await detectTables(sql, ['schedules']);
  const data: Record<string, unknown[]> = {};

  if (available.includes('schedules')) {
    if (name) {
      data.schedules = [...(await sql`SELECT * FROM schedules WHERE name = ${name}`)];
    } else {
      data.schedules = [...(await sql`SELECT * FROM schedules`)];
    }
  }

  return { data, skipped };
}

async function exportTags(sql: Sql): Promise<{ data: Record<string, unknown[]>; skipped: string[] }> {
  const { available, skipped } = await detectTables(sql, ['tags']);
  const data: Record<string, unknown[]> = {};

  if (available.includes('tags')) {
    data.tags = [...(await sql`SELECT * FROM tags WHERE name NOT LIKE 'test-%'`)];
  }

  return { data, skipped };
}

async function exportAll(sql: Sql): Promise<{ data: Record<string, unknown[]>; skipped: string[] }> {
  const allSkipped: string[] = [];
  const allData: Record<string, unknown[]> = {};

  // Export each group
  for (const group of ALL_GROUPS) {
    let result: { data: Record<string, unknown[]>; skipped: string[] };

    switch (group) {
      case 'boards':
        result = await exportBoards(sql);
        break;
      case 'tasks':
        result = await exportTasks(sql);
        break;
      case 'tags':
        result = await exportTags(sql);
        break;
      case 'schedules':
        result = await exportSchedules(sql);
        break;
      default:
        result = await exportGroup(sql, group);
        break;
    }

    Object.assign(allData, result.data);
    allSkipped.push(...result.skipped);
  }

  return { data: allData, skipped: allSkipped };
}

// ============================================================================
// Shared action wrapper
// ============================================================================

async function runExport(
  groups: string[],
  type: 'full' | 'partial',
  exportFn: (sql: Sql) => Promise<{ data: Record<string, unknown[]>; skipped: string[] }>,
  options: ExportOptions,
): Promise<void> {
  const sql = await getSql();
  const [version, actor] = await Promise.all([getVersion(), getActorName()]);
  const doc = createExportDocument(type, groups, version, actor);

  const { data, skipped } = await exportFn(sql);
  doc.data = data;
  doc.skippedTables = skipped;

  outputDocument(doc, options);
}

// ============================================================================
// Registration
// ============================================================================

export function registerExportCommands(program: Command): void {
  const exp = program.command('export').description('Export genie data as JSON');

  const sharedOpts = (cmd: ReturnType<Command['command']>) =>
    cmd.option('--output <file>', 'Write to file instead of stdout').option('--pretty', 'Pretty-print JSON');

  // genie export all
  sharedOpts(exp.command('all').description('Full backup (all present tables)')).action(
    async (options: ExportOptions) => {
      try {
        if (!options.output) options.output = autoOutputName();
        await runExport([...ALL_GROUPS], 'full', (sql) => exportAll(sql), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    },
  );

  // genie export boards [name]
  sharedOpts(exp.command('boards [name]').description('Export boards, templates, and task types')).action(
    async (name: string | undefined, options: ExportOptions) => {
      try {
        await runExport(['boards'], 'partial', (sql) => exportBoards(sql, name), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    },
  );

  // genie export tasks
  sharedOpts(
    exp
      .command('tasks')
      .description('Export tasks with deps, actors, and stage log')
      .option('--project <name>', 'Filter by project name'),
  ).action(async (options: ExportOptions & { project?: string }) => {
    try {
      await runExport(['tasks'], 'partial', (sql) => exportTasks(sql, options.project), options);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

  // genie export tags
  sharedOpts(exp.command('tags').description('Export tags')).action(async (options: ExportOptions) => {
    try {
      await runExport(['tags'], 'partial', (sql) => exportTags(sql), options);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

  // genie export projects
  sharedOpts(exp.command('projects').description('Export projects')).action(async (options: ExportOptions) => {
    try {
      await runExport(['projects'], 'partial', (sql) => exportGroup(sql, 'projects'), options);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

  // genie export schedules [name]
  sharedOpts(exp.command('schedules [name]').description('Export schedules with run_spec')).action(
    async (name: string | undefined, options: ExportOptions) => {
      try {
        await runExport(['schedules'], 'partial', (sql) => exportSchedules(sql, name), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    },
  );

  // genie export agents
  sharedOpts(exp.command('agents').description('Export agents, templates, and checkpoints')).action(
    async (options: ExportOptions) => {
      try {
        await runExport(['agents'], 'partial', (sql) => exportGroup(sql, 'agents'), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    },
  );

  // genie export apps
  sharedOpts(exp.command('apps').description('Export app store (graceful skip if missing)')).action(
    async (options: ExportOptions) => {
      try {
        await runExport(['apps'], 'partial', (sql) => exportGroup(sql, 'apps'), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    },
  );

  // genie export comms
  sharedOpts(exp.command('comms').description('Export conversations, messages, mailbox')).action(
    async (options: ExportOptions) => {
      try {
        await runExport(['comms'], 'partial', (sql) => exportGroup(sql, 'comms'), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    },
  );

  // genie export config
  sharedOpts(exp.command('config').description('Export OS config (graceful skip if missing)')).action(
    async (options: ExportOptions) => {
      try {
        await runExport(['config'], 'partial', (sql) => exportGroup(sql, 'config'), options);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    },
  );
}
