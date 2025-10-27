import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import gradient from 'gradient-string';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { emitView } from '../lib/view-helpers';
import { buildErrorView, buildInfoView } from '../views/common';
import { getPackageVersion } from '../lib/package';
import { checkForUpdates } from '../lib/upgrade';
import { isForgeRunning } from '../lib/forge-manager';

const execAsync = promisify(exec);

// Genie-themed gradients
const successGradient = gradient(['#00ff88', '#00ccff', '#0099ff']);
const performanceGradient = gradient(['#ffd700', '#ff8c00', '#ff6347']);

interface UpdateFlags {
  force?: boolean;
}

/**
 * Update command - updates the global npm package
 *
 * NO workspace changes, NO backups - just updates the global package.
 * Workspace upgrade happens automatically when you run `genie` or `genie init` after update.
 */
export async function runUpdate(
  parsed: ParsedCommand,
  _config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  try {
    const flags = parseFlags(parsed.commandArgs);
    const currentVersion = getPackageVersion();

    // MASTER GENIE DETECTION: Check if we're in the template repo
    const workspacePackageJson = path.join(process.cwd(), 'package.json');
    let isMasterGenie = false;

    if (fs.existsSync(workspacePackageJson)) {
      try {
        const workspacePkg = JSON.parse(fs.readFileSync(workspacePackageJson, 'utf8'));
        if (workspacePkg.name === 'automagik-genie') {
          isMasterGenie = true;
        }
      } catch {
        // Not master genie if can't read package.json
      }
    }

    // If master genie, check npm for latest published version (not local package.json)
    if (isMasterGenie) {
      // Detect package manager (prefer pnpm, fallback to npm)
      let packageManager = 'npm';
      try {
        await execAsync('pnpm --version');
        packageManager = 'pnpm';
      } catch {
        // pnpm not available, use npm
      }

      // Check npm registry for latest published version
      console.log('📦 Checking npm for updates...');
      console.log('');

      const updateCheck = await checkForUpdates(currentVersion, 'unknown');

      // Get currently installed global version
      let globalVersion: string;
      try {
        const { stdout } = await execAsync(`${packageManager} list -g automagik-genie --depth=0 --json`);
        const globalData = JSON.parse(stdout);
        // pnpm returns an array, npm returns an object
        if (Array.isArray(globalData)) {
          globalVersion = globalData[0]?.dependencies?.['automagik-genie']?.version || '';
        } else {
          globalVersion = globalData.dependencies?.['automagik-genie']?.version || '';
        }

        // Handle file:/link: protocols (when installed from local directory)
        if (globalVersion.startsWith('file:') || globalVersion.startsWith('link:')) {
          try {
            const filePath = globalVersion.replace(/^(file:|link:)/, '');
            const globalPackageJson = path.join(filePath, 'package.json');
            if (fs.existsSync(globalPackageJson)) {
              const globalPkg = JSON.parse(fs.readFileSync(globalPackageJson, 'utf8'));
              globalVersion = globalPkg.version || '';
            }
          } catch {
            globalVersion = '';
          }
        }
      } catch {
        globalVersion = '';
      }

      // If global already matches latest npm version, nothing to do
      if (globalVersion === updateCheck.latestVersion) {
        console.log(successGradient('━'.repeat(60)));
        console.log(successGradient('   🧞 ✨ MASTER GENIE - ALREADY UP TO DATE ✨ 🧞   '));
        console.log(successGradient('━'.repeat(60)));
        console.log('');
        console.log('Your global Genie matches npm latest: ' + successGradient(updateCheck.latestVersion));
        console.log('');
        console.log('✨ Nothing to update!');
        console.log('');
        return;
      }

      // Update available from npm - install latest from registry
      console.log(successGradient('━'.repeat(60)));
      console.log(successGradient('   🧞 ✨ MASTER GENIE UPDATE ✨ 🧞   '));
      console.log(successGradient('━'.repeat(60)));
      console.log('');
      console.log(`Updating global Genie: ${performanceGradient(globalVersion || '(not installed)')} → ${successGradient(updateCheck.latestVersion)}`);
      console.log('');
      console.log(`Installing from npm (using ${packageManager})...`);
      console.log('');

      try {
        await execAsync(`${packageManager} install -g automagik-genie@next`, { cwd: process.cwd() });
        console.log('');
        console.log(successGradient('✅ Successfully updated global Genie from npm!'));
        console.log('');
        console.log('Your global Genie is now: ' + successGradient(updateCheck.latestVersion));
        console.log('');
        return;
      } catch (error: any) {
        throw new Error(
          `Failed to install from npm: ${error.message}\n\n` +
          `Please try manually: ${packageManager} install -g automagik-genie@next`
        );
      }
    }

    // NOT master genie - proceed with npm update flow
    // Check for updates
    console.log('📦 Checking for updates...');
    console.log('');

    const updateCheck = await checkForUpdates(currentVersion, 'unknown');

    if (!updateCheck.available) {
      await emitView(
        buildInfoView(
          'Already up to date',
          [
            `Current version: ${currentVersion}`,
            `Latest version: ${updateCheck.latestVersion}`,
            '✅ No updates available'
          ]
        ),
        parsed.options
      );
      return;
    }

    // Show update info
    await emitView(
      buildInfoView(
        'Update available',
        [
          `Current: ${currentVersion}`,
          `Available: ${updateCheck.latestVersion}`,
          '',
          'Changes:',
          ...updateCheck.changes.map(c => `  ${c}`)
        ]
      ),
      parsed.options
    );
    console.log('');

    // Prompt for confirmation (unless --force)
    if (!flags.force) {
      const { default: prompts } = await import('prompts');
      const response = await prompts({
        type: 'confirm',
        name: 'proceed',
        message: 'Update global Genie package?',
        initial: true
      });

      if (!response.proceed) {
        console.log('Update cancelled.');
        return;
      }
    }

    console.log('');
    console.log('📦 Updating global package...');
    console.log('');

    // Detect package manager (prefer pnpm, fallback to npm)
    let packageManager = 'npm';
    try {
      await execAsync('pnpm --version');
      packageManager = 'pnpm';
    } catch {
      // pnpm not available, use npm
    }

    // Update global package
    const updateCommand = `${packageManager} install -g automagik-genie@latest`;
    console.log(`   Running: ${updateCommand}`);
    console.log('');

    try {
      const { stdout, stderr } = await execAsync(updateCommand);
      if (stdout) console.log(stdout);
      if (stderr && !stderr.includes('npm WARN')) console.error(stderr);
    } catch (error: any) {
      throw new Error(
        `Failed to update package: ${error.message}\n\n` +
        `Please try manually: ${updateCommand}`
      );
    }

    console.log('');
    console.log(`✅ I've evolved to ${updateCheck.latestVersion}!`);
    console.log('');

    // Check if Forge is already running
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const forgeRunning = await isForgeRunning(baseUrl);

    if (forgeRunning) {
      // Forge is running - your clone needs to learn the new powers
      await emitView(
        buildInfoView(
          'Master Genie Updated',
          [
            '✨ I (the Master) have learned new powers!',
            '',
            '💡 Your clone is still running the old me...',
            '   Run `genie` again to teach your clone these new powers',
            '   (I\'ll sync all my latest knowledge to your workspace)',
            '',
            '🔮 Your clone will inherit everything I just learned!'
          ]
        ),
        parsed.options
      );
    } else {
      // Forge not running - offer to summon the clone now
      console.log('💡 Next time you summon me, I\'ll teach your clone everything new!');
      console.log('');

      // Prompt to start genie now (unless --force which skips all prompts)
      if (!flags.force) {
        const { default: prompts } = await import('prompts');
        const response = await prompts({
          type: 'confirm',
          name: 'startNow',
          message: 'Summon your Genie clone now to learn these powers?',
          initial: true
        });

        if (response.startNow) {
          console.log('');
          console.log('🔮 Preparing to summon your clone...');
          console.log('');
          await emitView(
            buildInfoView(
              'Ready to Summon',
              [
                'Run `genie` to summon your clone',
                '(I\'ll automatically teach it everything I just learned!)'
              ]
            ),
            parsed.options
          );
        } else {
          await emitView(
            buildInfoView(
              'Master Genie Updated',
              [
                '✨ I\'m ready when you are!',
                '   Run `genie` anytime to teach your clone these new powers'
              ]
            ),
            parsed.options
          );
        }
      } else {
        await emitView(
          buildInfoView(
            'Master Genie Updated',
            [
              '✨ Run `genie` to teach your clone these new powers!'
            ]
          ),
          parsed.options
        );
      }
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await emitView(
      buildErrorView('Update failed', message),
      parsed.options,
      { stream: process.stderr }
    );
    process.exitCode = 1;
  }
}

function parseFlags(args: string[]): UpdateFlags {
  const flags: UpdateFlags = {};

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === '--force' || token === '-f') {
      flags.force = true;
    }
  }

  return flags;
}
