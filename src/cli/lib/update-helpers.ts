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

export interface UpdateFlowConfig {
  diffPath: string;
  oldVersion: string;
  newVersion: string;
  workspacePath: string;
}

/**
 * Launch Genie update task using genie CLI
 * Reads diff file and delegates to update agent
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
    console.log(gradient.pastel('Launching update orchestrator...'));

    // Build update prompt with agent path and diff file path
    const relativeDiffPath = path.relative(workspacePath, diffPath);
    const prompt = `Apply framework upgrade from ${oldVersion} to ${newVersion}.

Agent: @.genie/code/agents/update.md
Diff: ${relativeDiffPath}

Process this knowledge diff:
1. Read the diff file to understand what changed
2. Analyze added/removed/modified files
3. Assess user impact
4. Generate clear update report`;

    // Use genie CLI to launch update orchestration
    const genieBin = path.join(__dirname, '../genie-cli.js');

    // Use genie task (headless) for background orchestration
    // Agent frontmatter specifies executor (CLAUDE_CODE, CODEX, or OPENCODE)
    const result = execSync(`node "${genieBin}" task update "${prompt.replace(/"/g, '\\"')}"`, {
      cwd: workspacePath,
      encoding: 'utf8',
      stdio: 'pipe'
    });

    // Parse JSON output from genie task
    // Expected format: { task_id, task_url, agent, executor, status, message }
    const jsonOutput = JSON.parse(result.trim());
    const taskUrl = jsonOutput.task_url;

    console.log('');
    console.log(gradient.pastel('✨ Genie orchestrating update...'));
    console.log('');

    return taskUrl;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('');
    console.error(gradient.pastel('❌ Failed to create update task:'));
    console.error(errorMsg);
    console.error('');
    throw error;
  }
}
