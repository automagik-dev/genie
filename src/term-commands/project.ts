/**
 * Project commands — CLI interface for project management.
 *
 * Commands:
 *   genie project list                         — List all projects
 *   genie project create <name> [options]      — Create a project
 *   genie project show <name>                  — Show project detail
 *   genie project set-default <name>           — Set default project in config
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

function truncate(str: string, len: number): string {
  return str.length <= len ? str : `${str.slice(0, len - 1)}…`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function printProjectList(ts: typeof taskServiceTypes, projects: taskServiceTypes.ProjectRow[]): Promise<void> {
  const counts: Record<string, number> = {};
  for (const p of projects) {
    const tasks = await ts.listTasks({ projectName: p.name, allProjects: true });
    counts[p.id] = tasks.length;
  }

  console.log(
    `  ${padRight('NAME', 20)} ${padRight('TYPE', 10)} ${padRight('TASKS', 8)} ${padRight('CREATED', 12)} PATH`,
  );
  console.log(`  ${'─'.repeat(80)}`);

  for (const p of projects) {
    const type = p.repoPath ? 'repo' : 'virtual';
    const path = p.repoPath ? truncate(p.repoPath, 40) : '-';
    console.log(
      `  ${padRight(p.name, 20)} ${padRight(type, 10)} ${padRight(String(counts[p.id] ?? 0), 8)} ${padRight(formatDate(p.createdAt), 12)} ${path}`,
    );
  }

  console.log(`\n  ${projects.length} project${projects.length === 1 ? '' : 's'}`);
}

function printProjectDetail(p: taskServiceTypes.ProjectRow, tasks: taskServiceTypes.TaskRow[]): void {
  const byStatus: Record<string, number> = {};
  const byStage: Record<string, number> = {};
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    byStage[t.stage] = (byStage[t.stage] ?? 0) + 1;
  }

  console.log(`\nProject: ${p.name}`);
  console.log('─'.repeat(50));
  console.log(`  ID:      ${p.id}`);
  console.log(`  Type:    ${p.repoPath ? 'repo' : 'virtual'}`);
  if (p.repoPath) console.log(`  Path:    ${p.repoPath}`);
  if (p.description) console.log(`  Desc:    ${p.description}`);
  console.log(`  Created: ${formatDate(p.createdAt)}`);
  console.log(`  Tasks:   ${tasks.length}`);

  if (tasks.length > 0) {
    console.log('\n  By status:');
    for (const [status, count] of Object.entries(byStatus).sort()) {
      console.log(`    ${padRight(status, 15)} ${count}`);
    }
    console.log('\n  By stage:');
    for (const [stage, count] of Object.entries(byStage).sort()) {
      console.log(`    ${padRight(stage, 15)} ${count}`);
    }
  }
}

export function registerProjectCommands(program: Command): void {
  const project = program.command('project').description('Project management — named task boards');

  // ── project list ──
  project
    .command('list')
    .description('List all projects')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const ts = await getTaskService();
        const projects = await ts.listProjects();

        if (options.json) {
          console.log(JSON.stringify(projects, null, 2));
          return;
        }

        if (projects.length === 0) {
          console.log('No projects found. Projects are auto-created when you run `genie task create`.');
          return;
        }

        await printProjectList(ts, projects);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── project create ──
  project
    .command('create <name>')
    .description('Create a new project')
    .option('--virtual', 'Create a virtual project (not tied to a repo)')
    .option('--repo <path>', 'Repo path for the project')
    .option('--description <text>', 'Project description')
    .action(async (name: string, options: { virtual?: boolean; repo?: string; description?: string }) => {
      try {
        const ts = await getTaskService();
        const repoPath = options.virtual ? null : (options.repo ?? null);
        const p = await ts.createProject({ name, repoPath, description: options.description });
        console.log(`Created project "${p.name}"`);
        console.log(`  ID:   ${p.id}`);
        console.log(`  Type: ${p.repoPath ? 'repo' : 'virtual'}`);
        if (p.repoPath) console.log(`  Path: ${p.repoPath}`);
        if (p.description) console.log(`  Desc: ${p.description}`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── project show ──
  project
    .command('show <name>')
    .description('Show project detail with task stats')
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: { json?: boolean }) => {
      try {
        const ts = await getTaskService();
        const p = await ts.getProjectByName(name);
        if (!p) {
          console.error(`Error: Project not found: ${name}`);
          process.exit(1);
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(p, null, 2));
          return;
        }

        const tasks = await ts.listTasks({ projectName: name, allProjects: true });
        printProjectDetail(p, tasks);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });

  // ── project set-default ──
  project
    .command('set-default <name>')
    .description('Set default project for when outside any repo')
    .action(async (name: string) => {
      try {
        const ts = await getTaskService();
        const p = await ts.getProjectByName(name);
        if (!p) {
          console.error(`Error: Project not found: ${name}`);
          process.exit(1);
        }

        const { loadGenieConfig, saveGenieConfig } = await import('../lib/genie-config.js');
        const config = await loadGenieConfig();
        (config as Record<string, unknown>).defaultProject = name;
        await saveGenieConfig(config);
        console.log(`Default project set to "${name}"`);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    });
}
