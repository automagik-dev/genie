/**
 * genie agent directory — List agents from directory.
 * Migrated from `genie dir ls` in dir.ts.
 */

import type { Command } from 'commander';
import { type StoreRow, listItemsFromStore, migrateAgentDirectory } from '../../lib/agent-cache.js';
import * as directory from '../../lib/agent-directory.js';
import { syncAgentDirectory } from '../../lib/agent-sync.js';
import { ALL_BUILTINS } from '../../lib/builtin-agents.js';
import { contractPath } from '../../lib/genie-config.js';

async function showEntry(name: string, json?: boolean): Promise<void> {
  const resolved = await directory.resolve(name);
  if (!resolved) {
    console.error(`Agent "${name}" not found in directory or built-ins.`);
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify({ ...resolved.entry, builtin: resolved.builtin }, null, 2));
    return;
  }

  if (resolved.builtin) {
    console.log('\n(built-in agent)');
  }
  console.log('');
  console.log(`  Name: ${resolved.entry.name}`);
  console.log(`  Dir: ${contractPath(resolved.entry.dir)}`);
  if (resolved.entry.repo) console.log(`  Repo: ${contractPath(resolved.entry.repo)}`);
  console.log(`  Prompt mode: ${resolved.entry.promptMode}`);
  if (resolved.entry.model) console.log(`  Model: ${resolved.entry.model}`);
  if (resolved.entry.roles?.length) console.log(`  Roles: ${resolved.entry.roles.join(', ')}`);
  console.log(`  Registered: ${resolved.entry.registeredAt}`);
  console.log('');
}

function printRegisteredAgentsTable(entries: directory.ScopedDirectoryEntry[]): void {
  const nameW = 22;
  const scopeW = 10;
  const modelW = 8;
  const termW = process.stdout.columns || 120;

  const repoValues = entries.map((e) => (e.repo ? contractPath(e.repo) : contractPath(e.dir)));
  const maxRepoLen = Math.max('REPO'.length, ...repoValues.map((v) => v.length));
  const fixedW = 2 + nameW + scopeW + modelW;
  const repoW = Math.min(maxRepoLen + 2, Math.max(30, termW - fixedW - 20));

  console.log('');
  console.log('REGISTERED AGENTS');
  console.log('-'.repeat(Math.max(90, fixedW + repoW + 20)));
  console.log(
    `  ${'NAME'.padEnd(nameW)}${'SCOPE'.padEnd(scopeW)}${'REPO'.padEnd(repoW)}${'MODEL'.padEnd(modelW)}ROLES`,
  );

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const repo = repoValues[i];
    const roles = entry.roles?.join(', ') || '-';
    console.log(
      `  ${entry.name.padEnd(nameW)}${entry.scope.padEnd(scopeW)}${repo.padEnd(repoW)}${(entry.model || '-').padEnd(modelW)}${roles}`,
    );
  }
  console.log('');
}

function printBuiltinAgentsTable(): void {
  const nameW = 22;
  const catW = 10;
  const modelW = 8;

  console.log('BUILT-IN AGENTS');
  console.log('-'.repeat(80));
  console.log(`  ${'NAME'.padEnd(nameW)}${'TYPE'.padEnd(catW)}${'MODEL'.padEnd(modelW)}DESCRIPTION`);

  for (const agent of ALL_BUILTINS) {
    console.log(
      `  ${agent.name.padEnd(nameW)}${agent.category.padEnd(catW)}${(agent.model || '-').padEnd(modelW)}${agent.description}`,
    );
  }
  console.log('');
}

function normalizeRoles(roles?: string[]): string[] | undefined {
  if (!roles) return undefined;
  return roles
    .flatMap((r) => r.split(','))
    .map((r) => r.trim())
    .filter(Boolean);
}

async function listEntries(json?: boolean, includeBuiltins?: boolean, includeArchived?: boolean): Promise<void> {
  await migrateAgentDirectory().catch(() => {});

  let entries: directory.ScopedDirectoryEntry[];
  try {
    const storeItems = await listItemsFromStore('agent');
    entries = storeItems
      .filter((item: StoreRow) => {
        if (includeArchived) return true;
        const manifest = (item.manifest ?? {}) as Record<string, unknown>;
        return !manifest.archived;
      })
      .map((item: StoreRow) => {
        const manifest = (item.manifest ?? {}) as Record<string, unknown>;
        return {
          name: item.name,
          dir: (item.install_path as string) ?? '',
          repo: (manifest.repo as string) ?? '',
          promptMode: ((manifest.promptMode as string) ?? 'append') as directory.PromptMode,
          model: manifest.model as string | undefined,
          roles: normalizeRoles(manifest.roles as string[] | undefined),
          registeredAt: item.installed_at as string,
          scope: (manifest.archived ? 'archived' : 'global') as directory.DirectoryScope,
        };
      });
  } catch {
    entries = await directory.ls();
  }

  if (json) {
    const result: Record<string, unknown>[] = entries.map((e) => ({ ...e, builtin: false }));
    if (includeBuiltins) {
      for (const b of ALL_BUILTINS) {
        result.push({
          name: b.name,
          description: b.description,
          model: b.model,
          category: b.category,
          scope: 'built-in',
          builtin: true,
        });
      }
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (entries.length === 0 && !includeBuiltins) {
    console.log('\nNo agents registered. Add one with: genie agent register <name> --dir <path>');
    console.log('Use --builtins to also see built-in roles and council members.\n');
    return;
  }

  if (entries.length > 0) {
    printRegisteredAgentsTable(entries);
  }

  if (includeBuiltins) {
    printBuiltinAgentsTable();
  }
}

export function registerAgentDirectory(parent: Command): void {
  parent
    .command('directory [name]')
    .alias('dir')
    .description('List all agents or show single entry details from directory')
    .option('--json', 'Output as JSON')
    .option('--builtins', 'Include built-in roles and council members')
    .option('--all', 'Include archived agents')
    .action(async (name: string | undefined, options: { json?: boolean; builtins?: boolean; all?: boolean }) => {
      try {
        if (name === 'sync') {
          await handleSync();
        } else if (name) {
          await showEntry(name, options.json);
        } else {
          await listEntries(options.json, options.builtins, options.all);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}

async function handleSync(): Promise<void> {
  const { findWorkspace } = await import('../../lib/workspace.js');
  const ws = findWorkspace();
  if (!ws) {
    console.error('Not in a genie workspace. Run `genie init` first.');
    process.exit(1);
  }

  console.log(`Syncing agents from ${ws.root}/agents/...`);
  const result = await syncAgentDirectory(ws.root);

  if (result.registered.length > 0) console.log(`  Registered: ${result.registered.join(', ')}`);
  if (result.updated.length > 0) console.log(`  Updated: ${result.updated.join(', ')}`);
  if (result.reactivated.length > 0) console.log(`  Reactivated: ${result.reactivated.join(', ')}`);
  if (result.archived.length > 0) console.log(`  Archived: ${result.archived.join(', ')}`);
  if (result.unchanged.length > 0) console.log(`  Unchanged: ${result.unchanged.join(', ')}`);
  for (const err of result.errors) {
    console.error(`  Error (${err.name}): ${err.error}`);
  }

  const total = result.registered.length + result.updated.length + result.unchanged.length + result.reactivated.length;
  console.log(`\nSync complete: ${total} active agent(s), ${result.archived.length} archived.`);
}
