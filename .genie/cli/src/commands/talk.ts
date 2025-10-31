/**
 * Talk Command - Interactive browser session with agent
 *
 * Creates a Forge task for the agent and opens it in browser.
 * Similar to 'genie run' but opens browser instead of waiting in terminal.
 */

import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { isForgeRunning, startForgeInBackground, waitForForgeReady } from '../lib/forge-manager';
import { resolveAgentIdentifier, loadAgentSpec } from '../lib/agent-resolver';
import { createForgeExecutor } from '../lib/forge-executor';
import { describeForgeError, FORGE_RECOVERY_HINT } from '../lib/forge-helpers';
import { normalizeExecutorKeyOrDefault } from '../lib/executor-registry';
import path from 'path';
import { execSync, spawn } from 'child_process';
import gradient from 'gradient-string';
import fs from 'fs';

// Genie-themed gradients
const genieGradient = gradient(['#0066ff', '#9933ff', '#ff00ff']);
const successGradient = gradient(['#00ff88', '#00ccff', '#0099ff']);

export async function runTalk(
  parsed: ParsedCommand,
  config: GenieConfig,
  paths: Required<ConfigPaths>
): Promise<void> {
  const [agentName, ...promptParts] = parsed.commandArgs;

  if (!agentName) {
    console.error('Usage: genie talk <agent> ["<prompt>"]');
    process.exit(1);
  }

  const prompt = promptParts.join(' ').trim() || `Start interactive session with ${agentName}`;
  const resolvedAgentName = resolveAgentIdentifier(agentName);
  const agentSpec = loadAgentSpec(resolvedAgentName);
  const agentGenie = agentSpec.meta?.genie || {};

  // Resolve executor configuration
  const executorKey = normalizeExecutorKeyOrDefault(
    agentGenie.executor || config.defaults?.executor
  );
  const executorVariant = (
    agentGenie.executorVariant ||
    agentGenie.variant ||
    config.defaults?.executorVariant ||
    'DEFAULT'
  ).trim().toUpperCase();
  const model = agentGenie.model || config.defaults?.model;

  const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
  const logDir = path.join(process.cwd(), '.genie', 'state');

  // Start Forge if not running
  const forgeRunning = await isForgeRunning(baseUrl);

  if (!forgeRunning) {
    console.log('');
    process.stderr.write('Starting Forge... ');
    const startTime = Date.now();

    const result = startForgeInBackground({ baseUrl, logDir });
    if (!result.ok) {
      const error = 'error' in result ? result.error : new Error('Unknown error');
      console.error('');
      console.error('❌ Failed to start Forge');
      console.error(`   ${error.message}`);
      console.error(`   Check logs at ${logDir}/forge.log`);
      process.exit(1);
    }

    const ready = await waitForForgeReady(baseUrl, 60000, 500, false);
    if (!ready) {
      console.error('');
      console.error('❌ Forge did not start in time (60s)');
      console.error(`   Check logs at ${logDir}/forge.log`);
      process.exit(1);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stderr.write(`ready (${elapsed}s)\n`);
  }

  // Create Forge session
  const forgeExecutor = createForgeExecutor();
  try {
    await forgeExecutor.syncProfiles(config.forge?.executors);
  } catch (error) {
    const reason = describeForgeError(error);
    console.warn(`⚠️  Failed to sync agent profiles to Forge: ${reason}`);
  }

  let sessionResult;
  try {
    sessionResult = await forgeExecutor.createSession({
      agentName: resolvedAgentName,
      prompt,
      executorKey,
      executorVariant,
      executionMode: 'interactive',
      model
    });
  } catch (error) {
    const reason = describeForgeError(error);
    console.error(`❌ Failed to create session: ${reason}`);
    console.error(`   ${FORGE_RECOVERY_HINT}`);
    process.exit(1);
  }

  const attemptId = sessionResult.attemptId; // Use Forge UUID (issue #407 fix)

  // Show success message
  console.log('');
  console.log(successGradient('━'.repeat(60)));
  console.log(successGradient(`✨ ${resolvedAgentName} session ready! ✨`));
  console.log(successGradient('━'.repeat(60)));
  console.log('');
  console.log(`📊 Session ID: ${attemptId}`);
  console.log(`📊 Opening task in browser...`);
  console.log('');

  // Open browser to task URL using Forge's cross-platform logic
  openBrowserCrossPlatform(sessionResult.forgeUrl);

  // Exit cleanly (Forge stays running in background)
  console.log(successGradient('✅ Session started in Forge.'));
  console.log('');
  process.exitCode = 0;
}

/**
 * Open URL in browser using cross-platform logic (including WSL support)
 * Based on Forge's browser opening strategy
 */
function openBrowserCrossPlatform(url: string): void {
  try {
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else if (platform === 'win32') {
      // Windows
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'linux') {
      // Check if running in WSL
      const isWSL = fs.existsSync('/proc/version') &&
        fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');

      if (isWSL) {
        // WSL: Use Windows browser via cmd.exe
        try {
          execSync(`cmd.exe /c start "" "${url}"`, { stdio: 'ignore' });
        } catch {
          // Fallback to wslview if cmd.exe fails
          try {
            execSync(`wslview "${url}"`, { stdio: 'ignore' });
          } catch {
            // Last resort: Linux browser
            execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
          }
        }
      } else {
        // Native Linux
        execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
      }
    } else {
      // Unknown platform, try xdg-open
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    }
  } catch (error) {
    console.log(`⚠️  Failed to open browser automatically.`);
    console.log(`   Visit: ${url}`);
  }
}
