/**
 * Dir Namespace — Agent directory CRUD commands.
 *
 * Commands:
 *   genie dir add <name>   — Register an agent
 *   genie dir rm <name>    — Remove an agent
 *   genie dir ls [<name>]  — List all or show single entry
 *   genie dir edit <name>  — Update entry fields
 *   genie dir export <name> — Print full AGENTS.md frontmatter from PG state
 *
 * Agent Namespace — Agent lifecycle commands.
 *
 * Commands:
 *   genie agent register <name>  — Register agent locally + auto-register in Omni
 *
 * Storage: agent-directory.json is the source of truth for registered agents.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import * as directory from '../lib/agent-directory.js';
import { migrateAgentToYaml } from '../lib/agent-migrate.js';
import { printSyncResult, syncAgentDirectory, syncSingleAgentByName } from '../lib/agent-sync.js';
import { type AgentConfig, parseAgentYaml, writeAgentYaml } from '../lib/agent-yaml.js';
import { getActor, recordAuditEvent } from '../lib/audit.js';
import { ALL_BUILTINS } from '../lib/builtin-agents.js';
import { RESOLVED_FIELDS, type ResolveContext, resolveFieldWithSource } from '../lib/defaults.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { contractPath } from '../lib/genie-config.js';
import type { SdkBeta, SdkDirectoryConfig, SdkThinkingConfig } from '../lib/sdk-directory-types.js';
import { findWorkspace, getWorkspaceConfig } from '../lib/workspace.js';

export function registerDirNamespace(program: Command): void {
  const dir = program.command('dir').description('Agent directory management');

  // dir add <name>
  const addCmd = dir
    .command('add <name>')
    .description('Register an agent in the directory')
    .requiredOption('--dir <path>', 'Agent folder (CWD + AGENTS.md)')
    .option('--repo <path>', 'Default git repo (overridden by team)')
    .option('--prompt-mode <mode>', 'Prompt mode: append or system', 'append')
    .option('--model <model>', 'Default model (sonnet, opus, codex)')
    .option('--roles <roles...>', 'Built-in roles this agent can orchestrate')
    .option('--permission-preset <preset>', 'Permission preset: full, read-only, chat-only')
    .option('--allow <tools>', 'Comma-separated tool allow list (e.g. "Read,Glob,Grep,Bash")')
    .option('--bash-allow <patterns>', 'Comma-separated regex patterns for allowed bash commands')
    .option('--global', 'Write to global directory instead of project');
  registerSdkFlags(addCmd);
  addCmd.action(async (name: string, options: DirAddOptions) => {
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
    .option('--force', 'Also remove runtime/spawn rows sharing this role (id shapes: <team>-<role>, UUID)')
    .action(async (name: string, options: { global?: boolean; force?: boolean }) => {
      try {
        const result = await directory.rm(name, { global: options.global, force: options.force });

        if (result.removed) {
          const scope = options.global ? 'global' : 'project';
          console.log(`Agent "${name}" removed from ${scope} directory.`);
          // Only emit the audit event on actual removal — previously we logged
          // "item_removed" even when the DELETE matched zero rows.
          recordAuditEvent('item', name, 'item_removed', getActor(), { type: 'agent', source: 'dir_rm' }).catch(
            () => {},
          );
        } else if (result.message) {
          // Runtime rows exist but no directory entry — surface guidance.
          console.error(result.message);
          process.exit(1);
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
  const editCmd = dir
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
    .option('--permission-preset <preset>', 'Permission preset: full, read-only, chat-only')
    .option('--allow <tools>', 'Comma-separated tool allow list (e.g. "Read,Glob,Grep,Bash")')
    .option('--bash-allow <patterns>', 'Comma-separated regex patterns for allowed bash commands')
    .option('--global', 'Edit in global directory instead of project');
  registerSdkFlags(editCmd);
  editCmd.action(async (name: string, options: EditOptions) => {
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

  // dir export <name>
  dir
    .command('export <name>')
    .description('Print full AGENTS.md frontmatter for an agent from PG state')
    .option('--stdout', 'Print to stdout as raw YAML (default)')
    .option('--json', 'Print resolved fields as nested JSON with declared/resolved/source')
    .action(async (name: string, options: { json?: boolean }) => {
      try {
        await handleDirExport(name, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}

interface DirAddOptions extends SdkDirOptions {
  dir: string;
  repo?: string;
  promptMode: string;
  model?: string;
  roles?: string[];
  permissionPreset?: string;
  allow?: string;
  bashAllow?: string;
  global?: boolean;
}

async function handleDirAdd(name: string, options: DirAddOptions): Promise<void> {
  // dir-sync-frontmatter-refresh (Group 5): `dir add` scaffolds BOTH files on
  // disk — `agent.yaml` (CLI flags → config) and a frontmatter-less AGENTS.md
  // body template — then triggers sync to upsert the DB row. The yaml is the
  // canonical source of every runtime-consumed field; AGENTS.md holds pure
  // prompt content from line 1.

  const promptMode = validatePromptMode(options.promptMode);
  const resolvedDir = resolvePath(options.dir);
  if (options.repo) validateRepoPath(options.repo);
  const permissions = buildPermissions(options.permissionPreset, options.allow, options.bashAllow);
  const sdk = buildSdkConfig(options);

  // Build the on-disk AgentConfig. Derived fields (name/dir/registeredAt) are
  // stripped by writeAgentYaml before serialization.
  const config: AgentConfig = {
    promptMode,
    ...(options.model !== undefined && { model: options.model }),
    ...(options.repo !== undefined && { repo: resolvePath(options.repo) }),
    ...(options.roles !== undefined && { roles: normalizeRoles(options.roles) }),
    ...(permissions && { permissions }),
    ...(sdk && { sdk: sdk as AgentConfig['sdk'] }),
  };

  // Ensure the agent directory exists.
  mkdirSync(resolvedDir, { recursive: true });

  // Scaffold AGENTS.md without a frontmatter block. Users edit this for prompt
  // content; runtime config lives in agent.yaml.
  const agentsMdPath = join(resolvedDir, 'AGENTS.md');
  if (!existsSync(agentsMdPath)) {
    writeFileSync(agentsMdPath, scaffoldAgentsMdBody(name));
  }

  // Write agent.yaml atomically (locked).
  await writeAgentYaml(join(resolvedDir, 'agent.yaml'), config);

  // Propagate to the DB via the same single-agent sync path used by `dir edit`.
  const ws = findWorkspace();
  if (ws) {
    await syncSingleAgentByName(ws.root, name);
  } else {
    // Not in a workspace — register a stub in the directory table so the
    // agent is reachable even before the user runs `genie init`.
    await directory.add(
      {
        name,
        dir: resolvedDir,
        repo: options.repo ? resolvePath(options.repo) : undefined,
        promptMode,
        model: options.model,
        roles: normalizeRoles(options.roles),
        ...(permissions && { permissions }),
        ...(sdk && { sdk }),
      },
      { global: options.global },
    );
    console.warn('Not in a genie workspace — directory row created; run `genie dir sync` in a workspace to re-sync.');
  }

  recordAuditEvent('item', name, 'item_registered', getActor(), { type: 'agent', source: 'dir_add' }).catch(() => {});

  const scope = options.global ? 'global' : 'project';
  console.log(`Agent "${name}" registered (${scope}).`);
  const entry = await directory.get(name);
  if (entry) printEntry(entry);
}

/** AGENTS.md body template for a fresh agent — no YAML fence. */
function scaffoldAgentsMdBody(name: string): string {
  return `# Agent: ${name}

Describe what this agent does, how it behaves, and what it owns.
Runtime config (team, model, permissions, etc.) lives in \`agent.yaml\` —
this file is pure prompt content.

<mission>
TBD — single sentence stating the agent's primary goal.
</mission>
`;
}

interface EditOptions extends SdkDirOptions {
  dir?: string;
  repo?: string;
  promptMode?: string;
  model?: string;
  provider?: string;
  color?: string;
  description?: string;
  roles?: string[];
  permissionPreset?: string;
  allow?: string;
  bashAllow?: string;
  global?: boolean;
}

function collectAgentConfigUpdates(options: EditOptions): Partial<AgentConfig> {
  const updates: Partial<AgentConfig> = {};
  if (options.dir) updates.dir = resolvePath(options.dir);
  if (options.repo) updates.repo = resolvePath(options.repo);
  if (options.promptMode) updates.promptMode = validatePromptMode(options.promptMode);
  if (options.model) updates.model = options.model;
  if (options.provider) updates.provider = options.provider;
  if (options.color) updates.color = options.color;
  if (options.description) updates.description = options.description;
  if (options.roles) updates.roles = normalizeRoles(options.roles);

  const permissions = buildPermissions(options.permissionPreset, options.allow, options.bashAllow);
  if (permissions) updates.permissions = permissions;

  const sdk = buildSdkConfig(options);
  if (sdk) updates.sdk = sdk as AgentConfig['sdk'];
  return updates;
}

async function handleEdit(name: string, options: EditOptions): Promise<void> {
  // dir-sync-frontmatter-refresh (Group 4): `dir edit` writes to agent.yaml
  // FIRST, then triggers a single-agent sync so the PG row picks up the new
  // values. No more direct PG writes — the yaml file is the source of truth
  // and the sync path mirrors it into the DB.

  const updates = collectAgentConfigUpdates(options);

  if (Object.keys(updates).length === 0) {
    console.error(
      'No fields to update. Provide at least one of: --dir, --repo, --prompt-mode, --model, --provider, --color, --description, --roles, --permission-preset, --allow, --bash-allow, --sdk-*',
    );
    process.exit(1);
  }

  // Resolve the agent to find its on-disk directory.
  const resolved = await directory.resolve(name);
  if (!resolved || resolved.builtin || !resolved.entry.dir) {
    console.error(
      `Agent "${name}" not found (or has no on-disk directory — built-ins and synthetic entries can't be edited via dir edit).`,
    );
    process.exit(1);
  }
  const agentDir = resolved.entry.dir;

  // If the agent hasn't been migrated yet, migrate first. After this the
  // canonical source is agents/<name>/agent.yaml and AGENTS.md loses its
  // frontmatter (wish `dir-sync-frontmatter-refresh`).
  const yamlPath = join(agentDir, 'agent.yaml');
  if (!existsSync(yamlPath)) {
    const dbRow = {
      team: resolved.entry.team,
      model: resolved.entry.model,
      description: resolved.entry.description,
      color: resolved.entry.color,
      provider: resolved.entry.provider,
      promptMode: resolved.entry.promptMode,
      permissions: resolved.entry.permissions,
      disallowedTools: resolved.entry.disallowedTools,
      omniScopes: resolved.entry.omniScopes,
      hooks: resolved.entry.hooks,
      sdk: resolved.entry.sdk as unknown as AgentConfig['sdk'],
    };
    await migrateAgentToYaml(agentDir, dbRow);
  }

  // Read the current yaml, apply the updates, write atomically via the lock.
  const current = await parseAgentYaml(yamlPath);
  const next: AgentConfig = { ...current, ...updates };
  await writeAgentYaml(yamlPath, next);

  // Propagate into the DB by re-running the single-agent sync path. This
  // replaces the old `directory.edit(name, updates)` PG write.
  const ws = findWorkspace();
  if (ws) {
    await syncSingleAgentByName(ws.root, name);
  } else {
    // Not in a genie workspace — skip sync, but the yaml write stands.
    console.warn('Not in a genie workspace — agent.yaml updated on disk; run `genie dir sync` manually to propagate.');
  }

  recordAuditEvent('item', name, 'item_updated', getActor(), { type: 'agent', source: 'dir_edit' }).catch(() => {});

  const scope = options.global ? 'global' : 'project';
  console.log(`Agent "${name}" updated (${scope}).`);
  const refreshed = await directory.get(name);
  if (refreshed) printEntry(refreshed);
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

async function handleDirExport(name: string, options: { json?: boolean }): Promise<void> {
  const entry = await directory.get(name);
  if (!entry) {
    console.error(`Agent "${name}" not found in directory.`);
    process.exit(1);
  }

  if (options.json) {
    // Nested JSON with resolved fields: each key has {declared, resolved, source}
    const ctx = buildDirResolveContext(name);
    const output: Record<string, unknown> = { name: entry.name };
    for (const field of RESOLVED_FIELDS) {
      const declared = entry[field as keyof typeof entry] ?? null;
      const result = resolveFieldWithSource(entry as unknown as Record<string, unknown>, field, ctx);
      output[field] = {
        declared: declared ?? null,
        resolved: result.value,
        source: result.source,
      };
    }
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Default: YAML frontmatter export (existing behavior)
  const fm: Record<string, unknown> = {};
  if (entry.name) fm.name = entry.name;
  if (entry.description) fm.description = entry.description;
  if (entry.model) fm.model = entry.model;
  if (entry.color) fm.color = entry.color;
  if (entry.promptMode) fm.promptMode = entry.promptMode;
  if (entry.provider) fm.provider = entry.provider;
  if (entry.sdk && Object.keys(entry.sdk).length > 0) {
    const { serializeSdkConfig } = await import('../lib/frontmatter-writer.js');
    fm.sdk = serializeSdkConfig(entry.sdk);
  }

  const yamlLib = await import('js-yaml');
  const yamlStr = yamlLib.dump(fm, {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
  });

  console.log(`---\n${yamlStr}---`);
}

/** Build a ResolveContext for dir commands (reads workspace.json). */
function buildDirResolveContext(agentName: string): ResolveContext {
  const ctx: ResolveContext = {};
  try {
    const ws = findWorkspace();
    if (ws) {
      const wsConfig = getWorkspaceConfig(ws.root);
      ctx.workspaceDefaults = wsConfig.agents?.defaults as ResolveContext['workspaceDefaults'];

      // Detect parent for sub-agents
      if (agentName.includes('/')) {
        const parentName = agentName.split('/')[0];
        const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs');
        const { join } = require('node:path') as typeof import('node:path');
        const parentAgentsMd = join(ws.root, 'agents', parentName, 'AGENTS.md');
        if (existsSync(parentAgentsMd)) {
          const parentFm = parseFrontmatter(readFileSync(parentAgentsMd, 'utf-8'));
          ctx.parent = { name: parentName, fields: parentFm as Record<string, unknown> };
        }
      }
    }
  } catch {
    // Best-effort
  }
  return ctx;
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
  if (entry.permissions?.preset) console.log(`  Permissions: preset=${entry.permissions.preset}`);
  else if (entry.permissions?.allow) {
    console.log(`  Permissions: allow=${entry.permissions.allow.join(',')}`);
    if (entry.permissions.bashAllowPatterns?.length) {
      console.log(`  Bash Allow: ${entry.permissions.bashAllowPatterns.join(', ')}`);
    }
  }
  if (entry.sdk) {
    printSdkConfig(entry.sdk);
  }
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
    printResolvedTable(entries);
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
  const { writeSync } = require('node:fs') as typeof import('node:fs');
  const data = `${JSON.stringify(result, null, 2)}\n`;
  const CHUNK = 4096;
  for (let i = 0; i < data.length; i += CHUNK) {
    writeSync(1, data.slice(i, i + CHUNK));
  }
}

// ============================================================================
// SDK CLI Options
// ============================================================================

/** Options shape produced by the --sdk-* CLI flags. */
interface SdkDirOptions {
  sdkPermissionMode?: string;
  sdkTools?: string;
  sdkAllowedTools?: string;
  sdkDisallowedTools?: string;
  sdkMaxTurns?: string;
  sdkMaxBudget?: string;
  sdkEffort?: string;
  sdkThinking?: string;
  sdkPersistSession?: boolean;
  sdkFileCheckpointing?: boolean;
  sdkOutputFormat?: string;
  sdkStreamPartial?: boolean;
  sdkHookEvents?: boolean;
  sdkPromptSuggestions?: boolean;
  sdkProgressSummaries?: boolean;
  sdkSandbox?: boolean;
  sdkBetas?: string;
  sdkSystemPrompt?: string;
  sdkMcpServer?: string[];
  sdkPlugin?: string[];
  sdkAgent?: string;
  sdkSubagent?: string[];
}

/** Register all --sdk-* option flags on a Commander command. */
function registerSdkFlags(cmd: Command): void {
  cmd
    .option(
      '--sdk-permission-mode <mode>',
      'SDK permission mode: default|acceptEdits|bypassPermissions|plan|dontAsk|auto',
    )
    .option('--sdk-tools <list>', 'SDK tools: comma-separated tool names')
    .option('--sdk-allowed-tools <list>', 'SDK auto-approved tools: comma-separated')
    .option('--sdk-disallowed-tools <list>', 'SDK blacklisted tools: comma-separated')
    .option('--sdk-max-turns <n>', 'SDK max conversation turns')
    .option('--sdk-max-budget <usd>', 'SDK max budget in USD')
    .option('--sdk-effort <level>', 'SDK effort: low|medium|high|max')
    .option('--sdk-thinking <config>', 'SDK thinking: adaptive|disabled|enabled[:budgetTokens]')
    .option('--sdk-persist-session', 'SDK: enable session persistence')
    .option('--no-sdk-persist-session', 'SDK: disable session persistence')
    .option('--sdk-file-checkpointing', 'SDK: enable file checkpointing')
    .option('--sdk-output-format <path>', 'SDK: path to JSON schema file for output format')
    .option('--sdk-stream-partial', 'SDK: include partial messages in stream')
    .option('--sdk-hook-events', 'SDK: include hook events in stream')
    .option('--sdk-prompt-suggestions', 'SDK: enable prompt suggestions')
    .option('--sdk-progress-summaries', 'SDK: enable agent progress summaries')
    .option('--sdk-sandbox', 'SDK: enable sandbox')
    .option('--sdk-betas <list>', 'SDK beta flags: comma-separated')
    .option('--sdk-system-prompt <string>', 'SDK system prompt text')
    .option('--sdk-mcp-server <spec>', 'SDK MCP server: name:command:args (repeatable)', collectRepeat, [])
    .option('--sdk-plugin <path>', 'SDK plugin path (repeatable)', collectRepeat, [])
    .option('--sdk-agent <name>', 'SDK main agent name')
    .option('--sdk-subagent <spec>', 'SDK subagent: name:json (repeatable)', collectRepeat, []);
}

/** Commander repeatable option collector. */
function collectRepeat(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/**
 * Parse all --sdk-* CLI options into an SdkDirectoryConfig object.
 * Returns undefined if no SDK flags were provided.
 */
export function buildSdkConfig(options: SdkDirOptions): SdkDirectoryConfig | undefined {
  const config: SdkDirectoryConfig = {};

  applyScalarSdkOptions(config, options);
  applyBooleanSdkOptions(config, options);
  applyRepeatableSdkOptions(config, options);

  return Object.keys(config).length > 0 ? config : undefined;
}

/** Parse a string to a number, throwing if NaN. */
function toSafeNumber(value: string, flagName: string): number {
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`${flagName} must be a number, got: ${value}`);
  return n;
}

/** Apply scalar (string/number) SDK options to the config. */
function applyScalarSdkOptions(config: SdkDirectoryConfig, options: SdkDirOptions): void {
  if (options.sdkPermissionMode !== undefined) {
    config.permissionMode = options.sdkPermissionMode as SdkDirectoryConfig['permissionMode'];
  }
  if (options.sdkTools !== undefined) config.tools = splitComma(options.sdkTools);
  if (options.sdkAllowedTools !== undefined) config.allowedTools = splitComma(options.sdkAllowedTools);
  if (options.sdkDisallowedTools !== undefined) config.disallowedTools = splitComma(options.sdkDisallowedTools);
  if (options.sdkMaxTurns !== undefined) config.maxTurns = toSafeNumber(options.sdkMaxTurns, '--sdk-max-turns');
  if (options.sdkMaxBudget !== undefined) config.maxBudgetUsd = toSafeNumber(options.sdkMaxBudget, '--sdk-max-budget');
  if (options.sdkEffort !== undefined) config.effort = options.sdkEffort as SdkDirectoryConfig['effort'];
  if (options.sdkThinking !== undefined) config.thinking = parseThinkingConfig(options.sdkThinking);
  if (options.sdkBetas !== undefined) config.betas = splitComma(options.sdkBetas) as SdkBeta[];
  if (options.sdkSystemPrompt !== undefined) config.systemPrompt = options.sdkSystemPrompt;
  if (options.sdkAgent !== undefined) config.agent = options.sdkAgent;
  if (options.sdkOutputFormat !== undefined) {
    config.outputFormat = { type: 'json_schema', schema: { $ref: options.sdkOutputFormat } };
  }
}

/** Apply boolean SDK options to the config. */
function applyBooleanSdkOptions(config: SdkDirectoryConfig, options: SdkDirOptions): void {
  if (options.sdkPersistSession !== undefined) config.persistSession = options.sdkPersistSession;
  if (options.sdkFileCheckpointing === true) config.enableFileCheckpointing = true;
  if (options.sdkStreamPartial === true) config.includePartialMessages = true;
  if (options.sdkHookEvents === true) config.includeHookEvents = true;
  if (options.sdkPromptSuggestions === true) config.promptSuggestions = true;
  if (options.sdkProgressSummaries === true) config.agentProgressSummaries = true;
  if (options.sdkSandbox === true) config.sandbox = { enabled: true };
}

/** Apply repeatable (array-based) SDK options to the config. */
function applyRepeatableSdkOptions(config: SdkDirectoryConfig, options: SdkDirOptions): void {
  if (options.sdkMcpServer && options.sdkMcpServer.length > 0) {
    config.mcpServers = {};
    for (const spec of options.sdkMcpServer) {
      const parsed = parseMcpServer(spec);
      config.mcpServers[parsed.name] = parsed.config;
    }
  }
  if (options.sdkPlugin && options.sdkPlugin.length > 0) {
    config.plugins = options.sdkPlugin.map((p) => ({ type: 'local' as const, path: p }));
  }
  if (options.sdkSubagent && options.sdkSubagent.length > 0) {
    config.agents = parseSubagents(options.sdkSubagent);
  }
}

/** Parse subagent specs into an agents record. */
function parseSubagents(specs: string[]): Record<string, import('../lib/sdk-directory-types.js').SdkSubagentConfig> {
  const agents: Record<string, import('../lib/sdk-directory-types.js').SdkSubagentConfig> = {};
  for (const spec of specs) {
    const colonIdx = spec.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`Invalid --sdk-subagent format: "${spec}". Expected "name:json".`);
    }
    const agentName = spec.slice(0, colonIdx);
    const jsonStr = spec.slice(colonIdx + 1);
    try {
      agents[agentName] = JSON.parse(jsonStr);
    } catch {
      throw new Error(`Invalid JSON in --sdk-subagent "${agentName}": ${jsonStr}`);
    }
  }
  return agents;
}

/**
 * Parse a thinking config string into an SdkThinkingConfig object.
 * Formats: "adaptive", "disabled", "enabled", "enabled:4000"
 */
function parseThinkingConfig(value: string): SdkThinkingConfig {
  if (value === 'adaptive') return { type: 'adaptive' };
  if (value === 'disabled') return { type: 'disabled' };
  if (value === 'enabled') return { type: 'enabled' };
  if (value.startsWith('enabled:')) {
    const budget = toSafeNumber(value.slice('enabled:'.length), '--sdk-thinking budgetTokens');
    return { type: 'enabled', budgetTokens: budget };
  }
  throw new Error(`Invalid --sdk-thinking value: "${value}". Expected adaptive|disabled|enabled[:budgetTokens].`);
}

/**
 * Parse an MCP server spec string: "name:command:arg1,arg2"
 * Returns the server name and its stdio config.
 */
function parseMcpServer(spec: string): { name: string; config: { type: 'stdio'; command: string; args: string[] } } {
  const firstColon = spec.indexOf(':');
  if (firstColon === -1) {
    throw new Error(`Invalid --sdk-mcp-server format: "${spec}". Expected "name:command:args".`);
  }
  const name = spec.slice(0, firstColon);
  const rest = spec.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  if (secondColon === -1) {
    throw new Error(`Invalid --sdk-mcp-server format: "${spec}". Expected "name:command:args".`);
  }
  const command = rest.slice(0, secondColon);
  const argsStr = rest.slice(secondColon + 1);
  const args = argsStr
    ? argsStr
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return { name, config: { type: 'stdio', command, args } };
}

/** Split a comma-separated string into a trimmed, non-empty array. */
function splitComma(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Print SDK configuration for display. */
function printSdkConfig(sdk: SdkDirectoryConfig): void {
  console.log('  SDK Config:');
  const lines = collectSdkDisplayLines(sdk);
  for (const line of lines) {
    console.log(`    ${line}`);
  }
}

/** Collect display lines for scalar/boolean SDK config fields. */
function collectSdkDisplayLines(sdk: SdkDirectoryConfig): string[] {
  const lines: string[] = [];
  if (sdk.permissionMode) lines.push(`Permission Mode: ${sdk.permissionMode}`);
  if (sdk.tools) {
    lines.push(`Tools: ${Array.isArray(sdk.tools) ? sdk.tools.join(', ') : `preset:${sdk.tools.preset}`}`);
  }
  if (sdk.allowedTools?.length) lines.push(`Allowed Tools: ${sdk.allowedTools.join(', ')}`);
  if (sdk.disallowedTools?.length) lines.push(`Disallowed Tools: ${sdk.disallowedTools.join(', ')}`);
  if (sdk.maxTurns !== undefined) lines.push(`Max Turns: ${sdk.maxTurns}`);
  if (sdk.maxBudgetUsd !== undefined) lines.push(`Max Budget: $${sdk.maxBudgetUsd.toFixed(2)}`);
  if (sdk.effort) lines.push(`Effort: ${sdk.effort}`);
  if (sdk.thinking) lines.push(`Thinking: ${formatThinking(sdk.thinking)}`);
  if (sdk.agent) lines.push(`Agent: ${sdk.agent}`);
  if (sdk.persistSession !== undefined) lines.push(`Persist Session: ${sdk.persistSession}`);
  if (sdk.enableFileCheckpointing) lines.push('File Checkpointing: enabled');
  if (sdk.outputFormat) lines.push(`Output Format: ${JSON.stringify(sdk.outputFormat.schema)}`);
  collectSdkBooleanLines(sdk, lines);
  collectSdkComplexLines(sdk, lines);
  return lines;
}

/** Collect display lines for boolean SDK feature flags. */
function collectSdkBooleanLines(sdk: SdkDirectoryConfig, lines: string[]): void {
  if (sdk.includePartialMessages) lines.push('Stream Partial: enabled');
  if (sdk.includeHookEvents) lines.push('Hook Events: enabled');
  if (sdk.promptSuggestions) lines.push('Prompt Suggestions: enabled');
  if (sdk.agentProgressSummaries) lines.push('Progress Summaries: enabled');
  if (sdk.sandbox?.enabled) lines.push('Sandbox: enabled');
  if (sdk.betas?.length) lines.push(`Betas: ${sdk.betas.join(', ')}`);
}

/** Collect display lines for complex SDK config fields (prompts, servers, plugins). */
function collectSdkComplexLines(sdk: SdkDirectoryConfig, lines: string[]): void {
  if (sdk.systemPrompt) {
    const prompt = typeof sdk.systemPrompt === 'string' ? sdk.systemPrompt : `preset:${sdk.systemPrompt.preset}`;
    lines.push(`System Prompt: ${prompt.length > 60 ? `${prompt.slice(0, 60)}...` : prompt}`);
  }
  if (sdk.mcpServers) lines.push(`MCP Servers: ${Object.keys(sdk.mcpServers).join(', ')}`);
  if (sdk.plugins?.length) lines.push(`Plugins: ${sdk.plugins.map((p) => p.path).join(', ')}`);
  if (sdk.agents) lines.push(`Subagents: ${Object.keys(sdk.agents).join(', ')}`);
}

/** Format a thinking config for display. */
function formatThinking(thinking: SdkThinkingConfig): string {
  if (thinking.type === 'enabled' && thinking.budgetTokens) return `enabled:${thinking.budgetTokens}`;
  return thinking.type;
}

// ============================================================================
// Permissions & Roles
// ============================================================================

/** Build permissions config from CLI flags. Returns undefined if no flags set. */
function buildPermissions(
  permissionPreset?: string,
  allow?: string,
  bashAllow?: string,
): directory.DirectoryEntry['permissions'] | undefined {
  if (!permissionPreset && !allow && !bashAllow) return undefined;
  if (permissionPreset) return { preset: permissionPreset };
  return {
    ...(allow && {
      allow: allow
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }),
    ...(bashAllow && {
      bashAllowPatterns: bashAllow
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    }),
  };
}

/** Normalize roles: split comma-separated values into individual array items. */
function normalizeRoles(roles?: string[]): string[] | undefined {
  if (!roles) return undefined;
  return roles
    .flatMap((r) => r.split(','))
    .map((r) => r.trim())
    .filter(Boolean);
}

// ============================================================================
// Table Printing
// ============================================================================

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

function printResolvedTable(entries: directory.ScopedDirectoryEntry[]): void {
  if (entries.length === 0) return;

  const nameW = 22;
  const declW = 14;
  const resolvedW = 14;

  console.log('RESOLVED DEFAULTS');
  console.log('-'.repeat(70));

  // Print header per resolved field
  for (const field of RESOLVED_FIELDS) {
    const fieldUpper = field.toUpperCase();
    console.log(
      `  ${'AGENT'.padEnd(nameW)}${`${fieldUpper} (declared)`.padEnd(declW)}${`${fieldUpper} (resolved)`.padEnd(resolvedW)}SOURCE`,
    );
    console.log(
      `  ${'-'.repeat(nameW - 2)}  ${'-'.repeat(declW - 2)}  ${'-'.repeat(resolvedW - 2)}  ${'-'.repeat(16)}`,
    );

    for (const entry of entries) {
      const ctx = buildDirResolveContext(entry.name);
      const result = resolveFieldWithSource(entry as unknown as Record<string, unknown>, field, ctx);
      const declared = (entry[field as keyof typeof entry] as string) || '-';
      console.log(
        `  ${entry.name.padEnd(nameW)}${declared.padEnd(declW)}${result.value.padEnd(resolvedW)}${result.source}`,
      );
    }
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
