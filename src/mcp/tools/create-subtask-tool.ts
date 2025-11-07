/**
 * Create Subtask Tool - Create child task under master orchestrator
 *
 * Allows master orchestrators to delegate work as subtasks.
 * Subtasks have parent relationship and can be used for complex work breakdown.
 */

import { z } from 'zod';
import path from 'path';
import { execSync } from 'child_process';
import { formatTaskTitle } from '../lib/task-title-formatter.js';
import { getForgeConfig } from '../lib/service-config.js';

// Load ForgeClient from src/lib (resolves from package root)
// Compiled location: dist/mcp/tools/create-subtask-tool.js
// Target: src/lib/forge-client.js
const geniePackageRoot = path.resolve(__dirname, '../../..');
const ForgeClient = require(path.join(geniePackageRoot, 'src/lib/forge-client.js')).ForgeClient;

const { baseUrl: FORGE_URL } = getForgeConfig();

/**
 * Create subtask parameters
 */
export const createSubtaskToolSchema = z.object({
  parent_attempt_id: z.string().describe('Parent task attempt ID (the master orchestrator)'),
  title: z.string().describe('Subtask title'),
  prompt: z.string().describe('Subtask prompt/description'),
  executor: z.string().optional().default('CLAUDE_CODE:DEFAULT').describe('Executor variant (e.g., "CLAUDE_CODE:CODE_INSTALL", "CLAUDE_CODE:CODE_EXPLORE", "CLAUDE_CODE:MASTER"). Format: EXECUTOR:VARIANT where VARIANT is {COLLECTIVE}_{AGENT} like CODE_INSTALL or CREATE_INSTALL, or special variants like MASTER, DEFAULT.')
});

export type CreateSubtaskToolParams = z.infer<typeof createSubtaskToolSchema>;

/**
 * Create subtask execution
 */
export async function executeCreateSubtaskTool(
  args: CreateSubtaskToolParams,
  context: any
): Promise<string> {
  const { streamContent } = context;
  let fullOutput = `📦 Creating subtask under parent: ${args.parent_attempt_id}\n\n`;

  await streamContent({
    type: 'text',
    text: fullOutput
  });

  const forgeClient = new ForgeClient(FORGE_URL);

  try {
    // Get project ID dynamically from workspace
    const projects = await forgeClient.listProjects();
    const projectId = projects[0]?.id;

    if (!projectId) {
      throw new Error('No Forge project found. Run genie init first.');
    }

    // Parse executor string (format: "CLAUDE_CODE:DEFAULT" or "CLAUDE_CODE")
    const [executor, variant = 'DEFAULT'] = args.executor.split(':');

    // Detect current git branch (same logic as forge-executor.ts)
    let baseBranch = 'main'; // Default fallback
    try {
      baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf8',
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'] // Suppress stderr
      }).trim();
    } catch (error) {
      // If git detection fails, try to get default_base_branch from project
      try {
        const project = await forgeClient.getProject(projectId);
        if (project.default_base_branch) {
          baseBranch = project.default_base_branch;
        }
      } catch {
        // Use fallback 'main'
      }
    }

    const result = await forgeClient.createAndStartTask({
      task: {
        project_id: projectId,
        title: formatTaskTitle('MCP', `Subtask: ${args.title}`),
        description: args.prompt,
        parent_task_attempt: args.parent_attempt_id
      },
      executor_profile_id: {
        executor: executor.toUpperCase(),
        variant: variant.toUpperCase()
      },
      base_branch: baseBranch
    });

    const taskId = result.id;
    const attemptId = result.attempts?.[0]?.id || result.id;
    const url = `${FORGE_URL}/projects/${projectId}/tasks/${taskId}/attempts/${attemptId}?view=diffs`;

    const successMsg = `✅ Subtask created successfully\n\n` +
      `📋 Title: ${args.title}\n` +
      `🔗 URL: ${url}\n` +
      `🆔 Task ID: ${taskId}\n` +
      `🔄 Attempt ID: ${attemptId}\n\n` +
      `💡 Subtask will execute in background as child of master orchestrator.\n`;

    fullOutput += successMsg;
    await streamContent({
      type: 'text',
      text: successMsg
    });

    return fullOutput;
  } catch (error: any) {
    const errorMsg = `❌ Failed to create subtask: ${error.message}\n`;
    fullOutput += errorMsg;
    await streamContent({
      type: 'text',
      text: errorMsg
    });
    return fullOutput;
  }
}
