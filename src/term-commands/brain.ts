/**
 * genie brain — delegate to @automagik/genie-brain (enterprise).
 *
 * This is the integration point. genie CLI dynamically imports brain
 * and passes all args through. If brain isn't installed, prints
 * install instructions and offers `genie brain install`.
 *
 * Brain is NEVER a hard dependency. genie works exactly the same
 * without it. Zero behavior change for OSS users.
 */

import { execSync } from 'node:child_process';
import type { Command } from 'commander';

const BRAIN_PKG = '@automagik/genie-brain';
const BRAIN_REGISTRY = 'https://npm.pkg.github.com';
const BRAIN_SCOPE = '@automagik';

/** Install brain package from GitHub Packages */
async function installBrain(): Promise<boolean> {
  console.log('');
  console.log('  Installing @automagik/genie-brain (enterprise)...');
  console.log('');

  try {
    // Configure npm scope for GitHub Packages (idempotent)
    execSync(`npm config set ${BRAIN_SCOPE}:registry ${BRAIN_REGISTRY}`, { stdio: 'inherit' });

    // Check if user has a GitHub token configured
    let hasToken = false;
    try {
      const rc = execSync(`npm config get //${BRAIN_REGISTRY.replace('https://', '')}/:_authToken`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      hasToken = rc.length > 0 && rc !== 'undefined';
    } catch {
      /* no token */
    }

    if (!hasToken) {
      console.log('  GitHub Packages requires authentication.');
      console.log('  Set your token:');
      console.log('');
      console.log(`    echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN" >> ~/.npmrc`);
      console.log('');
      console.log('  Generate a token at: https://github.com/settings/tokens');
      console.log('  Required scope: read:packages');
      console.log('');
      return false;
    }

    // Install the package
    execSync(`bun add ${BRAIN_PKG}`, { stdio: 'inherit' });

    console.log('');
    console.log('  ✓ Brain installed successfully.');
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
    console.error(`  ✗ Install failed: ${msg}`);
    console.log('');
    console.log('  Manual install:');
    console.log(`    npm config set ${BRAIN_SCOPE}:registry ${BRAIN_REGISTRY}`);
    console.log(`    bun add ${BRAIN_PKG}`);
    console.log('');
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
      console.error('Update: bun add @automagik/genie-brain@latest');
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
