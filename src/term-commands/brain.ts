/**
 * genie brain — delegate to @automagik/genie-brain (enterprise).
 *
 * Brain installs directly from the private GitHub repo.
 * Only people with repo access can install = enterprise license.
 * Source code stays in git, never published to npm.
 *
 * Brain is NEVER a hard dependency. genie works exactly the same
 * without it. Zero behavior change for OSS users.
 */

import { execSync } from 'node:child_process';
import type { Command } from 'commander';

const BRAIN_PKG = '@automagik/genie-brain';
const BRAIN_REPO = 'github:automagik-dev/genie-brain';

/** Install brain package directly from GitHub repo */
async function installBrain(): Promise<boolean> {
  console.log('');
  console.log('  Installing genie-brain from GitHub (enterprise)...');
  console.log('');
  console.log('  Source: https://github.com/automagik-dev/genie-brain');
  console.log('  Requires: GitHub org membership (automagik-dev)');
  console.log('');

  try {
    // Install directly from GitHub — bun resolves git repos natively
    // Only people with repo access (SSH key or GH token) can install
    execSync(`bun add ${BRAIN_REPO}`, {
      stdio: 'inherit',
    });

    console.log('');
    console.log('  ✓ Brain installed from GitHub.');
    console.log('');

    // Auto-run migrations
    try {
      const brain = await import(BRAIN_PKG);
      if (brain.runAllMigrations) {
        console.log('  Running brain migrations...');
        await brain.runAllMigrations();
        console.log('  ✓ Brain tables created in Postgres.');
      }
    } catch {
      console.log('  ⚠ Auto-migration skipped. Run: genie brain migrate');
    }

    console.log('');
    console.log('  Get started:');
    console.log('    genie brain init --name my-brain --path ./brain');
    console.log('');
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('Authentication') || msg.includes('permission') || msg.includes('404')) {
      console.error('  ✗ Access denied. Brain is enterprise-only.');
      console.log('');
      console.log('  You need:');
      console.log('    1. Membership in the automagik-dev GitHub org');
      console.log('    2. SSH key or GH token configured for git');
      console.log('');
      console.log('  Manual install:');
      console.log(`    bun add ${BRAIN_REPO}`);
      console.log('');
    } else {
      console.error(`  ✗ Install failed: ${msg}`);
      console.log('');
      console.log('  Manual install:');
      console.log(`    bun add ${BRAIN_REPO}`);
      console.log('');
    }
    return false;
  }
}

function uninstallBrain(): void {
  try {
    execSync(`bun remove ${BRAIN_PKG}`, { stdio: 'inherit' });
    console.log('  ✓ Brain uninstalled.');
  } catch {
    console.error('  Uninstall failed. Manual: bun remove @automagik/genie-brain');
  }
}

function isModuleNotFound(msg: string): boolean {
  return msg.includes('Cannot find') || msg.includes('not found') || msg.includes('MODULE_NOT_FOUND');
}

function printNotInstalledMessage(): void {
  console.log('');
  console.log('  Brain is an enterprise knowledge graph engine.');
  console.log('  It is not installed.');
  console.log('');
  console.log('  Quick install:');
  console.log('');
  console.log('    genie brain install');
  console.log('');
  console.log('  Requires GitHub org membership (automagik-dev).');
  console.log('');
}

async function executeBrainCommand(args: string[]): Promise<void> {
  try {
    const brain = await import(BRAIN_PKG);
    if (brain.execute) {
      await brain.execute(args);
    } else {
      console.error('Brain module loaded but execute() not found.');
      console.error('Update: genie brain install');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isModuleNotFound(msg)) {
      printNotInstalledMessage();
    } else {
      console.error(`Brain error: ${msg}`);
    }
  }
}

export function registerBrainCommands(program: Command): void {
  program
    .command('brain')
    .description('Knowledge graph engine (enterprise)')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_options: Record<string, unknown>, cmd: Command) => {
      const args = cmd.args;

      if (args[0] === 'install') {
        await installBrain();
        return;
      }
      if (args[0] === 'uninstall') {
        uninstallBrain();
        return;
      }
      await executeBrainCommand(args);
    });
}
