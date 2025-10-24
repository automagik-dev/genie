/**
 * Create Subtask Tool - Create child task under master orchestrator
 *
 * Allows master orchestrators to delegate work as subtasks.
 * Subtasks have parent relationship and can be used for complex work breakdown.
 */

import { z } from 'zod';
import path from 'path';

// Load ForgeClient
const geniePackageRoot = path.resolve(__dirname, '../../../..');
const ForgeClient = require(path.join(geniePackageRoot, 'forge.js')).ForgeClient;

const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
const DEFAULT_PROJECT_ID = 'ee8f0a72-44da-411d-a23e-f2c6529b62ce'; // Genie project ID

/**
 * Create subtask parameters
 */
export const createSubtaskToolSchema = z.object({
  parent_attempt_id: z.string().describe('Parent task attempt ID (the master orchestrator)'),
  title: z.string().describe('Subtask title'),
  prompt: z.string().describe('Subtask prompt/description'),
  executor: z.string().optional().default('CLAUDE_CODE:DEFAULT').describe('Executor variant (e.g., "CLAUDE_CODE:wish", "CLAUDE_CODE:DEFAULT")')
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
    const result = await forgeClient.createAndStartTask({
      project_id: DEFAULT_PROJECT_ID,
      title: args.title,
      prompt: args.prompt,
      executor: args.executor,
      parent_task_attempt: args.parent_attempt_id
    });

    const taskId = result.task_id || 'unknown';
    const attemptId = result.attempt_id || 'unknown';
    const url = `${FORGE_URL}/projects/${DEFAULT_PROJECT_ID}/tasks/${taskId}/attempts/${attemptId}?view=diffs`;

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
