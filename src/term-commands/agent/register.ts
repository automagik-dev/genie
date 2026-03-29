/**
 * genie agent register <name> — Register an agent locally + auto-register in Omni.
 * Migrated from `genie agent register` in dir.ts (registerAgentNamespace).
 *
 * Note: This re-exports the existing handler from dir.ts. The old
 * `registerAgentNamespace` already registers under `agent register`.
 * We re-use the handler logic directly.
 */

import { resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import * as directory from '../../lib/agent-directory.js';
import { contractPath } from '../../lib/genie-config.js';
import { findOmniAgent, registerAgentInOmni, resolveOmniApiUrl } from '../../lib/omni-registration.js';

interface RegisterOptions {
  dir: string;
  repo?: string;
  promptMode: string;
  model?: string;
  roles?: string[];
  global?: boolean;
  skipOmni?: boolean;
}

function validatePromptMode(mode: string): 'system' | 'append' {
  if (mode !== 'system' && mode !== 'append') {
    throw new Error(`Invalid prompt mode "${mode}". Must be "append" or "system".`);
  }
  return mode;
}

function normalizeRoles(roles?: string[]): string[] | undefined {
  if (!roles) return undefined;
  return roles
    .flatMap((r) => r.split(','))
    .map((r) => r.trim())
    .filter(Boolean);
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

async function handleOmniRegistration(
  name: string,
  options: { model?: string; roles?: string[]; global?: boolean },
): Promise<void> {
  const omniUrl = await resolveOmniApiUrl();
  if (!omniUrl) return;

  console.log(`\nRegistering in Omni (${omniUrl})...`);

  const existingId = await findOmniAgent(name);
  if (existingId) {
    console.log(`  Agent already exists in Omni: ${existingId}`);
    await directory.edit(name, { omniAgentId: existingId }, { global: options.global });
    console.log('  Linked existing Omni agent to directory entry.');
    return;
  }

  const omniAgentId = await registerAgentInOmni(name, {
    model: options.model,
    roles: options.roles,
  });
  if (omniAgentId) {
    await directory.edit(name, { omniAgentId }, { global: options.global });
    console.log(`  Omni agent created: ${omniAgentId}`);
    console.log('  Session isolation: per-person + per-channel');
  }
}

async function handleAgentRegister(name: string, options: RegisterOptions): Promise<void> {
  const promptMode = validatePromptMode(options.promptMode);
  const roles = normalizeRoles(options.roles);
  const entry = await directory.add(
    {
      name,
      dir: resolvePath(options.dir),
      repo: options.repo ? resolvePath(options.repo) : undefined,
      promptMode,
      model: options.model,
      roles,
    },
    { global: options.global },
  );

  const scope = options.global ? 'global' : 'project';
  console.log(`Agent "${entry.name}" registered (${scope}).`);
  printEntry(entry);

  if (!options.skipOmni) {
    await handleOmniRegistration(name, { ...options, roles });
  }
}

export function registerAgentRegister(parent: Command): void {
  parent
    .command('register <name>')
    .description('Register an agent locally and auto-register in Omni when configured')
    .requiredOption('--dir <path>', 'Agent folder (CWD + AGENTS.md)')
    .option('--repo <path>', 'Default git repo (overridden by team)')
    .option('--prompt-mode <mode>', 'Prompt mode: append or system', 'append')
    .option('--model <model>', 'Default model (sonnet, opus, codex)')
    .option('--roles <roles...>', 'Built-in roles this agent can orchestrate')
    .option('--global', 'Write to global directory instead of project')
    .option('--skip-omni', 'Skip Omni auto-registration')
    .action(async (name: string, options: RegisterOptions) => {
      try {
        await handleAgentRegister(name, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
