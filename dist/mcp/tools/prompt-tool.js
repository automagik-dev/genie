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
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const project_detector_js_1 = require("../lib/project-detector.js");
const task_title_formatter_js_1 = require("../lib/task-title-formatter.js");
const service_config_js_1 = require("../lib/service-config.js");
// Load ForgeClient from Genie package root (not user's cwd)
// Compiled location: dist/mcp/tools/prompt-tool.js
// Target: src/lib/forge-client.js
// Path: ../../../src/lib/forge-client.js (dist/mcp/tools -> root -> src/lib)
const geniePackageRoot = path_1.default.resolve(__dirname, '../../..');
const ForgeClient = require(path_1.default.join(geniePackageRoot, 'src/lib/forge-client.js')).ForgeClient;
const { baseUrl: FORGE_URL } = (0, service_config_js_1.getForgeConfig)();
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
    const projectId = await (0, project_detector_js_1.getOrCreateGenieProject)(forgeClient);
    // Detect current git branch (same logic as other neuron tools)
    let baseBranch = 'main'; // Default fallback
    try {
        baseBranch = (0, child_process_1.execSync)('git rev-parse --abbrev-ref HEAD', {
            encoding: 'utf8',
            cwd: process.cwd(),
            stdio: ['pipe', 'pipe', 'pipe'] // Suppress stderr
        }).trim();
    }
    catch (error) {
        // If git detection fails, try to get default_base_branch from project
        try {
            const project = await forgeClient.getProject(projectId);
            if (project.default_base_branch) {
                baseBranch = project.default_base_branch;
            }
        }
        catch {
            // Use fallback 'main'
        }
    }
    let taskResult;
    try {
        taskResult = await forgeClient.createAndStartTask({
            task: {
                project_id: projectId,
                title: (0, task_title_formatter_js_1.formatTaskTitle)('MCP', `Prompt Transform: ${args.prompt.substring(0, 50)}...`),
                description: `Transform this prompt:\n\n${args.prompt}\n\nAgent: ${agent}`
            },
            executor_profile_id: {
                executor: 'CLAUDE_CODE',
                variant: 'DEFAULT'
            },
            base_branch: baseBranch
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
