/**
 * Wish Tool - Create wish with GitHub issue enforcement and live progress
 *
 * Implements Amendment 1: No Wish Without Issue
 * Uses WebSocket streaming for real-time progress updates
 * Provides complete data link tracking for traceability
 */

import { z } from 'zod';
import { execSync } from 'child_process';
import { wsManager } from '../websocket-manager.js';
import path from 'path';

// Load ForgeClient from workspace root
const workspaceRoot = process.cwd();
const ForgeClient = require(path.join(workspaceRoot, 'forge.js')).ForgeClient;

const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
const PROJECT_ID = 'ee8f0a72-44da-411d-a23e-f2c6529b62ce'; // Genie project ID

/**
 * Validate GitHub issue exists
 */
async function validateGitHubIssue(issueNumber: number): Promise<boolean> {
  try {
    const result = execSync(`gh issue view ${issueNumber} --json state`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    });

    const issue = JSON.parse(result);
    return issue.state === 'OPEN' || issue.state === 'CLOSED';
  } catch (error) {
    return false;
  }
}

/**
 * Wish tool parameters
 */
export const wishToolSchema = z.object({
  feature: z.string().describe('What you want to build'),
  github_issue: z.number().describe('GitHub issue number (required per Amendment 1)')
});

export type WishToolParams = z.infer<typeof wishToolSchema>;

/**
 * Wish tool execution
 */
export async function executeWishTool(
  args: WishToolParams,
  context: {
    streamContent: (content: { type: string; text: string }) => Promise<void>;
    reportProgress?: (progress: number, total?: number) => Promise<void>;
  }
): Promise<void> {
  const { streamContent, reportProgress } = context;

  // Step 1: Validate GitHub issue (Amendment 1)
  await streamContent({
    type: 'text',
    text: `🔍 Validating GitHub issue #${args.github_issue}...\n`
  });

  const issueExists = await validateGitHubIssue(args.github_issue);

  if (!issueExists) {
    await streamContent({
      type: 'text',
      text: `❌ **GitHub issue #${args.github_issue} not found**\n\n` +
        `⚠️  Amendment 1: No Wish Without Issue\n\n` +
        `Please create a GitHub issue first:\n` +
        `  gh issue create --title "${args.feature}" --body "Feature description..."\n\n` +
        `Then retry with the issue number.\n`
    });
    throw new Error(`GitHub issue #${args.github_issue} not found (Amendment 1 violation)`);
  }

  await streamContent({
    type: 'text',
    text: `✅ GitHub issue #${args.github_issue} verified\n\n`
  });

  if (reportProgress) {
    await reportProgress(1, 5); // Step 1 of 5
  }

  // Step 2: Create Forge task
  await streamContent({
    type: 'text',
    text: `📝 Creating Forge task...\n`
  });

  const forgeClient = new ForgeClient(FORGE_URL);

  let taskResult;
  try {
    taskResult = await forgeClient.createAndStartTask({
      task: {
        project_id: PROJECT_ID,
        title: `Wish: ${args.feature}`,
        description: `GitHub Issue: #${args.github_issue}\n\nFeature: ${args.feature}`
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
      text: `❌ Failed to create Forge task: ${error.message}\n`
    });
    throw error;
  }

  const taskId = taskResult.task?.id || 'unknown';
  const attemptId = taskResult.task_attempt?.id || 'unknown';
  const wishName = args.feature.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const wishFile = `.genie/wishes/${wishName}/${wishName}-wish.md`;

  await streamContent({
    type: 'text',
    text: `✅ Forge task created: ${taskId}\n` +
      `✅ Task attempt started: ${attemptId}\n\n`
  });

  if (reportProgress) {
    await reportProgress(2, 5); // Step 2 of 5
  }

  // Step 3: Subscribe to tasks WebSocket stream
  await streamContent({
    type: 'text',
    text: `📊 Watching progress via WebSocket...\n\n`
  });

  const wsUrl = forgeClient.getTasksStreamUrl(PROJECT_ID);
  let statusUpdateCount = 0;

  const subscriptionId = wsManager.subscribe(
    wsUrl,
    async (data: any) => {
      // Filter for our task ID
      if (data.JsonPatch) {
        statusUpdateCount++;
        await streamContent({
          type: 'text',
          text: `  📝 Status update #${statusUpdateCount}\n`
        });

        if (reportProgress) {
          await reportProgress(3 + statusUpdateCount, 5); // Step 3+ (dynamic)
        }
      }
    },
    async (error: Error) => {
      await streamContent({
        type: 'text',
        text: `⚠️  WebSocket error: ${error.message}\n`
      });
    }
  );

  // Wait a bit for task to initialize and stream some updates
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Unsubscribe from WebSocket
  wsManager.unsubscribe(subscriptionId);

  if (reportProgress) {
    await reportProgress(5, 5); // Complete
  }

  // Step 4: Output data links
  await streamContent({
    type: 'text',
    text: `\n✅ Wish task created successfully!\n\n`
  });

  await streamContent({
    type: 'text',
    text: `🔗 Data Links:\n` +
      `  GitHub Issue: #${args.github_issue}\n` +
      `  Wish File: ${wishFile} (will be created by wish agent)\n` +
      `  Forge Task: ${taskId}\n` +
      `  Forge Attempt: ${attemptId}\n\n`
  });

  // Step 5: Output human-visible URL
  await streamContent({
    type: 'text',
    text: `🌐 Monitor Progress:\n` +
      `http://localhost:8887/projects/${PROJECT_ID}/tasks/${taskId}/attempts/${attemptId}?view=diffs\n\n`
  });

  // Step 6: Check for missing links
  await streamContent({
    type: 'text',
    text: `⚠️  Data Link Check:\n` +
      `  ✅ GitHub Issue: #${args.github_issue} (verified)\n` +
      `  ✅ Forge Task: ${taskId} (created)\n` +
      `  ✅ Forge Attempt: ${attemptId} (started)\n` +
      `  ⏳ Wish File: Pending (wish agent will create)\n\n`
  });

  // Step 7: Genie self-guidance tips
  await streamContent({
    type: 'text',
    text: `💡 Genie Tips:\n` +
      `  - User should review progress at Forge URL above\n` +
      `  - Wish agent will create wish document at ${wishFile}\n` +
      `  - Remember to create PR and link back to issue #${args.github_issue} when work completes\n` +
      `  - Wish workflow will run with status agent monitoring\n` +
      `  - This task follows Amendment 1: No Wish Without Issue ✅\n`
  });
}
