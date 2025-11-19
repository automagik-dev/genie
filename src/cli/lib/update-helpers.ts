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

// Import ForgeExecutor for workspace project management
import { createForgeExecutor } from './forge-executor.js';
import { waitForForgeReady } from './forge-manager.js';

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
 * Reads diff file and creates task with update agent
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
    // Wait for Forge to be ready (with timeout)
    console.log(gradient.pastel('⏳ Waiting for Forge backend to start...'));
    const forgeReady = await waitForForgeReady(FORGE_URL, 30000, 500, false);

    if (!forgeReady) {
      throw new Error(
        `Forge backend did not start within 30 seconds. The update diff is ready at ${diffPath}. You can manually create the update task after Forge starts.`
      );
    }

    console.log(gradient.pastel('✅ Forge backend is ready'));
    console.log('');

    // Read diff content
    const diffContent = await fsp.readFile(diffPath, 'utf8');

    // Get or create workspace-specific Forge project
    const forgeExecutor = createForgeExecutor({ forgeBaseUrl: FORGE_URL });
    const projectId = await forgeExecutor.getOrCreateGenieProject();

    // Get or create update task template
    const updateResponse = await fetch(
      `${FORGE_URL}/api/forge/agents?project_id=${projectId}&agent_type=update`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      }
    );

    if (!updateResponse.ok) {
      throw new Error(`Failed to query update agent: ${updateResponse.status}`);
    }

    const { data: agents } = (await updateResponse.json()) as any;
    let updateAgent = agents?.[0];

    if (!updateAgent) {
      // Create update agent if it doesn't exist
      console.log(gradient.pastel('Creating update agent...'));
      const createResponse = await fetch(`${FORGE_URL}/api/forge/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          agent_type: 'update'
        })
      });

      if (!createResponse.ok) {
        throw new Error(`Failed to create update agent: ${createResponse.status}`);
      }

      const { data } = (await createResponse.json()) as any;
      updateAgent = data;
    }

    // Get update agent definition from registry
    let updateVariant = 'DEFAULT';
    let updateExecutor = 'CLAUDE_CODE';

    try {
      const { getAgentRegistry } = await import('./agent-registry.js');
      const registry = await getAgentRegistry();
      const updateAgentDef = registry.getAgent('update');

      if (updateAgentDef) {
        // Construct variant name following Forge convention:
        // 1. Explicit override: forge_profile_name
        // 2. Pattern: {COLLECTIVE}_{AGENT} (e.g., CODE_UPDATE) - only if collective exists
        // 3. Fallback: DEFAULT (for base agents without collective)
        if (updateAgentDef.forge_profile_name) {
          updateVariant = updateAgentDef.forge_profile_name;
        } else if (updateAgentDef.collective && updateAgentDef.name) {
          updateVariant = `${updateAgentDef.collective.toUpperCase()}_${updateAgentDef.name.toUpperCase()}`;
        } else {
          // Base agent without collective - use DEFAULT variant
          updateVariant = 'DEFAULT';
        }
        updateExecutor = updateAgentDef.genie?.executor || updateExecutor;
      }
    } catch (error) {
      // Use fallback DEFAULT if registry unavailable
      console.warn(
        'Failed to load update agent definition, using fallback variant'
      );
    }

    // Create attempt with update variant
    console.log(gradient.pastel('Creating update attempt...'));

    // Validate branch name - Forge API rejects certain patterns
    const currentBranch = getCurrentBranch();
    const baseBranch = getValidBaseBranch(currentBranch);

    const attemptResponse = await fetch(`${FORGE_URL}/api/task-attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: updateAgent.task_id,
        executor_profile_id: {
          executor: updateExecutor,
          variant: updateVariant
        },
        base_branch: baseBranch
      })
    });

    if (!attemptResponse.ok) {
      throw new Error(`Failed to create attempt: ${attemptResponse.status}`);
    }

    const { data: attempt } = (await attemptResponse.json()) as any;

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

    // Send update prompt as follow-up message
    const followUpResponse = await fetch(
      `${FORGE_URL}/api/task-attempts/${attempt.id}/follow-up`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      }
    );

    if (!followUpResponse.ok) {
      throw new Error(
        `Failed to send update prompt: ${followUpResponse.status}`
      );
    }

    console.log('');
    console.log(gradient.pastel('✨ Genie orchestrating update...'));
    console.log('');

    const fullUrl = `${FORGE_URL}/projects/${projectId}/tasks/${updateAgent.task_id}/attempts/${attempt.id}?view=diffs`;

    // Shorten URL
    const { shortUrl: shortened } = (await shortenUrl(fullUrl, {
      apiKey: getApiKeyFromEnv()
    })) as any;

    return shortened || fullUrl;
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

/**
 * Validates branch name and returns a valid base branch for Forge API.
 * Forge API rejects certain branch name patterns (e.g., forge/*, worktree/*).
 * Falls back to 'dev' for forbidden patterns.
 */
function getValidBaseBranch(branchName: string): string {
  // Forbidden patterns that Forge API rejects
  const forbiddenPatterns = [/^forge\//, /^worktree\//];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(branchName)) {
      console.log(
        gradient.pastel(
          `⚠️  Branch '${branchName}' not suitable for base branch`
        )
      );
      console.log(gradient.pastel('   Using fallback: dev'));
      return 'dev';
    }
  }

  return branchName;
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
