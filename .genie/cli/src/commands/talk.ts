/**
 * Talk Command - Interactive browser session with agent
 *
 * Starts Forge if needed, shows ready message, opens dashboard in browser.
 * Forge stays running in background after command exits.
 */

import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { isForgeRunning, startForgeInBackground, waitForForgeReady } from '../lib/forge-manager';
import path from 'path';
import { execSync } from 'child_process';
import gradient from 'gradient-string';

// Genie-themed gradients
const genieGradient = gradient(['#0066ff', '#9933ff', '#ff00ff']);
const successGradient = gradient(['#00ff88', '#00ccff', '#0099ff']);

export async function runTalk(
  parsed: ParsedCommand,
  config: GenieConfig,
  paths: Required<ConfigPaths>
): Promise<void> {
  const [agentName] = parsed.commandArgs;

  if (!agentName) {
    console.error('Usage: genie talk <agent>');
    process.exit(1);
  }

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

  // Show ready message
  console.log('');
  console.log(successGradient('━'.repeat(60)));
  console.log(successGradient('✨ Genie is ready and running! ✨'));
  console.log(successGradient('━'.repeat(60)));
  console.log('');
  console.log(genieGradient('Press Enter to open dashboard...'));

  // Countdown with Enter interrupt
  const opened = await waitForEnterOrTimeout(5000);

  console.log('');
  console.log(genieGradient('📊 Opening dashboard in browser...'));
  console.log('');

  // Open browser to dashboard
  const dashboardUrl = `${baseUrl}/dashboard`;
  openBrowser(dashboardUrl);

  // Exit (Forge stays running in background)
  console.log(successGradient('Forge is running in background. Use Ctrl+C in dashboard or run "genie stop" to shutdown.'));
  console.log('');
  process.exit(0);
}

/**
 * Wait for Enter key or timeout
 * Shows countdown if timeout will trigger
 */
async function waitForEnterOrTimeout(ms: number): Promise<'enter' | 'timeout'> {
  return new Promise((resolve) => {
    let countdown = Math.floor(ms / 1000);

    const timer = setInterval(() => {
      process.stderr.write(`\rOpening in ${countdown}s... (or press Enter now)`);
      countdown--;

      if (countdown < 0) {
        clearInterval(timer);
        cleanup();
        resolve('timeout');
      }
    }, 1000);

    const onData = () => {
      clearInterval(timer);
      cleanup();
      resolve('enter');
    };

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stderr.write('\r' + ' '.repeat(50) + '\r'); // Clear countdown line
    };

    process.stdin.once('data', onData);
  });
}

/**
 * Open URL in default browser
 */
function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const openCommand = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
    execSync(`${openCommand} "${url}"`, { stdio: 'ignore' });
  } catch {
    console.log(`Failed to open browser. Visit: ${url}`);
  }
}
