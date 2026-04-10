/**
 * genie init — workspace creation + agent scaffolding.
 *
 * Commands:
 *   genie init              — Create .genie/workspace.json at cwd
 *   genie init agent <name> — Scaffold an agent directory
 */

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { confirm } from '@inquirer/prompts';
import type { Command } from 'commander';
import { discoverExternalAgents, importAgents } from '../lib/discovery.js';
import { isInteractive } from '../lib/interactivity.js';
import { type WizardContext, runMiniWizard } from '../lib/mini-wizard.js';
import { type PendingAgent, listPending, refreshPending, removePending } from '../lib/pending-agents.js';
import { GENIEIGNORE_DEFAULTS } from '../lib/tree-scanner.js';
import { type WorkspaceConfig, findWorkspace, getWorkspaceConfig, scanAgents } from '../lib/workspace.js';
import { scaffoldAgentFiles } from '../templates/index.js';

/** Auto-detect pgUrl from environment or running pgserve. */
function detectPgUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.PG_URL) return process.env.PG_URL;
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync('pgrep -af pgserve 2>/dev/null', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const match = out.match(/postgres(?:ql)?:\/\/[^\s]+/);
    if (match) return match[0];
  } catch {
    // pgserve not running
  }
  return undefined;
}

/** Ensure global genie setup has completed before running init flows. */
async function ensureSetupCompleteForInit(): Promise<void> {
  const { isSetupComplete } = await import('../lib/genie-config.js');
  if (isSetupComplete()) return;

  console.log('Genie setup not complete. Running `genie setup` before continuing...');
  const { setupCommand } = await import('../genie-commands/setup.js');
  await setupCommand();
}

export function scaffoldAgentInWorkspace(workspaceRoot: string, name: string, agentsDir?: string): void {
  const baseDir = agentsDir ?? join(workspaceRoot, 'agents');
  const agentDir = join(baseDir, name);
  if (existsSync(agentDir)) {
    throw new Error(`Agent directory already exists: ${agentDir}`);
  }

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, 'brain', 'memory'), { recursive: true });
  mkdirSync(join(agentDir, '.claude'), { recursive: true });

  // Read workspace defaults so scaffold renders effective values in comments
  let workspaceDefaults: Record<string, string> | undefined;
  try {
    const wsConfig = getWorkspaceConfig(workspaceRoot);
    workspaceDefaults = wsConfig.agents?.defaults as Record<string, string> | undefined;
  } catch {
    // workspace.json may not exist yet during initial init — fall through to built-in defaults
  }

  scaffoldAgentFiles(agentDir, name, workspaceDefaults);

  const settings = {
    agentName: name,
    autoMemoryEnabled: true,
    autoMemoryDirectory: './brain/memory',
  };
  writeFileSync(join(agentDir, '.claude', 'settings.local.json'), `${JSON.stringify(settings, null, 2)}\n`);

  writeFileSync(
    join(agentDir, 'brain', 'memory', 'MEMORY.md'),
    '# Memory Index\n\n_This file is maintained by the auto-memory system. New memories are added automatically._\n',
  );

  const reposTarget = join(workspaceRoot, 'repos');
  if (existsSync(reposTarget)) {
    try {
      symlinkSync(reposTarget, join(agentDir, 'repos'));
    } catch {
      // symlink may fail on some filesystems
    }
  }

  console.log(`Agent scaffolded: agents/${name}/`);
  console.log('  AGENTS.md, SOUL.md, HEARTBEAT.md');
  console.log('  brain/memory/MEMORY.md (seeded)');
  console.log('  .claude/settings.local.json (auto-memory enabled)');
  if (existsSync(join(agentDir, 'repos'))) {
    console.log('  repos -> ../repos (symlink)');
  }
}

async function maybeBootstrapDefaultAgent(workspaceRoot: string): Promise<boolean> {
  if (scanAgents(workspaceRoot).length > 0) return false;

  const shouldScaffold = await confirm({
    message: 'No agent found in this workspace. Scaffold the default `genie` agent now?',
    default: true,
  });

  if (!shouldScaffold) {
    console.log('  Skipped default agent bootstrap. Run `genie init agent genie` later.');
    return false;
  }

  scaffoldAgentInWorkspace(workspaceRoot, 'genie');
  return true;
}

async function syncWorkspaceAgents(workspaceRoot: string): Promise<void> {
  const agents = scanAgents(workspaceRoot);
  if (agents.length === 0) return;

  console.log(`  Found ${agents.length} agent(s): ${agents.join(', ')}`);
  try {
    const { syncAgentDirectory } = await import('../lib/agent-sync.js');
    const result = await syncAgentDirectory(workspaceRoot);
    if (result.registered.length > 0) {
      console.log(`  Registered: ${result.registered.join(', ')}`);
    }
    if (result.updated.length > 0) {
      console.log(`  Updated: ${result.updated.join(', ')}`);
    }
  } catch {
    // Sync is best-effort during init — DB may not be ready
  }
}

/** genie init — create workspace */
async function initWorkspace(): Promise<void> {
  const cwd = process.cwd();

  // Check if already inside a workspace
  const existing = findWorkspace(cwd);
  if (existing) {
    console.log(`Already inside workspace: ${existing.root}`);
    const bootstrapped = await maybeBootstrapDefaultAgent(existing.root);
    if (bootstrapped) {
      await syncWorkspaceAgents(existing.root);
    }
    return;
  }

  // Create .genie/ and workspace.json
  const genieDir = join(cwd, '.genie');
  mkdirSync(genieDir, { recursive: true });

  const pgUrl = detectPgUrl();
  const config: WorkspaceConfig = {
    name: basename(cwd),
    pgUrl,
    agents: { defaults: {} },
    tmux: { socket: 'genie' },
    sdk: {},
  };

  writeFileSync(join(genieDir, 'workspace.json'), `${JSON.stringify(config, null, 2)}\n`);

  // Create .genieignore with comprehensive defaults if it doesn't already exist
  const genieignorePath = join(cwd, '.genieignore');
  if (!existsSync(genieignorePath)) {
    writeFileSync(genieignorePath, GENIEIGNORE_DEFAULTS, 'utf-8');
    console.log('  Created .genieignore');
  }

  console.log(`Workspace created: ${cwd}`);
  if (pgUrl) console.log(`  pgUrl: ${pgUrl}`);

  await maybeBootstrapDefaultAgent(cwd);
  await syncWorkspaceAgents(cwd);
  await runPostInitFlow(cwd, config);
}

/**
 * Post-init flow: discovery scan → pending queue → mini-wizard.
 *
 * Only runs in interactive mode. In CI/piped mode, the workspace is created
 * silently without prompts.
 */
async function runPostInitFlow(workspaceRoot: string, config: WorkspaceConfig): Promise<void> {
  if (!isInteractive()) return;

  // 1. Discovery: scan for external agents
  const discovered = await discoverExternalAgents(workspaceRoot);

  // 2. Pending queue: refresh from discovery results
  refreshPending(workspaceRoot, discovered);
  const pending = listPending(workspaceRoot);

  // 3. Mini-wizard: show defaults, offer customization, handle imports
  const ctx: WizardContext = {
    workspaceRoot,
    workspaceName: basename(workspaceRoot),
    config,
    discovered,
    pending,
    canonicalAgentCount: scanAgents(workspaceRoot).length,
  };

  const result = await runMiniWizard(ctx);

  // 4. Import agents the user accepted
  if (result.importedAgents.length > 0) {
    const toImport = pending.filter((p: PendingAgent) => result.importedAgents.includes(p.name));
    const discoveredToImport = toImport.map((p: PendingAgent) => ({
      name: p.name,
      path: p.path,
      relativePath: p.relativePath,
      isSubAgent: p.isSubAgent,
      parentName: p.parentName,
    }));

    const importResult = importAgents(workspaceRoot, discoveredToImport);

    for (const name of importResult.imported) {
      const agent = toImport.find((a: PendingAgent) => a.name === name);
      if (agent) removePending(workspaceRoot, agent.path);
      console.log(`  Imported: ${name}`);
    }
    for (const err of importResult.errors) {
      console.error(`  Import failed (${err.name}): ${err.error}`);
    }

    // Re-sync after imports
    await syncWorkspaceAgents(workspaceRoot);
  }
}

/**
 * Resolve the agents parent directory based on --dir option and CWD.
 *
 * Priority:
 *   1. Explicit `--dir` option (resolved absolutely — use with care).
 *   2. CWD is inside the workspace and contains an `agents` path segment:
 *      return the path up to and including the first `agents` segment.
 *      This prevents nesting inside an existing agent subdirectory
 *      (e.g. CWD `<ws>/agents/foo` still scaffolds into `<ws>/agents`,
 *      not `<ws>/agents/foo/<new>`).
 *   3. Fall back to `<wsRoot>/agents`.
 *
 * Uses `path.sep` for Windows compatibility and exact segment matching
 * (not substring) so paths like `/tmp/agents-backup` or `.../agentship`
 * never false-match the `agents` segment.
 */
function resolveAgentsDir(wsRoot: string, dirOption?: string): string {
  if (dirOption) return resolve(dirOption);

  const cwd = process.cwd();
  const rel = relative(wsRoot, cwd);

  // CWD outside the workspace (relative path escapes with '..') — fall back.
  if (rel.startsWith('..')) return join(wsRoot, 'agents');

  // Walk workspace-relative segments and find the first exact `agents` match.
  const segments = rel === '' ? [] : rel.split(sep);
  const idx = segments.indexOf('agents');
  if (idx === -1) return join(wsRoot, 'agents');

  return join(wsRoot, ...segments.slice(0, idx + 1));
}

/** genie init agent <name> — scaffold agent directory */
async function initAgent(name: string, options: { dir?: string }): Promise<void> {
  // Guard against path traversal — name is CLI input and lands in join(baseDir, name)
  if (!name || /[\/\\]/.test(name) || name === '.' || name === '..' || name.includes('..')) {
    console.error('Error: Agent name must not contain path separators or traversal sequences.');
    process.exit(1);
  }

  const cwd = process.cwd();
  const ws = findWorkspace(cwd);
  if (!ws) {
    console.error('Error: Not in a genie workspace. Run `genie init` first.');
    process.exit(1);
  }

  const agentsDir = resolveAgentsDir(ws.root, options.dir);

  try {
    scaffoldAgentInWorkspace(ws.root, name, agentsDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

/** Register init commands on the program */
export function registerInitCommands(program: Command): void {
  const init = program
    .command('init')
    .description('Initialize a genie workspace')
    .action(async () => {
      await ensureSetupCompleteForInit();
      await initWorkspace();
    });

  init
    .command('agent <name>')
    .description('Scaffold a new agent in the workspace')
    .option('--dir <path>', 'Target directory for agent (default: CWD if inside agents/, else workspace agents/)')
    .action(async (name: string, options: { dir?: string }) => {
      await ensureSetupCompleteForInit();
      await initAgent(name, options);
    });
}
