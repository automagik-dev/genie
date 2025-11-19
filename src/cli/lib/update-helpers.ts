/**
 * Update Flow Helpers - Genie orchestration for framework upgrades
 *
 * Architecture:
 * 1. CLI generates knowledge diff during init (2.5.14+)
 * 2. Init creates Forge task with diff as input to update agent
 * 3. Update agent processes diff and applies changes
 * 4. User monitors progress in Forge dashboard
 */

import { getForgeConfig } from './service-config.js';
import gradient from 'gradient-string';
import path from 'path';
import { promises as fsp } from 'fs';
import { execSync } from 'child_process';
import os from 'os';

import { waitForForgeReady, isForgeRunning, startForgeInBackground } from './forge-manager.js';

const FORGE_URL = process.env.FORGE_BASE_URL || getForgeConfig().baseUrl;

// Import from compiled MCP dist (will be available after build)
let shortenUrl: any;
let getApiKeyFromEnv: any;

try {
  const urlShortener = require('../../mcp/dist/lib/url-shortener.js');
  shortenUrl = urlShortener.shortenUrl;
  getApiKeyFromEnv = urlShortener.getApiKeyFromEnv;
} catch {
  // Fallback if MCP not built yet
  shortenUrl = async (url: string) => ({ success: false, fullUrl: url });
  getApiKeyFromEnv = () => undefined;
}

export interface UpdateFlowConfig {
  diffPath: string;
  oldVersion: string;
  newVersion: string;
  workspacePath: string;
}

/**
 * Launch Forge update task for knowledge diff
 * Uses `genie run` CLI for proper Forge UI integration and task naming
 */
export async function launchUpdateTask(
  config: UpdateFlowConfig
): Promise<string> {
  const { diffPath, oldVersion, newVersion, workspacePath } = config;

  console.log('');
  console.log(gradient.pastel('╔' + '═'.repeat(58) + '╗'));
  console.log(gradient.pastel('║ 🔄 GENIE UPDATE ORCHESTRATION' + ' '.repeat(28) + '║'));
  console.log(gradient.pastel('╚' + '═'.repeat(58) + '╝'));
  console.log('');

  try {
    // Check if Forge is already running, if not start it
    const isRunning = await isForgeRunning(FORGE_URL, 1);

    if (!isRunning) {
      console.log(gradient.pastel('🚀 Starting Forge backend...'));

      // Start Forge in background
      const logDir = path.join(os.tmpdir(), 'genie-forge');
      const startResult = startForgeInBackground({
        baseUrl: FORGE_URL,
        logDir
      });

      if (!startResult.ok) {
        const errorMsg = 'error' in startResult ? startResult.error.message : 'Unknown error';
        throw new Error(
          `Failed to start Forge: ${errorMsg}. The update diff is ready at ${diffPath}.`
        );
      }

      // Wait for Forge to be ready (with timeout)
      console.log(gradient.pastel('⏳ Waiting for Forge to be ready...'));
      const forgeReady = await waitForForgeReady(FORGE_URL, 30000, 500, false);

      if (!forgeReady) {
        throw new Error(
          `Forge did not start within 30 seconds. The update diff is ready at ${diffPath}. You can manually create the update task after Forge starts.`
        );
      }

      console.log(gradient.pastel('✅ Forge backend is ready'));
    } else {
      console.log(gradient.pastel('✅ Forge backend is already running'));
    }

    console.log('');
    console.log(gradient.pastel('✨ Genie orchestrating update...'));
    console.log('');

    // Build update prompt with agent path and diff file path
    // Both paths are committed and available to the agent
    const prompt = `Apply framework upgrade from ${oldVersion} to ${newVersion}.

Agent: @.genie/code/agents/update.md
Diff: ${path.relative(workspacePath, diffPath)}

Process this knowledge diff:
1. Read the diff file to understand what changed
2. Analyze added/removed/modified files
3. Assess user impact
4. Generate clear update report`;

    // Write prompt to temp file to avoid shell escaping issues
    const tmpDir = os.tmpdir();
    const promptFile = path.join(tmpDir, `genie-update-prompt-${Date.now()}.txt`);
    await fsp.writeFile(promptFile, prompt, 'utf8');

    try {
      // Use `genie run` CLI for proper task creation and Forge UI integration
      // This ensures:
      // - Proper [C] task naming prefix
      // - Forge card/UI creation
      // - Standard Genie orchestration
      // - No orphan tasks
      const genieRunCmd = `genie run update "$(cat '${promptFile}')"`;

      // Run and capture the JSON output
      const output = execSync(genieRunCmd, {
        cwd: workspacePath,
        encoding: 'utf8',
        shell: '/bin/bash' // Use bash shell for command substitution
      });

      // Parse JSON output from genie run to extract task URL
      const result = JSON.parse(output.trim());
      const taskUrl = result.task_url;

      if (!taskUrl) {
        throw new Error('Failed to get task URL from genie run output');
      }

      // Shorten URL
      const { shortUrl: shortened } = (await shortenUrl(taskUrl, {
        apiKey: getApiKeyFromEnv()
      })) as any;

      return shortened || taskUrl;
    } finally {
      // Cleanup temp prompt file
      try {
        await fsp.unlink(promptFile);
      } catch {
        // Non-fatal: temp file cleanup failed
      }
    }
  } catch (error) {
    const errorMsg =
      error instanceof Error ? error.message : String(error);
    console.error('');
    console.error(gradient.pastel('❌ Failed to create update task:'));
    console.error(errorMsg);
    console.error('');
    throw error;
  }
}

