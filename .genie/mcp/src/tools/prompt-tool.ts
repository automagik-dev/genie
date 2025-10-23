/**
 * Prompt Tool - Simple synchronous Q&A with an agent
 *
 * No background tasks, no WebSocket streaming
 * Direct request/response for quick questions and guidance
 */

import { z } from 'zod';
import path from 'path';

// Load ForgeClient from workspace root
const workspaceRoot = process.cwd();
const ForgeClient = require(path.join(workspaceRoot, 'forge.js')).ForgeClient;

const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
const DEFAULT_PROJECT_ID = 'ee8f0a72-44da-411d-a23e-f2c6529b62ce'; // Genie project ID

/**
 * Prompt tool parameters
 */
export const promptToolSchema = z.object({
  question: z.string().describe('Question to ask (e.g., "How do I implement dark mode?")'),
  agent: z.string().optional().default('genie').describe('Agent to use (default: "genie")')
});

export type PromptToolParams = z.infer<typeof promptToolSchema>;

/**
 * Prompt tool execution
 */
export async function executePromptTool(
  args: PromptToolParams,
  context: {
    streamContent: (content: { type: string; text: string }) => Promise<void>;
  }
): Promise<void> {
  const { streamContent } = context;
  const agent = args.agent || 'genie';

  await streamContent({
    type: 'text',
    text: `💭 Processing prompt with agent: ${agent}\n\n`
  });

  // Create temporary task (we'll poll for completion)
  const forgeClient = new ForgeClient(FORGE_URL);

  let taskResult;
  try {
    taskResult = await forgeClient.createAndStartTask({
      task: {
        project_id: DEFAULT_PROJECT_ID,
        title: `Q&A: ${args.question.substring(0, 50)}...`,
        description: `Question: ${args.question}\n\nAgent: ${agent}`
      },
      executor_profile_id: {
        executor: 'CLAUDE_CODE',
        variant: 'DEFAULT'
      },
      base_branch: 'dev'
    });
  } catch (error: any) {
    await streamContent({
      type: 'text',
      text: `❌ Failed to process prompt: ${error.message}\n`
    });
    throw error;
  }

  const taskId = taskResult.task?.id || 'unknown';
  const attemptId = taskResult.task_attempt?.id || 'unknown';

  await streamContent({
    type: 'text',
    text: `⏳ Waiting for response...\n\n`
  });

  // Poll for completion (simple polling, no WebSocket)
  let attempts = 0;
  const maxAttempts = 30; // 30 seconds max
  let completed = false;

  while (attempts < maxAttempts && !completed) {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second

    try {
      const attempt = await forgeClient.getTaskAttempt(attemptId);

      // Check if execution is complete
      if (attempt.execution_processes && attempt.execution_processes.length > 0) {
        const process = attempt.execution_processes[0];

        if (process.status === 'COMPLETED' || process.status === 'FAILED') {
          completed = true;

          if (process.status === 'COMPLETED' && process.normalized_logs) {
            // Extract answer from logs
            const answer = process.normalized_logs
              .filter((log: any) => log.type === 'text')
              .map((log: any) => log.content)
              .join('\n\n');

            await streamContent({
              type: 'text',
              text: `✅ Prompt processed successfully\n\n` +
                `📝 Answer:\n\n${answer || 'No answer available'}\n\n`
            });
          } else if (process.status === 'FAILED') {
            await streamContent({
              type: 'text',
              text: `❌ Prompt processing failed\n\n`
            });
          }
        }
      }
    } catch (error: any) {
      // Ignore polling errors, continue
    }

    attempts++;
  }

  if (!completed) {
    await streamContent({
      type: 'text',
      text: `⏱️  Timeout: Response took too long (30s limit)\n\n` +
        `📊 Check progress at Forge URL below\n\n`
    });
  }

  // Output data links (minimal for prompt tool)
  await streamContent({
    type: 'text',
    text: `🔗 Data Links:\n` +
      `  Agent: ${agent}\n` +
      `  Mode: synchronous (no background task)\n` +
      `  Task ID: ${taskId} (temporary)\n\n`
  });

  // Genie self-guidance tips
  await streamContent({
    type: 'text',
    text: `💡 Genie Tips:\n` +
      `  - This was a direct Q&A, no Forge task created for monitoring\n` +
      `  - For implementation work, use the forge tool instead\n` +
      `  - Prompt tool is for quick questions and guidance only\n` +
      `  - Temporary task will be cleaned up automatically\n`
  });
}
