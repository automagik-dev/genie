/**
 * genie init — workspace creation + agent scaffolding.
 *
 * Commands:
 *   genie init              — Create .genie/workspace.json at cwd
 *   genie init agent <name> — Scaffold an agent directory
 */

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import type { Command } from 'commander';
import { type WorkspaceConfig, findWorkspace, scanAgents } from '../lib/workspace.js';
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

function scaffoldAgentInWorkspace(workspaceRoot: string, name: string): void {
  const agentDir = join(workspaceRoot, 'agents', name);
  if (existsSync(agentDir)) {
    throw new Error(`Agent directory already exists: ${agentDir}`);
  }

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, 'brain', 'memory'), { recursive: true });
  mkdirSync(join(agentDir, '.claude'), { recursive: true });

  scaffoldAgentFiles(agentDir, name);
  writeFileSync(join(agentDir, '.claude', 'settings.local.json'), `${JSON.stringify({ agentName: name }, null, 2)}\n`);

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
  console.log('  brain/memory/');
  console.log('  .claude/settings.local.json');
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
    tmuxSocket: 'genie',
  };

  writeFileSync(join(genieDir, 'workspace.json'), `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Workspace created: ${cwd}`);
  if (pgUrl) console.log(`  pgUrl: ${pgUrl}`);

  await maybeBootstrapDefaultAgent(cwd);
  await syncWorkspaceAgents(cwd);
}

/** genie init agent <name> — scaffold agent directory */
async function initAgent(name: string): Promise<void> {
  const cwd = process.cwd();
  const ws = findWorkspace(cwd);
  if (!ws) {
    console.error('Error: Not in a genie workspace. Run `genie init` first.');
    process.exit(1);
  }

  try {
    scaffoldAgentInWorkspace(ws.root, name);
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
    .action(async (name: string) => {
      await ensureSetupCompleteForInit();
      await initAgent(name);
    });
}
