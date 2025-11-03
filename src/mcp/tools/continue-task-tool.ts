/**
 * Continue Task Tool - Send follow-up work to existing task or create new attempt
 *
 * Allows continuing work on an existing task attempt via follow-up prompt.
 * Used primarily by master orchestrators to receive new work.
 */

import { z } from 'zod';
import path from 'path';

// Load ForgeClient from src/lib (resolves from package root)
// Compiled location: dist/mcp/tools/continue-task-tool.js
// Target: src/lib/forge-client.js
const geniePackageRoot = path.resolve(__dirname, '../../..');
const ForgeClient = require(path.join(geniePackageRoot, 'src/lib/forge-client.js')).ForgeClient;

const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';

/**
 * Continue task parameters
 */
export const continueTaskToolSchema = z.object({
  attempt_id: z.string().describe('Task attempt ID to send work to'),
  prompt: z.string().describe('Follow-up prompt with new work')
});

export type ContinueTaskToolParams = z.infer<typeof continueTaskToolSchema>;

/**
 * Continue task execution
 */
export async function executeContinueTaskTool(
  args: ContinueTaskToolParams,
  context: any
): Promise<string> {
  const { streamContent } = context;
  let fullOutput = `🔄 Sending follow-up to task attempt: ${args.attempt_id}\n\n`;

  await streamContent({
    type: 'text',
    text: fullOutput
  });

  const forgeClient = new ForgeClient(FORGE_URL);

  try {
    await forgeClient.followUpTaskAttempt(args.attempt_id, args.prompt);

    const successMsg = `✅ Follow-up sent successfully\n\n` +
      `📝 Prompt:\n${args.prompt}\n\n` +
      `💡 The master orchestrator will process this work in the background.\n`;
    
    fullOutput += successMsg;
    await streamContent({
      type: 'text',
      text: successMsg
    });

    return fullOutput;
  } catch (error: any) {
    const errorMsg = `❌ Failed to send follow-up: ${error.message}\n`;
    fullOutput += errorMsg;
    await streamContent({
      type: 'text',
      text: errorMsg
    });
    return fullOutput;
  }
}
