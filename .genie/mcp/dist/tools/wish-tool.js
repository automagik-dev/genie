"use strict";
/**
 * Wish Tool - Create wish with GitHub issue enforcement and live progress
 *
 * Implements Amendment 1: No Wish Without Issue
 * Uses WebSocket streaming for real-time progress updates
 * Provides complete data link tracking for traceability
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.wishToolSchema = void 0;
exports.executeWishTool = executeWishTool;
const zod_1 = require("zod");
const child_process_1 = require("child_process");
const websocket_manager_js_1 = require("../websocket-manager.js");
const git_validation_js_1 = require("../lib/git-validation.js");
const url_shortener_js_1 = require("../lib/url-shortener.js");
const session_manager_js_1 = require("../lib/session-manager.js");
const path_1 = __importDefault(require("path"));
// Load ForgeClient from Genie package root (not user's cwd)
// The MCP server is at: <genie-package>/.genie/mcp/dist/tools/wish-tool.js
// forge.js is at: <genie-package>/forge.js
// So we need to go up 4 levels: tools -> dist -> mcp -> .genie -> root
const geniePackageRoot = path_1.default.resolve(__dirname, '../../../..');
const ForgeClient = require(path_1.default.join(geniePackageRoot, 'forge.js')).ForgeClient;
const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
const PROJECT_ID = 'ee8f0a72-44da-411d-a23e-f2c6529b62ce'; // Genie project ID
/**
 * Validate GitHub issue exists
 */
async function validateGitHubIssue(issueNumber) {
    try {
        const result = (0, child_process_1.execSync)(`gh issue view ${issueNumber} --json state`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'ignore']
        });
        const issue = JSON.parse(result);
        return issue.state === 'OPEN' || issue.state === 'CLOSED';
    }
    catch (error) {
        return false;
    }
}
/**
 * Wish tool parameters
 */
exports.wishToolSchema = zod_1.z.object({
    feature: zod_1.z.string().describe('What you want to build'),
    github_issue: zod_1.z.number().describe('GitHub issue number (required per Amendment 1)')
});
/**
 * Wish tool execution
 */
async function executeWishTool(args, context) {
    const { streamContent, reportProgress } = context;
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
    const forgeClient = new ForgeClient(FORGE_URL);
    // Step 1.5: Check for existing session (Phase 2: Session reuse)
    const existingSession = session_manager_js_1.sessionManager.getSession('wish', PROJECT_ID);
    if (existingSession) {
        // Reuse existing session via follow-up
        await streamContent({
            type: 'text',
            text: `🔄 Reusing existing wish session...\n` +
                `   Task: ${existingSession.taskId}\n` +
                `   Attempt: ${existingSession.attemptId}\n\n`
        });
        try {
            await forgeClient.followUpTaskAttempt(existingSession.attemptId, `Follow-up wish request:\nGitHub Issue: #${args.github_issue}\nFeature: ${args.feature}`);
            await streamContent({
                type: 'text',
                text: `✅ Follow-up sent to existing session\n\n`
            });
            // Update session last used timestamp (already done by sessionManager.getSession)
            // Return existing session URL
            const { shortUrl } = await (0, url_shortener_js_1.shortenUrl)(existingSession.url, {
                apiKey: (0, url_shortener_js_1.getApiKeyFromEnv)()
            });
            await streamContent({
                type: 'text',
                text: `🌐 Monitor Progress:\n${shortUrl || existingSession.url}\n\n` +
                    `💡 Genie Tips:\n` +
                    `  - This is THE wish session (reused from previous call)\n` +
                    `  - All wish work happens in this single task\n` +
                    `  - Session maintained for conversation continuity\n`
            });
            return;
        }
        catch (error) {
            // Follow-up failed, clear session and create new one
            await streamContent({
                type: 'text',
                text: `⚠️  Follow-up failed: ${error.message}\n` +
                    `   Creating new session...\n\n`
            });
            session_manager_js_1.sessionManager.clearSession('wish', PROJECT_ID);
        }
    }
    // Step 2: Create Forge task (new session)
    await streamContent({
        type: 'text',
        text: `📝 Creating new Forge task...\n`
    });
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
                variant: 'wish'
            },
            base_branch: 'dev'
        });
    }
    catch (error) {
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
    // Step 2.5: Update task status to 'agent' (hide from main Kanban, show in widget)
    await streamContent({
        type: 'text',
        text: `📊 Updating task status...\n`
    });
    try {
        await forgeClient.updateTask(PROJECT_ID, taskId, {
            status: 'agent'
        });
        await streamContent({
            type: 'text',
            text: `✅ Task status: agent (visible in wish widget only)\n\n`
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
    // Step 2.6: Store new session for reuse (Phase 2)
    const fullUrl = `${FORGE_URL}/projects/${PROJECT_ID}/tasks/${taskId}/attempts/${attemptId}?view=diffs`;
    session_manager_js_1.sessionManager.setSession('wish', PROJECT_ID, {
        taskId,
        attemptId,
        url: fullUrl,
        created: new Date().toISOString()
    });
    await streamContent({
        type: 'text',
        text: `💾 Session stored for reuse\n\n`
    });
    // Step 3: Subscribe to tasks WebSocket stream
    await streamContent({
        type: 'text',
        text: `📊 Watching progress via WebSocket...\n\n`
    });
    const wsUrl = forgeClient.getTasksStreamUrl(PROJECT_ID);
    let statusUpdateCount = 0;
    const subscriptionId = websocket_manager_js_1.wsManager.subscribe(wsUrl, async (data) => {
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
    }, async (error) => {
        await streamContent({
            type: 'text',
            text: `⚠️  WebSocket error: ${error.message}\n`
        });
    });
    // Wait a bit for task to initialize and stream some updates
    await new Promise(resolve => setTimeout(resolve, 5000));
    // Unsubscribe from WebSocket
    websocket_manager_js_1.wsManager.unsubscribe(subscriptionId);
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
    // Step 5: Output human-visible URL (shortened if service available)
    const { shortUrl } = await (0, url_shortener_js_1.shortenUrl)(fullUrl, {
        apiKey: (0, url_shortener_js_1.getApiKeyFromEnv)()
    });
    await streamContent({
        type: 'text',
        text: `🌐 Monitor Progress:\n` +
            `${shortUrl || fullUrl}\n\n`
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
