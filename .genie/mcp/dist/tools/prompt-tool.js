"use strict";
/**
 * Prompt Tool - Synchronous prompt transformer using an agent
 *
 * Uses an executor to transform/enhance/rewrite prompts in real-time.
 * Runs synchronously (no background task, no worktree).
 *
 * This is the modern equivalent of the old "background off" mode.
 * Creates a temporary Forge task but polls synchronously for completion.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.promptToolSchema = void 0;
exports.executePromptTool = executePromptTool;
const zod_1 = require("zod");
const path_1 = __importDefault(require("path"));
// Load ForgeClient from workspace root
const workspaceRoot = process.cwd();
const ForgeClient = require(path_1.default.join(workspaceRoot, 'forge.js')).ForgeClient;
const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
const DEFAULT_PROJECT_ID = 'ee8f0a72-44da-411d-a23e-f2c6529b62ce'; // Genie project ID
/**
 * Prompt tool parameters
 */
exports.promptToolSchema = zod_1.z.object({
    prompt: zod_1.z.string().describe('Prompt to transform/enhance (e.g., "Help me write a better prompt for implementing dark mode")'),
    agent: zod_1.z.string().optional().default('prompt').describe('Agent to use for transformation (default: "prompt")')
});
/**
 * Prompt tool execution
 */
async function executePromptTool(args, context) {
    const { streamContent } = context;
    const agent = args.agent || 'prompt';
    let fullOutput = `💭 Transforming prompt with agent: ${agent}\n\n`;
    await streamContent({
        type: 'text',
        text: fullOutput
    });
    // Note: No git validation needed - this runs synchronously in current workspace
    // The prompt transformer agent doesn't spawn a worktree, it just processes input/output
    // Create temporary task (we'll poll for completion)
    const forgeClient = new ForgeClient(FORGE_URL);
    let taskResult;
    try {
        taskResult = await forgeClient.createAndStartTask({
            task: {
                project_id: DEFAULT_PROJECT_ID,
                title: `Prompt Transform: ${args.prompt.substring(0, 50)}...`,
                description: `Transform this prompt:\n\n${args.prompt}\n\nAgent: ${agent}`
            },
            executor_profile_id: {
                executor: 'CLAUDE_CODE',
                variant: 'DEFAULT'
            },
            base_branch: 'dev'
        });
    }
    catch (error) {
        const errorMsg = `❌ Failed to process prompt: ${error.message}\n`;
        fullOutput += errorMsg;
        await streamContent({
            type: 'text',
            text: errorMsg
        });
        return fullOutput;
    }
    const taskId = taskResult.task?.id || 'unknown';
    const attemptId = taskResult.task_attempt?.id || 'unknown';
    const waitMsg = `⏳ Waiting for response...\n\n`;
    fullOutput += waitMsg;
    await streamContent({
        type: 'text',
        text: waitMsg
    });
    // Poll for completion (simple polling, no WebSocket)
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max
    let completed = false;
    let answer = '';
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
                        answer = process.normalized_logs
                            .filter((log) => log.type === 'text')
                            .map((log) => log.content)
                            .join('\n\n');
                        const successMsg = `✅ Prompt processed successfully\n\n` +
                            `📝 Answer:\n\n${answer || 'No answer available'}\n\n`;
                        fullOutput += successMsg;
                        await streamContent({
                            type: 'text',
                            text: successMsg
                        });
                    }
                    else if (process.status === 'FAILED') {
                        const failMsg = `❌ Prompt processing failed\n\n`;
                        fullOutput += failMsg;
                        await streamContent({
                            type: 'text',
                            text: failMsg
                        });
                    }
                }
            }
        }
        catch (error) {
            // Ignore polling errors, continue
        }
        attempts++;
    }
    if (!completed) {
        const timeoutMsg = `⏱️  Timeout: Response took too long (30s limit)\n\n` +
            `📊 Check progress at Forge URL below\n\n`;
        fullOutput += timeoutMsg;
        await streamContent({
            type: 'text',
            text: timeoutMsg
        });
    }
    // Output data links (minimal for prompt tool)
    const dataLinksMsg = `🔗 Data Links:\n` +
        `  Agent: ${agent}\n` +
        `  Mode: synchronous (no background task)\n` +
        `  Task ID: ${taskId} (temporary)\n\n`;
    fullOutput += dataLinksMsg;
    await streamContent({
        type: 'text',
        text: dataLinksMsg
    });
    // Genie self-guidance tips
    const tipsMsg = `💡 Genie Tips:\n` +
        `  - This was a synchronous prompt transformation (no worktree spawned)\n` +
        `  - For implementation work, use the forge tool instead\n` +
        `  - Prompt tool is for transforming/enhancing prompts only\n` +
        `  - No git validation required (runs in current workspace)\n` +
        `  - Temporary task will be cleaned up automatically\n`;
    fullOutput += tipsMsg;
    await streamContent({
        type: 'text',
        text: tipsMsg
    });
    // Return full accumulated output (Fix Bug #4: Silent failure)
    return fullOutput;
}
