/**
 * Install Flow Helpers - Master Genie orchestration for fresh installations
 *
 * Architecture:
 * 1. CLI launches MASTER task with simple prompt: "Run explorer to acquire context, when it ends run the install workflow"
 * 2. Master Genie orchestrates: explore → interview → spawn installers → completion
 * 3. User monitors progress in Forge dashboard via shortened URL
 */

import gradient from 'gradient-string';
import path from 'path';
import { execSync } from 'child_process';

// Import ForgeExecutor for workspace project management
import { createForgeExecutor } from './forge-executor.js';

const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';

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

export interface InstallFlowConfig {
  templates: string[];
  executor: string;
  model?: string;
}

/**
 * Print a gradient box to console
 */
export function printBox(title: string, content: string): void {
  const border = '═'.repeat(60);
  console.log(gradient.pastel(`╔${border}╗`));
  console.log(gradient.pastel(`║ ${title.padEnd(58)} ║`));
  console.log(gradient.pastel(`╠${border}╣`));
  console.log(content);
  console.log(gradient.pastel(`╚${border}╝`));
}

/**
 * Launch Master Genie orchestrator for installation
 */
export async function launchMasterGenie(
  config: InstallFlowConfig
): Promise<string> {
  const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';

  console.log('');
  printBox('🧞 MASTER GENIE AWAKENING', 'Starting installation orchestration...');
  console.log('');

  // Get or create workspace-specific Forge project
  const forgeExecutor = createForgeExecutor({ forgeBaseUrl: FORGE_URL });
  const projectId = await forgeExecutor.getOrCreateGenieProject();

  // Get or create master agent (uses forge_agents table)
  const masterResponse = await fetch(`${FORGE_URL}/api/forge/agents?project_id=${projectId}&agent_type=master`);
  if (!masterResponse.ok) {
    throw new Error(`Failed to query master agent: ${masterResponse.status}`);
  }

  const { data: agents } = await masterResponse.json();
  let masterAgent = agents?.[0];

  if (!masterAgent) {
    console.log(gradient.pastel('Creating Master Genie agent...'));
    const createResponse = await fetch(`${FORGE_URL}/api/forge/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        agent_type: 'master'
      })
    });

    if (!createResponse.ok) {
      throw new Error(`Failed to create master agent: ${createResponse.status}`);
    }

    const { data } = await createResponse.json();
    masterAgent = data;
  }

  // Build simple orchestration prompt
  const templates = config.templates?.join(', ') || 'code';
  const prompt = `Run explorer to acquire context, when it ends run the install workflow.

Templates to install: ${templates}

See @.genie/spells/install-genie.md for detailed instructions.`;

  // Create attempt with MASTER variant
  console.log(gradient.pastel('Creating orchestration attempt...'));
  const attemptResponse = await fetch(`${FORGE_URL}/api/task-attempts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task_id: masterAgent.task_id,
      executor_profile_id: {
        executor: config.executor?.toUpperCase() || 'CLAUDE_CODE',
        variant: 'MASTER'
      },
      base_branch: getCurrentBranch()
    })
  });

  if (!attemptResponse.ok) {
    throw new Error(`Failed to create attempt: ${attemptResponse.status}`);
  }

  const { data: attempt } = await attemptResponse.json();

  // Send installation prompt as follow-up message
  const followUpResponse = await fetch(`${FORGE_URL}/api/task-attempts/${attempt.id}/follow-up`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt })
  });

  if (!followUpResponse.ok) {
    throw new Error(`Failed to send installation prompt: ${followUpResponse.status}`);
  }

  console.log('');
  console.log(gradient.pastel('✨ Master Genie orchestrating installation...'));
  console.log('');

  const fullUrl = `${FORGE_URL}/projects/${projectId}/tasks/${masterAgent.task_id}/attempts/${attempt.id}?view=diffs`;

  // Shorten URL
  const { shortUrl: shortened } = await shortenUrl(fullUrl, {
    apiKey: getApiKeyFromEnv()
  });

  return shortened || fullUrl;
}

/**
 * Main install flow orchestrator
 */
export async function runInstallFlow(config: InstallFlowConfig): Promise<string> {
  const forgeExecutor = createForgeExecutor({ forgeBaseUrl: FORGE_URL });

  // Step 0: Sync agent profiles to Forge (makes MASTER, EXPLORE and other variants available)
  console.log('');
  console.log(gradient.pastel('🔄 Teaching Forge about available agents...'));
  console.log('');

  try {
    await forgeExecutor.syncProfiles(undefined);
    console.log(gradient.pastel('✅ Agent profiles synced!'));
    console.log(gradient.pastel('   Waiting for Forge to reload profiles...\n'));
    // Give Forge time to reload executor profiles before creating tasks
    const PROFILE_RELOAD_DELAY_MS = 2000; // Forge needs time to reload profiles
    await new Promise(resolve => setTimeout(resolve, PROFILE_RELOAD_DELAY_MS));
  } catch (error: any) {
    console.log(gradient.pastel('⚠️  Using built-in profiles (agent sync skipped)'));
    console.log(gradient.pastel(`   Reason: ${error.message}\n`));
    // Continue with install - will use DEFAULT variants
  }

  // Step 1: Launch Master Genie orchestrator (handles explore → install workflow)
  const shortUrl = await launchMasterGenie(config);

  return shortUrl;
}

/**
 * Get current git branch (suppresses stderr to avoid scary errors in new repos)
 */
function getCurrentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'] // Suppress stderr
    }).trim();
  } catch {
    // Return 'main' for brand new repos (no commits yet) or non-git directories
    return 'main';
  }
}
