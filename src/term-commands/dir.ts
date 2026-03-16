/**
 * Dir Namespace — Agent directory CRUD commands.
 *
 * Commands:
 *   genie dir add <name>   — Register an agent
 *   genie dir rm <name>    — Remove an agent
 *   genie dir ls [<name>]  — List all or show single entry
 *   genie dir edit <name>  — Update entry fields
 */

import { resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import * as directory from '../lib/agent-directory.js';
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
    .action(
      async (
        name: string,
        options: {
          dir: string;
          repo?: string;
          promptMode: string;
          model?: string;
          roles?: string[];
          global?: boolean;
        },
      ) => {
        try {
          const promptMode = validatePromptMode(options.promptMode);
          const entry = await directory.add(
            {
              name,
              dir: resolvePath(options.dir),
              repo: options.repo ? resolvePath(options.repo) : undefined,
              promptMode,
              model: options.model,
              roles: options.roles,
            },
            { global: options.global },
          );
          const scope = options.global ? 'global' : 'project';
          console.log(`Agent "${entry.name}" registered (${scope}).`);
          console.log(`  Dir: ${contractPath(entry.dir)}`);
          if (entry.repo) console.log(`  Repo: ${contractPath(entry.repo)}`);
          console.log(`  Prompt mode: ${entry.promptMode}`);
          if (entry.model) console.log(`  Model: ${entry.model}`);
          if (entry.roles?.length) console.log(`  Roles: ${entry.roles.join(', ')}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Error: ${message}`);
          process.exit(1);
        }
      },
    );

  // dir rm <name>
  dir
    .command('rm <name>')
    .description('Remove an agent from the directory')
    .option('--global', 'Remove from global directory instead of project')
    .action(async (name: string, options: { global?: boolean }) => {
      try {
        const removed = await directory.rm(name, { global: options.global });
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
    .action(async (name: string | undefined, options: { json?: boolean; builtins?: boolean }) => {
      try {
        if (name) {
          // Show single entry
          await showEntry(name, options.json);
        } else {
          // List all
          await listEntries(options.json, options.builtins);
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
}

interface EditOptions {
  dir?: string;
  repo?: string;
  promptMode?: string;
  model?: string;
  roles?: string[];
  global?: boolean;
}

async function handleEdit(name: string, options: EditOptions): Promise<void> {
  const updates: Parameters<typeof directory.edit>[1] = {};
  if (options.dir) updates.dir = resolvePath(options.dir);
  if (options.repo) updates.repo = resolvePath(options.repo);
  if (options.promptMode) updates.promptMode = validatePromptMode(options.promptMode);
  if (options.model) updates.model = options.model;
  if (options.roles) updates.roles = options.roles;

  if (Object.keys(updates).length === 0) {
    console.error('No fields to update. Provide at least one of: --dir, --repo, --prompt-mode, --model, --roles');
    process.exit(1);
  }

  const entry = await directory.edit(name, updates, { global: options.global });
  const scope = options.global ? 'global' : 'project';
  console.log(`Agent "${name}" updated (${scope}).`);
  printEntry(entry);
}

// ============================================================================
// Helpers
// ============================================================================

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
  console.log(`  Prompt mode: ${entry.promptMode}`);
  if (entry.model) console.log(`  Model: ${entry.model}`);
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

async function listEntries(json?: boolean, includeBuiltins?: boolean): Promise<void> {
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

function printRegisteredTable(entries: directory.ScopedDirectoryEntry[]): void {
  const nameW = 22;
  const scopeW = 10;
  const dirW = 30;
  const modeW = 8;
  const modelW = 8;

  console.log('');
  console.log('REGISTERED AGENTS');
  console.log('-'.repeat(85));
  console.log(
    `  ${'NAME'.padEnd(nameW)}${'SCOPE'.padEnd(scopeW)}${'DIR'.padEnd(dirW)}${'MODE'.padEnd(modeW)}${'MODEL'.padEnd(modelW)}ROLES`,
  );
  console.log(
    `  ${'-'.repeat(nameW - 2)}  ${'-'.repeat(scopeW - 2)}  ${'-'.repeat(dirW - 2)}  ${'-'.repeat(modeW - 2)}  ${'-'.repeat(modelW - 2)}  ${'-'.repeat(15)}`,
  );

  for (const entry of entries) {
    const dir = contractPath(entry.dir);
    const truncDir = dir.length > dirW - 2 ? `${dir.slice(0, dirW - 5)}...` : dir;
    const roles = entry.roles?.join(', ') || '-';
    console.log(
      `  ${entry.name.padEnd(nameW)}${entry.scope.padEnd(scopeW)}${truncDir.padEnd(dirW)}${entry.promptMode.padEnd(modeW)}${(entry.model || '-').padEnd(modelW)}${roles}`,
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
