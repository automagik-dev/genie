"use strict";
/**
 * Create Subtask Tool - Create child task under master orchestrator
 *
 * Allows master orchestrators to delegate work as subtasks.
 * Subtasks have parent relationship and can be used for complex work breakdown.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSubtaskToolSchema = void 0;
exports.executeCreateSubtaskTool = executeCreateSubtaskTool;
const zod_1 = require("zod");
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const task_title_formatter_js_1 = require("../lib/task-title-formatter.js");
const service_config_js_1 = require("../lib/service-config.js");
// Load ForgeClient from src/lib (resolves from package root)
// Compiled location: dist/mcp/tools/create-subtask-tool.js
// Target: src/lib/forge-client.js
const geniePackageRoot = path_1.default.resolve(__dirname, '../../..');
const ForgeClient = require(path_1.default.join(geniePackageRoot, 'src/lib/forge-client.js')).ForgeClient;
const { baseUrl: FORGE_URL } = (0, service_config_js_1.getForgeConfig)();
/**
 * Create subtask parameters
 */
exports.createSubtaskToolSchema = zod_1.z.object({
    parent_attempt_id: zod_1.z.string().describe('Parent task attempt ID (the master orchestrator)'),
    title: zod_1.z.string().describe('Subtask title'),
    prompt: zod_1.z.string().describe('Subtask prompt/description'),
    executor: zod_1.z.string().optional().default('CLAUDE_CODE:DEFAULT').describe('Executor variant (e.g., "CLAUDE_CODE:CODE_INSTALL", "CLAUDE_CODE:CODE_EXPLORE", "CLAUDE_CODE:MASTER"). Format: EXECUTOR:VARIANT where VARIANT is {COLLECTIVE}_{AGENT} like CODE_INSTALL or CREATE_INSTALL, or special variants like MASTER, DEFAULT.')
});
/**
 * Create subtask execution
 */
async function executeCreateSubtaskTool(args, context) {
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
        const result = await forgeClient.createAndStartTask({
            task: {
                project_id: projectId,
                title: (0, task_title_formatter_js_1.formatTaskTitle)('MCP', `Subtask: ${args.title}`),
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
    }
    catch (error) {
        const errorMsg = `❌ Failed to create subtask: ${error.message}\n`;
        fullOutput += errorMsg;
        await streamContent({
            type: 'text',
            text: errorMsg
        });
        return fullOutput;
    }
}
