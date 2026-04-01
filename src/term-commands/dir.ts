/**
 * Dir Namespace — Agent directory CRUD commands.
 *
 * Commands:
 *   genie dir add <name>   — Register an agent
 *   genie dir rm <name>    — Remove an agent
 *   genie dir ls [<name>]  — List all or show single entry
 *   genie dir edit <name>  — Update entry fields
 *
 * Agent Namespace — Agent lifecycle commands.
 *
 * Commands:
 *   genie agent register <name>  — Register agent locally + auto-register in Omni
 *
 * Storage: agent-directory.json is the source of truth for registered agents.
 */

import { resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import * as directory from '../lib/agent-directory.js';
import { printSyncResult, syncAgentDirectory } from '../lib/agent-sync.js';
import { getActor, recordAuditEvent } from '../lib/audit.js';
import { ALL_BUILTINS } from '../lib/builtin-agents.js';
import { contractPath } from '../lib/genie-config.js';

export function registerDirNamespace(program: Command): void {
  const dir = program.command('dir').description('Agent directory management');

  // dir add <name>
  dir
    .command('add <name>')
    .description('Register an agent in the directory')
    .requiredOption('--dir <path>', 'Agent folder (CWD + AGENTS.md)')
    .option('--repo <path>', 'Default git repo (overridden by team)')
    .option('--prompt-mode <mode>', 'Prompt mode: append or system', 'append')
    .option('--model <model>', 'Default model (sonnet, opus, codex)')
    .option('--roles <roles...>', 'Built-in roles this agent can orchestrate')
    .option('--global', 'Write to global directory instead of project')
    .action(async (name: string, options: DirAddOptions) => {
      try {
        await handleDirAdd(name, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // dir rm <name>
  dir
    .command('rm <name>')
    .description('Remove an agent from the directory')
    .option('--global', 'Remove from global directory instead of project')
    .action(async (name: string, options: { global?: boolean }) => {
      try {
        const removed = await directory.rm(name, { global: options.global });
        recordAuditEvent('item', name, 'item_removed', getActor(), { type: 'agent', source: 'dir_rm' }).catch(() => {});

        if (removed) {
          const scope = options.global ? 'global' : 'project';
          console.log(`Agent "${name}" removed from ${scope} directory.`);
        } else {
          console.error(`Agent "${name}" not found in directory.`);
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // dir ls [<name>]
  dir
    .command('ls [name]')
    .description('List all agents or show single entry details')
    .option('--json', 'Output as JSON')
    .option('--builtins', 'Include built-in roles and council members')
    .option('--all', 'Include archived agents')
    .action(async (name: string | undefined, options: { json?: boolean; builtins?: boolean; all?: boolean }) => {
      try {
        if (name) {
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

  // dir edit <name>
  dir
    .command('edit <name>')
    .description('Update an agent directory entry')
    .option('--dir <path>', 'Agent folder (CWD + AGENTS.md)')
    .option('--repo <path>', 'Default git repo')
    .option('--prompt-mode <mode>', 'Prompt mode: append or system')
    .option('--model <model>', 'Default model')
    .option('--provider <provider>', 'AI provider: claude or codex')
    .option('--color <color>', 'Display color for TUI')
    .option('--description <desc>', 'Agent description')
    .option('--roles <roles...>', 'Built-in roles this agent can orchestrate')
    .option('--global', 'Edit in global directory instead of project')
    .action(async (name: string, options: EditOptions) => {
      try {
        await handleEdit(name, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // dir sync
  dir
    .command('sync')
    .description('Sync agents from workspace agents/ directory')
    .action(async () => {
      try {
        await handleDirSync();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}

interface DirAddOptions {
  dir: string;
  repo?: string;
  promptMode: string;
  model?: string;
  roles?: string[];
  global?: boolean;
}

async function handleDirAdd(name: string, options: DirAddOptions): Promise<void> {
  const promptMode = validatePromptMode(options.promptMode);
  const resolvedDir = resolvePath(options.dir);
  if (options.repo) validateRepoPath(options.repo);
  const entry = await directory.add(
    {
      name,
      dir: resolvedDir,
      repo: options.repo ? resolvePath(options.repo) : undefined,
      promptMode,
      model: options.model,
      roles: normalizeRoles(options.roles),
    },
    { global: options.global },
  );

  recordAuditEvent('item', name, 'item_registered', getActor(), { type: 'agent', source: 'dir_add' }).catch(() => {});

  const scope = options.global ? 'global' : 'project';
  console.log(`Agent "${entry.name}" registered (${scope}).`);
  printEntry(entry);
}

interface EditOptions {
  dir?: string;
  repo?: string;
  promptMode?: string;
  model?: string;
  provider?: string;
  color?: string;
  description?: string;
  roles?: string[];
  global?: boolean;
}

async function handleEdit(name: string, options: EditOptions): Promise<void> {
  const updates: Parameters<typeof directory.edit>[1] = {};
  if (options.dir) updates.dir = resolvePath(options.dir);
  if (options.repo) updates.repo = resolvePath(options.repo);
  if (options.promptMode) updates.promptMode = validatePromptMode(options.promptMode);
  if (options.model) updates.model = options.model;
  if (options.provider) updates.provider = options.provider;
  if (options.color) updates.color = options.color;
  if (options.description) updates.description = options.description;
  if (options.roles) updates.roles = normalizeRoles(options.roles);

  if (Object.keys(updates).length === 0) {
    console.error(
      'No fields to update. Provide at least one of: --dir, --repo, --prompt-mode, --model, --provider, --color, --description, --roles',
    );
    process.exit(1);
  }

  const entry = await directory.edit(name, updates, { global: options.global });

  recordAuditEvent('item', name, 'item_updated', getActor(), { type: 'agent', source: 'dir_edit' }).catch(() => {});

  const scope = options.global ? 'global' : 'project';
  console.log(`Agent "${name}" updated (${scope}).`);
  printEntry(entry);
}

async function handleDirSync(): Promise<void> {
  const { findWorkspace } = await import('../lib/workspace.js');
  const ws = findWorkspace();
  if (!ws) {
    console.error('Not in a genie workspace. Run `genie init` first.');
    process.exit(1);
  }

  console.log(`Syncing agents from ${ws.root}/agents/...`);
  const result = await syncAgentDirectory(ws.root);
  printSyncResult(result);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Validate that a REPO value looks like a real path.
 * Accepts: absolute paths (/...), home-relative (~/...), dot-relative (./..., ../...).
 * Rejects: bare words like 'genie' that are likely agent names, not paths.
 */
export function validateRepoPath(repo: string): void {
  if (repo.startsWith('/') || repo.startsWith('~/') || repo.startsWith('./') || repo.startsWith('../')) return;
  throw new Error(
    `Invalid --repo value "${repo}". Must be a path (absolute "/...", home-relative "~/...", or dot-relative "./..." / "../..."). Got a bare word instead.`,
  );
}

function validatePromptMode(mode: string): 'system' | 'append' {
  if (mode !== 'system' && mode !== 'append') {
    throw new Error(`Invalid prompt mode "${mode}". Must be "append" or "system".`);
  }
  return mode;
}

function printEntry(entry: directory.DirectoryEntry): void {
  console.log(`  Name: ${entry.name}`);
  console.log(`  Dir: ${contractPath(entry.dir)}`);
  if (entry.repo) console.log(`  Repo: ${contractPath(entry.repo)}`);
  console.log(`  PromptMode: ${entry.promptMode}`);
  if (entry.model) console.log(`  Model: ${entry.model}`);
  if (entry.provider) console.log(`  Provider: ${entry.provider}`);
  if (entry.color) console.log(`  Color: ${entry.color}`);
  if (entry.description) console.log(`  Description: ${entry.description}`);
  if (entry.roles?.length) console.log(`  Roles: ${entry.roles.join(', ')}`);
  console.log(`  Registered: ${entry.registeredAt}`);
}

async function showEntry(name: string, json?: boolean): Promise<void> {
  // Try user directory first, then resolve (includes built-ins)
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
    console.log(`\n(built-in ${resolved.entry.registeredAt === '(built-in)' ? 'agent' : 'agent'})`);
  }
  console.log('');
  printEntry(resolved.entry);
  console.log('');
}

async function listEntries(json?: boolean, includeBuiltins?: boolean, _includeArchived?: boolean): Promise<void> {
  const entries = await directory.ls();

  if (json) {
    listEntriesJson(entries, includeBuiltins);
    return;
  }

  if (entries.length === 0 && !includeBuiltins) {
    console.log('\nNo agents registered. Add one with: genie dir add <name> --dir <path>');
    console.log('Use --builtins to also see built-in roles and council members.\n');
    return;
  }

  if (entries.length > 0) {
    printRegisteredTable(entries);
  }

  if (includeBuiltins) {
    printBuiltinsTable();
  }
}

function listEntriesJson(entries: directory.ScopedDirectoryEntry[], includeBuiltins?: boolean): void {
  const result: Record<string, unknown>[] = entries.map((e) => ({
    ...e,
    builtin: false,
  }));
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
}

/** Normalize roles: split comma-separated values into individual array items. */
function normalizeRoles(roles?: string[]): string[] | undefined {
  if (!roles) return undefined;
  return roles
    .flatMap((r) => r.split(','))
    .map((r) => r.trim())
    .filter(Boolean);
}

function printRegisteredTable(entries: directory.ScopedDirectoryEntry[]): void {
  const nameW = 22;
  const scopeW = 10;
  const modelW = 10;
  const providerW = 10;

  // Compute repo paths and roles upfront for dynamic sizing
  const repoValues: string[] = [];
  const roleValues: string[] = [];
  for (const entry of entries) {
    repoValues.push(entry.repo ? contractPath(entry.repo) : contractPath(entry.dir));
    roleValues.push(entry.roles?.join(', ') || '-');
  }

  // Size REPO column to fit longest value, capped to leave room for ROLES
  const termW = process.stdout.columns || 120;
  const fixedW = 2 + nameW + scopeW + modelW + providerW; // leading indent + fixed columns
  const maxRepoLen = Math.max('REPO'.length, ...repoValues.map((v) => v.length));
  const repoW = Math.min(maxRepoLen + 2, Math.max(30, termW - fixedW - 20));

  const totalW = fixedW + repoW + 20;

  console.log('');
  console.log('REGISTERED AGENTS');
  console.log('-'.repeat(Math.max(90, totalW)));
  console.log(
    `  ${'NAME'.padEnd(nameW)}${'SCOPE'.padEnd(scopeW)}${'REPO'.padEnd(repoW)}${'MODEL'.padEnd(modelW)}${'PROVIDER'.padEnd(providerW)}ROLES`,
  );
  console.log(
    `  ${'-'.repeat(nameW - 2)}  ${'-'.repeat(scopeW - 2)}  ${'-'.repeat(repoW - 2)}  ${'-'.repeat(modelW - 2)}  ${'-'.repeat(providerW - 2)}  ${'-'.repeat(20)}`,
  );

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const repo = repoValues[i];
    const roles = roleValues[i];
    console.log(
      `  ${entry.name.padEnd(nameW)}${entry.scope.padEnd(scopeW)}${repo.padEnd(repoW)}${(entry.model || '-').padEnd(modelW)}${(entry.provider || '-').padEnd(providerW)}${roles}`,
    );
  }
  console.log('');
}

function printBuiltinsTable(): void {
  const nameW = 22;
  const catW = 10;
  const modelW = 8;

  console.log('BUILT-IN AGENTS');
  console.log('-'.repeat(80));
  console.log(`  ${'NAME'.padEnd(nameW)}${'TYPE'.padEnd(catW)}${'MODEL'.padEnd(modelW)}DESCRIPTION`);
  console.log(`  ${'-'.repeat(nameW - 2)}  ${'-'.repeat(catW - 2)}  ${'-'.repeat(modelW - 2)}  ${'-'.repeat(30)}`);

  for (const agent of ALL_BUILTINS) {
    console.log(
      `  ${agent.name.padEnd(nameW)}${agent.category.padEnd(catW)}${(agent.model || '-').padEnd(modelW)}${agent.description}`,
    );
  }
  console.log('');
}
