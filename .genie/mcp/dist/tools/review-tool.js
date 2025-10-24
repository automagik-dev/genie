"use strict";
/**
 * Review Tool - Review wish/task with agent and stream feedback
 *
 * Uses log WebSocket streaming for real-time review comments
 * Links to wish files and provides complete data link tracking
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewToolSchema = void 0;
exports.executeReviewTool = executeReviewTool;
const zod_1 = require("zod");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const websocket_manager_js_1 = require("../websocket-manager.js");
const git_validation_js_1 = require("../lib/git-validation.js");
const url_shortener_js_1 = require("../lib/url-shortener.js");
// Load ForgeClient from Genie package root (not user's cwd)
// The MCP server is at: <genie-package>/.genie/mcp/dist/tools/review-tool.js
// forge.js is at: <genie-package>/forge.js
// So we need to go up 4 levels: tools -> dist -> mcp -> .genie -> root
const geniePackageRoot = path_1.default.resolve(__dirname, '../../../..');
const ForgeClient = require(path_1.default.join(geniePackageRoot, 'forge.js')).ForgeClient;
// User's workspace root (for reading wish files)
const workspaceRoot = process.cwd();
const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
const DEFAULT_PROJECT_ID = 'ee8f0a72-44da-411d-a23e-f2c6529b62ce'; // Genie project ID
/**
 * Review tool parameters
 */
exports.reviewToolSchema = zod_1.z.object({
    wish_name: zod_1.z.string().describe('Wish name (e.g., "genie-mcp-mvp")'),
    agent: zod_1.z.string().optional().default('review').describe('Agent to use (default: "review")'),
    project_id: zod_1.z.string().optional().describe('Project ID (defaults to current Genie project)')
});
/**
 * Review tool execution
 */
async function executeReviewTool(args, context) {
    const { streamContent, reportProgress } = context;
    const projectId = args.project_id || DEFAULT_PROJECT_ID;
    const agent = args.agent || 'review';
    // Step 0: Validate git state (CRITICAL: Agents in separate worktrees need clean state)
    await streamContent({
        type: 'text',
        text: `🔍 Checking git working tree state...\n`
    });
    const gitCheck = (0, git_validation_js_1.checkGitState)();
    if (!gitCheck.isClean) {
        await streamContent({
            type: 'text',
            text: `\n${(0, git_validation_js_1.formatGitStateError)(gitCheck)}`
        });
        throw new Error('Git working tree is not clean - cannot start agent');
    }
    await streamContent({
        type: 'text',
        text: `✅ Git working tree is clean and pushed\n\n`
    });
    // Step 1: Load wish document
    await streamContent({
        type: 'text',
        text: `📖 Loading wish: ${args.wish_name}\n\n`
    });
    const wishFile = path_1.default.join(workspaceRoot, `.genie/wishes/${args.wish_name}/${args.wish_name}-wish.md`);
    if (!fs_1.default.existsSync(wishFile)) {
        await streamContent({
            type: 'text',
            text: `❌ Wish file not found: ${wishFile}\n\n` +
                `⚠️  Please check the wish name and ensure the wish file exists.\n`
        });
        throw new Error(`Wish file not found: ${wishFile}`);
    }
    const wishContent = fs_1.default.readFileSync(wishFile, 'utf-8');
    await streamContent({
        type: 'text',
        text: `✅ Wish file loaded: ${wishFile}\n` +
            `   Size: ${wishContent.length} bytes\n\n`
    });
    if (reportProgress) {
        await reportProgress(1, 5);
    }
    // Step 2: Create review task
    await streamContent({
        type: 'text',
        text: `🔍 Starting review with agent: ${agent}\n\n`
    });
    const forgeClient = new ForgeClient(FORGE_URL);
    let taskResult;
    try {
        taskResult = await forgeClient.createAndStartTask({
            task: {
                project_id: projectId,
                title: `Review: ${args.wish_name}`,
                description: `Review wish document\n\nWish: ${args.wish_name}\nAgent: ${agent}\n\n---\n\n${wishContent.substring(0, 1000)}...`
            },
            executor_profile_id: {
                executor: 'CLAUDE_CODE',
                variant: 'review'
            },
            base_branch: 'dev'
        });
    }
    catch (error) {
        await streamContent({
            type: 'text',
            text: `❌ Failed to create review task: ${error.message}\n`
        });
        throw error;
    }
    const taskId = taskResult.task?.id || 'unknown';
    const attemptId = taskResult.task_attempt?.id || 'unknown';
    await streamContent({
        type: 'text',
        text: `✅ Review task created: ${taskId}\n` +
            `✅ Task attempt started: ${attemptId}\n\n`
    });
    if (reportProgress) {
        await reportProgress(2, 5);
    }
    // Step 2.5: Update task status to 'agent' (hide from main Kanban, show in widget)
    await streamContent({
        type: 'text',
        text: `📊 Updating task status...\n`
    });
    try {
        await forgeClient.updateTask(projectId, taskId, {
            status: 'agent'
        });
        await streamContent({
            type: 'text',
            text: `✅ Task status: agent (visible in Review widget only)\n\n`
        });
    }
    catch (error) {
        // Non-fatal: log warning but continue
        await streamContent({
            type: 'text',
            text: `⚠️  Could not update task status: ${error.message}\n` +
                `   Task may appear in main Kanban instead of widget.\n\n`
        });
    }
    // Step 3: Subscribe to logs WebSocket stream
    await streamContent({
        type: 'text',
        text: `📊 Watching review via logs stream...\n\n`
    });
    // Get the first execution process ID
    let processId;
    try {
        const attempt = await forgeClient.getTaskAttempt(attemptId);
        if (attempt.execution_processes && attempt.execution_processes.length > 0) {
            processId = attempt.execution_processes[0].id;
        }
    }
    catch (error) {
        await streamContent({
            type: 'text',
            text: `⚠️  Could not get execution process ID: ${error.message}\n`
        });
    }
    let logCount = 0;
    if (processId) {
        const wsUrl = forgeClient.getNormalizedLogsStreamUrl(processId);
        const subscriptionId = websocket_manager_js_1.wsManager.subscribe(wsUrl, async (data) => {
            logCount++;
            // Format log data (basic)
            await streamContent({
                type: 'text',
                text: `  🤖 Agent feedback #${logCount}\n`
            });
            if (reportProgress && logCount <= 3) {
                await reportProgress(2 + logCount, 5);
            }
        }, async (error) => {
            await streamContent({
                type: 'text',
                text: `⚠️  WebSocket error: ${error.message}\n`
            });
        });
        // Wait for review to run
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
        // Unsubscribe from WebSocket
        websocket_manager_js_1.wsManager.unsubscribe(subscriptionId);
    }
    else {
        await streamContent({
            type: 'text',
            text: `⚠️  No execution process found yet. Review is starting...\n\n`
        });
        // Wait without WebSocket
        await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (reportProgress) {
        await reportProgress(5, 5);
    }
    // Step 4: Output completion
    await streamContent({
        type: 'text',
        text: `\n✅ Review monitoring complete!\n\n`
    });
    // Step 5: Output data links
    await streamContent({
        type: 'text',
        text: `🔗 Data Links:\n` +
            `  Wish File: ${wishFile}\n` +
            `  Forge Task: ${taskId}\n` +
            `  Forge Attempt: ${attemptId}\n` +
            `  Agent: ${agent}\n` +
            (processId ? `  Process: ${processId}\n` : '') + `\n`
    });
    // Step 6: Output human-visible URL (shortened if service available)
    const fullUrl = `${FORGE_URL}/projects/${projectId}/tasks/${taskId}/attempts/${attemptId}?view=logs`;
    const { shortUrl } = await (0, url_shortener_js_1.shortenUrl)(fullUrl, {
        apiKey: (0, url_shortener_js_1.getApiKeyFromEnv)()
    });
    await streamContent({
        type: 'text',
        text: `🌐 Monitor Progress:\n` +
            `${shortUrl || fullUrl}\n\n`
    });
    // Step 7: Check for missing links
    await streamContent({
        type: 'text',
        text: `⚠️  Data Link Check:\n` +
            `  ✅ Wish File: ${wishFile} (exists)\n` +
            `  ✅ Review Task: ${taskId} (created)\n` +
            `  ✅ Forge Attempt: ${attemptId} (started)\n` +
            `  ⚠️  GitHub Issue: not verified (consider linking wish to issue)\n\n`
    });
    // Step 8: Genie self-guidance tips
    await streamContent({
        type: 'text',
        text: `💡 Genie Tips:\n` +
            `  - User can view review feedback at Forge URL above\n` +
            `  - Review agent (${agent}) will analyze wish completeness and code quality\n` +
            `  - Consider creating GitHub issue if wish doesn't have one yet (Amendment 1)\n` +
            `  - Task will continue running in background (monitored ${logCount} log updates)\n` +
            `  - Use the Forge URL to see full review report and feedback\n`
    });
}
