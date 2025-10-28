#!/usr/bin/env node
"use strict";
/**
 * Genie MCP Server - Official SDK Implementation
 *
 * Provides Model Context Protocol access to Genie agent orchestration.
 * Tools integrate with CLI via subprocess execution (shell-out pattern).
 *
 * TECHNICAL DEBT: Handler integration blocked by type signature mismatch:
 * - CLI handlers return Promise<void> (side-effect based via emitView)
 * - MCP tools need Promise<data> (pure functions returning structured data)
 *
 * Future improvement (v0.2.0): Refactor CLI handlers to return data directly,
 * enabling zero-duplication integration. Current implementation ensures 100%
 * behavioral equivalence with CLI while maintaining functional MCP server.
 *
 * Build status: ✅ CLI compiles (0 errors), ✅ MCP compiles (0 errors)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const zod_1 = require("zod");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const display_transform_js_1 = require("./lib/display-transform.js");
// Import WebSocket-native tools (MVP Phase 6)
const wish_tool_js_1 = require("./tools/wish-tool.js");
const forge_tool_js_1 = require("./tools/forge-tool.js");
const review_tool_js_1 = require("./tools/review-tool.js");
const prompt_tool_js_1 = require("./tools/prompt-tool.js");
// Import neuron architecture tools (Phase 2)
const continue_task_tool_js_1 = require("./tools/continue-task-tool.js");
const create_subtask_tool_js_1 = require("./tools/create-subtask-tool.js");
// Import role detection
const role_detector_js_1 = require("./lib/role-detector.js");
// Import HTTP server for OAuth2 transport
const http_server_js_1 = require("./lib/http-server.js");
// Import process cleanup utilities
const process_cleanup_js_1 = require("./lib/process-cleanup.js");
// Import CLI executor utilities
const cli_executor_js_1 = require("./lib/cli-executor.js");
// Import server helper utilities (extracted per Amendment #10)
const server_helpers_js_1 = require("./lib/server-helpers.js");
// Import spell utilities (extracted per Amendment #10)
const spell_utils_js_1 = require("./lib/spell-utils.js");
const PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 8885;
const TRANSPORT = process.env.MCP_TRANSPORT || 'stdio';
const WORKSPACE_ROOT = (0, server_helpers_js_1.findWorkspaceRoot)();
// transformDisplayPath imported from ./lib/display-transform (single source of truth)
// listAgents() imported from ./lib/server-helpers.js
// loadForgeExecutor() imported from ./lib/server-helpers.js
// listSessions() imported from ./lib/server-helpers.js
// Helper: View session transcript (uses Forge API directly)
async function viewSession(taskId) {
    try {
        const mod = (0, server_helpers_js_1.loadForgeExecutor)();
        if (!mod || typeof mod.createForgeExecutor !== 'function') {
            return {
                status: 'error',
                transcript: null,
                error: 'Forge executor unavailable (did you build the CLI?)'
            };
        }
        const forgeExecutor = mod.createForgeExecutor();
        // Get task details to find latest attempt
        const { ForgeClient } = require('../../../src/lib/forge-client.js');
        const forge = new ForgeClient(process.env.FORGE_BASE_URL || 'http://localhost:8887', process.env.FORGE_TOKEN);
        // Get task attempts for this task
        const attempts = await forge.listTaskAttempts(taskId);
        if (!Array.isArray(attempts) || !attempts.length) {
            return {
                status: 'error',
                transcript: null,
                error: `No attempts found for task ${taskId}`
            };
        }
        // Get latest attempt
        const latestAttempt = attempts[attempts.length - 1];
        const attemptId = latestAttempt.id;
        // Get attempt status
        const attemptDetails = await forge.getTaskAttempt(attemptId);
        const status = attemptDetails.status || 'unknown';
        // Get execution logs
        const processes = await forge.listExecutionProcesses(attemptId);
        let transcript = null;
        if (processes.length > 0) {
            const latestProcess = processes[processes.length - 1];
            transcript = latestProcess.output || latestProcess.logs || null;
        }
        return {
            status,
            transcript,
        };
    }
    catch (error) {
        return {
            status: 'error',
            transcript: null,
            error: error.message || 'Unknown error viewing session'
        };
    }
}
// Helper: Get Genie version from package.json
// getGenieVersion(), getVersionHeader(), syncAgentProfilesToForge() imported from ./lib/server-helpers.js
// loadOAuth2Config() imported from ./lib/server-helpers.js
// Load OAuth2 config for HTTP transport
const oauth2Config = (0, server_helpers_js_1.loadOAuth2Config)();
const serverUrl = `http://localhost:${PORT}`;
// Initialize MCP Server using official SDK
const server = new mcp_js_1.McpServer({
    name: 'genie',
    version: (0, server_helpers_js_1.getGenieVersion)(),
}, {
    capabilities: {
        logging: {},
        tools: {}
    }
});
// Tool: list_agents - Discover available agents
server.tool('list_agents', 'List all available Genie agents with their capabilities and descriptions. Use this first to discover which agents can help with your task.', async () => {
    const agents = (0, server_helpers_js_1.listAgents)();
    if (agents.length === 0) {
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + 'No agents found in .genie/code/agents or .genie/create/agents directories.' }] };
    }
    let response = (0, server_helpers_js_1.getVersionHeader)() + `Found ${agents.length} available agents:\n\n`;
    // Group by folder
    const grouped = {};
    agents.forEach(agent => {
        const key = agent.folder || 'core';
        if (!grouped[key])
            grouped[key] = [];
        grouped[key].push(agent);
    });
    Object.entries(grouped).forEach(([folder, folderAgents]) => {
        response += `**${folder}:**\n`;
        folderAgents.forEach(agent => {
            response += `  • ${agent.displayId}`;
            if (agent.name !== agent.displayId)
                response += ` (${agent.name})`;
            if (agent.description)
                response += ` - ${agent.description}`;
            response += '\n';
        });
        response += '\n';
    });
    response += '\nUse the "run" tool with an agent id and prompt to start an agent session.';
    return { content: [{ type: 'text', text: response }] };
});
// Tool: list_sessions - View active and recent sessions
server.tool('list_sessions', 'List active and recent Genie agent sessions. Shows session names, agents, status, and timing. Use this to find sessions to resume or view.', async () => {
    const sessions = await (0, server_helpers_js_1.listSessions)();
    if (sessions.length === 0) {
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + 'No sessions found. Start a new session with the "run" tool.' }] };
    }
    let response = (0, server_helpers_js_1.getVersionHeader)() + `Found ${sessions.length} session(s):\n\n`;
    sessions.forEach((session, index) => {
        const { displayId } = (0, display_transform_js_1.transformDisplayPath)(session.agent);
        response += `${index + 1}. **${session.id}** (${session.name})\n`;
        response += `   Agent: ${displayId}\n`;
        response += `   Status: ${session.status}\n`;
        response += `   Created: ${session.created}\n`;
        response += `   Last Used: ${session.lastUsed}\n\n`;
    });
    response += 'Use "view" with the session ID (e.g., "c74111b4-...") to see transcript or "resume" to continue a session.';
    return { content: [{ type: 'text', text: response }] };
});
// Tool: run - Start a new agent session
server.tool('run', 'Start a new Genie agent session. Choose an agent (use list_agents first) and provide a detailed prompt describing the task. The agent will analyze, plan, or implement based on its specialization.', {
    agent: zod_1.z.string().describe('Agent ID to run (e.g., "plan", "implementor", "debug"). Get available agents from list_agents tool.'),
    prompt: zod_1.z.string().describe('Detailed task description for the agent. Be specific about goals, context, and expected outcomes. Agents work best with clear, actionable prompts.'),
    name: zod_1.z.string().optional().describe('Friendly session name for easy identification (e.g., "bug-102-fix", "auth-feature"). If omitted, auto-generates: "{agent}-{timestamp}".')
}, async (args) => {
    try {
        // Agent alias mapping (Fix Bug #1: plan → wish/blueprint)
        const AGENT_ALIASES = {
            'plan': 'wish/blueprint',
            'discover': 'wish/discovery',
            'requirements': 'wish/requirements',
            'align': 'wish/alignment'
        };
        // Resolve alias if exists
        const resolvedAgent = AGENT_ALIASES[args.agent] || args.agent;
        // Early validation: Check if agent exists BEFORE trying to run
        const availableAgents = (0, server_helpers_js_1.listAgents)();
        const agentExists = availableAgents.some(a => a.id === resolvedAgent || a.displayId === resolvedAgent);
        if (!agentExists) {
            // Fast fail with helpful error message
            const suggestions = availableAgents
                .filter(a => a.id.includes(args.agent) || a.displayId.includes(args.agent))
                .slice(0, 3)
                .map(a => `  • ${a.displayId}`)
                .join('\n');
            const errorMsg = `❌ **Agent not found:** '${args.agent}'\n\n` +
                (suggestions ? `Did you mean:\n${suggestions}\n\n` : '') +
                `💡 Use list_agents tool to see all available agents.`;
            return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + errorMsg }] };
        }
        // Use resolved agent for CLI invocation
        const cliArgs = ['run', resolvedAgent];
        if (args.name?.length) {
            cliArgs.push('--name', args.name);
        }
        if (args.prompt?.length) {
            cliArgs.push(args.prompt);
        }
        const { stdout, stderr } = await (0, cli_executor_js_1.runCliCommand)(WORKSPACE_ROOT, cliArgs, 120000);
        const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');
        const { displayId } = (0, display_transform_js_1.transformDisplayPath)(resolvedAgent);
        const aliasNote = AGENT_ALIASES[args.agent] ? ` (alias: ${args.agent} → ${resolvedAgent})` : '';
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + `Started agent session:\nAgent: ${displayId}${aliasNote}\n\n${output}\n\nUse list_sessions to see the session ID, then use view/resume/stop as needed.` }] };
    }
    catch (error) {
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + (0, cli_executor_js_1.formatCliFailure)('start agent session', error) }] };
    }
});
// Tool: resume - Continue an existing session
server.tool('resume', 'Resume an existing agent session with a follow-up prompt. Use this to continue conversations, provide additional context, or ask follow-up questions to an agent.', {
    sessionId: zod_1.z.string().describe('Session name to resume (get from list_sessions tool). Example: "146-session-name-architecture"'),
    prompt: zod_1.z.string().describe('Follow-up message or question for the agent. Build on the previous conversation context.')
}, async (args) => {
    try {
        const cliArgs = ['resume', args.sessionId];
        if (args.prompt?.length) {
            cliArgs.push(args.prompt);
        }
        const { stdout, stderr } = await (0, cli_executor_js_1.runCliCommand)(WORKSPACE_ROOT, cliArgs, 120000);
        const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + `Resumed session ${args.sessionId}:\n\n${output}` }] };
    }
    catch (error) {
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + (0, cli_executor_js_1.formatCliFailure)('resume session', error) }] };
    }
});
// Tool: view - View session transcript
server.tool('view', 'View the transcript of an agent session. Shows the conversation history, agent outputs, and any artifacts generated. Use full=true for complete transcript or false for recent messages only.', {
    sessionId: zod_1.z.string().describe('Task ID to view (get from list_sessions tool). Example: "c74111b4-1a81-49d9-b7d3-d57e31926710"'),
    full: zod_1.z.boolean().optional().default(false).describe('Show full transcript (true) or recent messages only (false). Default: false.')
}, async (args) => {
    try {
        const result = await viewSession(args.sessionId);
        if (result.error) {
            return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + `❌ Error viewing session:\n\n${result.error}` }] };
        }
        let response = (0, server_helpers_js_1.getVersionHeader)();
        response += `**Task:** ${args.sessionId}\n`;
        response += `**Status:** ${result.status}\n\n`;
        if (result.transcript) {
            const lines = result.transcript.split('\n');
            const displayLines = args.full ? lines : lines.slice(-50); // Show last 50 lines if not full
            response += `**Transcript:**\n\`\`\`\n${displayLines.join('\n')}\n\`\`\``;
        }
        else {
            response += `**Transcript:** (No logs available yet)`;
        }
        return { content: [{ type: 'text', text: response }] };
    }
    catch (error) {
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + `❌ Error: ${error.message}` }] };
    }
});
// Tool: stop - Terminate a running session
server.tool('stop', 'Stop a running agent session. Use this to terminate long-running agents or cancel sessions that are no longer needed. The session state is preserved for later viewing.', {
    sessionId: zod_1.z.string().describe('Session name to stop (get from list_sessions tool). Example: "146-session-name-architecture"')
}, async (args) => {
    try {
        const { stdout, stderr } = await (0, cli_executor_js_1.runCliCommand)(WORKSPACE_ROOT, ['stop', args.sessionId], 30000);
        const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + `Stopped session ${args.sessionId}:\n\n${output}` }] };
    }
    catch (error) {
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + (0, cli_executor_js_1.formatCliFailure)('stop session', error) }] };
    }
});
// Helper: List all spell files in a directory recursively
// listSpellsInDir(), readSpellContent() imported from ./lib/spell-utils.js
// Tool: list_spells - Discover available spells
server.tool('list_spells', 'List all available Genie spells (reusable knowledge patterns). Returns spells from .genie/spells/ (global), .genie/code/spells/ (code-specific), and .genie/create/spells/ (create-specific).', async () => {
    // Note: Scope parameter removed - always returns all spells for simplicity (avoids MCP schema validation issues)
    const scope = 'all';
    const result = {};
    // Global spells
    if (scope === 'all' || scope === 'global') {
        const globalSpellsDir = path_1.default.join(WORKSPACE_ROOT, '.genie', 'spells');
        result.global = (0, spell_utils_js_1.listSpellsInDir)(globalSpellsDir);
    }
    // Code spells
    if (scope === 'all' || scope === 'code') {
        const codeSpellsDir = path_1.default.join(WORKSPACE_ROOT, '.genie', 'code', 'spells');
        result.code = (0, spell_utils_js_1.listSpellsInDir)(codeSpellsDir);
    }
    // Create spells
    if (scope === 'all' || scope === 'create') {
        const createSpellsDir = path_1.default.join(WORKSPACE_ROOT, '.genie', 'create', 'spells');
        result.create = (0, spell_utils_js_1.listSpellsInDir)(createSpellsDir);
    }
    // Format output
    let output = (0, server_helpers_js_1.getVersionHeader)() + '# Genie Spells\n\n';
    if (result.global) {
        output += `## Global Spells (.genie/spells/) - ${result.global.length} spells\n`;
        output += 'Universal patterns applicable to all collectives:\n\n';
        for (const spell of result.global) {
            output += `- **${spell.name}** - \`${spell.path}\`\n`;
        }
        output += '\n';
    }
    if (result.code) {
        output += `## Code Spells (.genie/code/spells/) - ${result.code.length} spells\n`;
        output += 'Code-specific patterns for technical execution:\n\n';
        for (const spell of result.code) {
            output += `- **${spell.name}** - \`${spell.path}\`\n`;
        }
        output += '\n';
    }
    if (result.create) {
        output += `## Create Spells (.genie/create/spells/) - ${result.create.length} spells\n`;
        output += 'Create-specific patterns for creative work:\n\n';
        for (const spell of result.create) {
            output += `- **${spell.name}** - \`${spell.path}\`\n`;
        }
        output += '\n';
    }
    const totalCount = (result.global?.length || 0) + (result.code?.length || 0) + (result.create?.length || 0);
    output += `\n**Total:** ${totalCount} spells\n`;
    return { content: [{ type: 'text', text: output }] };
});
// normalizeSpellPath() imported from ./lib/spell-utils.js
// Tool: read_spell - Read specific spell content
server.tool('read_spell', 'Read the full content of a specific spell. Returns the spell content after the frontmatter (---). Use list_spells first to see available spells. Supports multiple path formats: "spells/learn.md", ".genie/spells/learn.md", "code/spells/debug.md", or just "learn" (searches all directories).', {
    spell_path: zod_1.z.string().describe('Path to spell file. Flexible formats supported: "spells/learn.md" (recommended), ".genie/spells/learn.md" (auto-strips .genie/), "code/spells/debug.md", or just "learn" (auto-searches and adds .md extension)')
}, async (args) => {
    const normalizedPath = (0, spell_utils_js_1.normalizeSpellPath)(args.spell_path);
    const fullPath = path_1.default.join(WORKSPACE_ROOT, '.genie', normalizedPath);
    try {
        const content = (0, spell_utils_js_1.readSpellContent)(fullPath);
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + `# Spell: ${normalizedPath}\n\n${content}` }] };
    }
    catch (error) {
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + `Error reading spell: ${error.message}` }] };
    }
});
// Workflows have been merged into spells - no separate workflow tools needed
// Tool: get_workspace_info - Get workspace metadata (lean self-awareness data)
server.tool('get_workspace_info', 'Get essential workspace info for agent self-awareness: project name, tech stack, current branch, and available commands. Lightweight context for agents to understand their environment.', async () => {
    try {
        // Extract essential data only (no bloat)
        const workspaceInfo = {};
        // 1. Project name (from package.json or directory name)
        const packageJsonPath = path_1.default.join(WORKSPACE_ROOT, 'package.json');
        if (fs_1.default.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs_1.default.readFileSync(packageJsonPath, 'utf-8'));
            workspaceInfo.project = pkg.name || path_1.default.basename(WORKSPACE_ROOT);
        }
        else {
            workspaceInfo.project = path_1.default.basename(WORKSPACE_ROOT);
        }
        // 2. Tech stack (runtime, language, package manager)
        workspaceInfo.techStack = {};
        if (fs_1.default.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs_1.default.readFileSync(packageJsonPath, 'utf-8'));
            workspaceInfo.techStack.runtime = 'Node.js';
            workspaceInfo.techStack.packageManager = fs_1.default.existsSync(path_1.default.join(WORKSPACE_ROOT, 'pnpm-lock.yaml')) ? 'pnpm' :
                fs_1.default.existsSync(path_1.default.join(WORKSPACE_ROOT, 'yarn.lock')) ? 'yarn' : 'npm';
            // Detect language from dependencies
            if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
                workspaceInfo.techStack.language = 'TypeScript';
            }
            else {
                workspaceInfo.techStack.language = 'JavaScript';
            }
        }
        // 3. Current branch (from git)
        try {
            const { execSync } = require('child_process');
            const branch = execSync('git branch --show-current', { cwd: WORKSPACE_ROOT, encoding: 'utf-8' }).trim();
            workspaceInfo.currentBranch = branch || 'unknown';
        }
        catch {
            workspaceInfo.currentBranch = 'unknown';
        }
        // 4. Available commands (from package.json scripts)
        workspaceInfo.commands = {};
        if (fs_1.default.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs_1.default.readFileSync(packageJsonPath, 'utf-8'));
            if (pkg.scripts) {
                // Only include common/useful commands (build, test, lint)
                const relevantScripts = ['build', 'test', 'lint', 'dev', 'start'];
                for (const script of relevantScripts) {
                    if (pkg.scripts[script]) {
                        workspaceInfo.commands[script] = `${workspaceInfo.techStack.packageManager} run ${script}`;
                    }
                }
                // Also include genie-specific commands
                Object.keys(pkg.scripts).forEach(script => {
                    if (script.includes('genie') || script.includes('test:')) {
                        workspaceInfo.commands[script] = `${workspaceInfo.techStack.packageManager} run ${script}`;
                    }
                });
            }
        }
        // Format lean output
        let output = (0, server_helpers_js_1.getVersionHeader)();
        output += `**Project:** ${workspaceInfo.project}\n`;
        output += `**Branch:** ${workspaceInfo.currentBranch}\n`;
        output += `**Tech Stack:** ${workspaceInfo.techStack.language} + ${workspaceInfo.techStack.runtime} (${workspaceInfo.techStack.packageManager})\n\n`;
        if (Object.keys(workspaceInfo.commands).length > 0) {
            output += `**Available Commands:**\n`;
            Object.entries(workspaceInfo.commands).forEach(([name, cmd]) => {
                output += `- ${name}: \`${cmd}\`\n`;
            });
        }
        return { content: [{ type: 'text', text: output }] };
    }
    catch (error) {
        return { content: [{ type: 'text', text: (0, server_helpers_js_1.getVersionHeader)() + `Error gathering workspace info: ${error.message}` }] };
    }
});
// ============================================================================
// WEBSOCKET-NATIVE TOOLS (MVP Phase 6) - Real-time streaming + git validation
// ============================================================================
// Tool: create_wish - Create wish with GitHub issue enforcement (WebSocket streaming)
server.tool('create_wish', 'Create a wish with GitHub issue enforcement (Amendment 1) and real-time progress via WebSocket. Git working tree must be clean and pushed.', {
    feature: zod_1.z.string().describe('What you want to build'),
    github_issue: zod_1.z.number().describe('GitHub issue number (required per Amendment 1)')
}, {
    streamingHint: true
}, async (args, extra) => {
    // Use official MCP SDK logging for real-time streaming
    await (0, wish_tool_js_1.executeWishTool)(args, {
        streamContent: async (chunk) => {
            // Stream content via MCP logging notifications
            await server.sendLoggingMessage({
                level: "info",
                data: chunk
            }, extra.sessionId);
        },
        reportProgress: async (current, total) => {
            // Report progress via MCP logging notifications
            const message = `Progress: ${current}/${total}`;
            await server.sendLoggingMessage({
                level: "info",
                data: message
            }, extra.sessionId);
            // Also send MCP progress notification if client provided progressToken
            if (extra._meta?.progressToken) {
                await extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                        progressToken: extra._meta.progressToken,
                        progress: current,
                        total: total,
                        message: message
                    }
                });
            }
        }
    });
    return { content: [{ type: 'text', text: 'Wish creation completed. Check the logs above for details.' }] };
});
// Tool: run_forge - Run Forge task with agent and stream execution (WebSocket diff streaming)
server.tool('run_forge', 'Kick off a Forge task with specified agent and stream live code changes via WebSocket. Git working tree must be clean and pushed.', {
    prompt: zod_1.z.string().describe('Task prompt (e.g., "Fix bug in login flow")'),
    agent: zod_1.z.string().describe('Agent to use (e.g., "implementor", "tests", "polish")'),
    project_id: zod_1.z.string().optional().describe('Project ID (defaults to current Genie project)')
}, {
    streamingHint: true
}, async (args, extra) => {
    // Use official MCP SDK logging for real-time streaming
    await (0, forge_tool_js_1.executeForgeTool)(args, {
        streamContent: async (chunk) => {
            // Stream content via MCP logging notifications
            await server.sendLoggingMessage({
                level: "info",
                data: chunk
            }, extra.sessionId);
        },
        reportProgress: async (current, total) => {
            // Report progress via MCP logging notifications
            const message = `Progress: ${current}/${total}`;
            await server.sendLoggingMessage({
                level: "info",
                data: message
            }, extra.sessionId);
            // Also send MCP progress notification if client provided progressToken
            if (extra._meta?.progressToken) {
                await extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                        progressToken: extra._meta.progressToken,
                        progress: current,
                        total: total,
                        message: message
                    }
                });
            }
        }
    });
    return { content: [{ type: 'text', text: 'Forge task completed. Check the logs above for details.' }] };
});
// Tool: run_review - Review wish with agent and stream feedback (WebSocket log streaming)
server.tool('run_review', 'Review a wish document with an agent and stream live feedback via WebSocket. Git working tree must be clean and pushed.', {
    wish_name: zod_1.z.string().describe('Wish name (e.g., "genie-mcp-mvp")'),
    agent: zod_1.z.string().optional().default('review').describe('Agent to use (default: "review")'),
    project_id: zod_1.z.string().optional().describe('Project ID (defaults to current Genie project)')
}, {
    streamingHint: true
}, async (args, extra) => {
    // Use official MCP SDK logging for real-time streaming
    await (0, review_tool_js_1.executeReviewTool)(args, {
        streamContent: async (chunk) => {
            // Stream content via MCP logging notifications
            await server.sendLoggingMessage({
                level: "info",
                data: chunk
            }, extra.sessionId);
        },
        reportProgress: async (current, total) => {
            // Report progress via MCP logging notifications
            const message = `Progress: ${current}/${total}`;
            await server.sendLoggingMessage({
                level: "info",
                data: message
            }, extra.sessionId);
            // Also send MCP progress notification if client provided progressToken
            if (extra._meta?.progressToken) {
                await extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                        progressToken: extra._meta.progressToken,
                        progress: current,
                        total: total,
                        message: message
                    }
                });
            }
        }
    });
    return { content: [{ type: 'text', text: 'Review completed. Check the logs above for details.' }] };
});
// Tool: transform_prompt - Synchronous prompt transformer (no worktree, no git validation)
server.tool('transform_prompt', 'Transform/enhance a prompt using an agent synchronously. Runs in current workspace (no worktree). Modern equivalent of old "background off" mode.', {
    prompt: zod_1.z.string().describe('Prompt to transform/enhance (e.g., "Help me write a better prompt for implementing dark mode")'),
    agent: zod_1.z.string().optional().default('prompt').describe('Agent to use for transformation (default: "prompt")')
}, {
    readOnlyHint: true
}, async (args, extra) => {
    // Use official MCP SDK logging for real-time streaming
    await (0, prompt_tool_js_1.executePromptTool)(args, {
        streamContent: async (chunk) => {
            // Stream content via MCP logging notifications
            await server.sendLoggingMessage({
                level: "info",
                data: chunk
            }, extra.sessionId);
        }
    });
    return { content: [{ type: 'text', text: 'Prompt transformation completed. Check the logs above for details.' }] };
});
// Tool: continue_task - Send follow-up work to existing task
server.tool('continue_task', 'Send follow-up work to an existing task attempt. Used primarily by master orchestrators to receive new work.', {
    attempt_id: zod_1.z.string().describe('Task attempt ID to send work to'),
    prompt: zod_1.z.string().describe('Follow-up prompt with new work')
}, async (args, extra) => {
    await (0, continue_task_tool_js_1.executeContinueTaskTool)(args, {
        streamContent: async (chunk) => {
            await server.sendLoggingMessage({
                level: "info",
                data: chunk
            }, extra.sessionId);
        }
    });
    return { content: [{ type: 'text', text: 'Follow-up sent successfully. Check the logs above for details.' }] };
});
// Tool: create_subtask - Create child task under master orchestrator
server.tool('create_subtask', 'Create a child task under a master orchestrator. Allows masters to delegate work as subtasks.', {
    parent_attempt_id: zod_1.z.string().describe('Parent task attempt ID (the master orchestrator)'),
    title: zod_1.z.string().describe('Subtask title'),
    prompt: zod_1.z.string().describe('Subtask prompt/description'),
    executor: zod_1.z.string().optional().default('CLAUDE_CODE:DEFAULT').describe('Executor variant (e.g., "CLAUDE_CODE:wish", "CLAUDE_CODE:DEFAULT")')
}, async (args, extra) => {
    await (0, create_subtask_tool_js_1.executeCreateSubtaskTool)(args, {
        streamContent: async (chunk) => {
            await server.sendLoggingMessage({
                level: "info",
                data: chunk
            }, extra.sessionId);
        }
    });
    return { content: [{ type: 'text', text: 'Subtask created successfully. Check the logs above for details.' }] };
});
// ============================================================================
// DEPRECATED PROMPTS - Removed per Amendment: No Backwards Compatibility
// ============================================================================
// These prompts were removed because Genie does not maintain backwards compatibility.
// Users should use the new WebSocket-native tools instead:
//   - create_wish (replaces 'wish' prompt)
//   - run_forge (replaces 'forge' prompt)
//   - run_review (replaces 'review' prompt)
//   - transform_prompt (replaces 'prompt' prompt)
// Detect agent role (neuron architecture)
const roleInfo = (0, role_detector_js_1.detectGenieRole)();
const readOnly = (0, role_detector_js_1.isReadOnlyFilesystem)(roleInfo.role);
// Debug mode detection
const debugMode = process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1';
// ============================================================================
// CLEANUP HANDLERS - Prevent zombie processes (Fix: MCP server proliferation)
// ============================================================================
let isShuttingDown = false;
let serverConnection = null; // Store server connection for cleanup
/**
 * Keep the stdio transport alive until the connection explicitly closes.
 * Prevents Node from exiting immediately after startup (regression: MCP server
 * would launch and exit before Genie CLI could stay alive).
 */
function waitForStdioTransportShutdown(transport) {
    return new Promise((resolve) => {
        const previousOnClose = transport.onclose;
        const previousOnError = transport.onerror;
        const finalize = (reason) => {
            transport.onclose = previousOnClose;
            transport.onerror = previousOnError;
            if (debugMode) {
                console.error(`MCP stdio transport stopping (${reason})`);
            }
            resolve();
        };
        transport.onclose = () => {
            if (typeof previousOnClose === 'function') {
                previousOnClose();
            }
            finalize('close');
        };
        transport.onerror = (error) => {
            if (typeof previousOnError === 'function') {
                previousOnError(error);
            }
            finalize(`error: ${error instanceof Error ? error.message : String(error)}`);
        };
        // Ensure the stream remains in flowing mode so Node keeps the event loop alive.
        if (typeof process.stdin.resume === 'function') {
            process.stdin.resume();
        }
    });
}
async function gracefulShutdown(signal) {
    if (isShuttingDown)
        return;
    isShuttingDown = true;
    if (debugMode) {
        console.error(`\n📡 Received ${signal}, shutting down MCP server gracefully...`);
    }
    try {
        // Close server connection if exists
        if (serverConnection && typeof serverConnection.close === 'function') {
            await serverConnection.close();
        }
        // Give pending operations time to finish (max 2s)
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (debugMode) {
            console.error('✅ MCP server shutdown complete');
        }
    }
    catch (error) {
        console.error(`⚠️  Error during shutdown: ${error}`);
    }
    finally {
        process.exit(0);
    }
}
// Register signal handlers for all termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error(`❌ Uncaught exception: ${error.message}`);
    gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
    console.error(`❌ Unhandled rejection: ${reason}`);
    gracefulShutdown('unhandledRejection');
});
// Start server with configured transport (only log in debug mode)
if (debugMode) {
    // Verbose startup logs (debug mode only)
    console.error('Starting Genie MCP Server (MVP)...');
    console.error(`Version: ${(0, server_helpers_js_1.getGenieVersion)()}`);
    console.error(`Transport: ${TRANSPORT}`);
    console.error(`Role: ${roleInfo.role} (${roleInfo.confidence} confidence, method: ${roleInfo.method})`);
    if (readOnly) {
        console.error('🔒 Filesystem: READ-ONLY (master orchestrator)');
    }
    if (roleInfo.branch) {
        console.error(`Branch: ${roleInfo.branch}`);
    }
    if (roleInfo.worktree) {
        console.error(`Worktree: ${roleInfo.worktree}`);
    }
    // Dynamically count tools instead of hardcoding
    const coreTools = ['list_agents', 'list_sessions', 'run', 'resume', 'view', 'stop', 'list_spells', 'read_spell', 'get_workspace_info'];
    const wsTools = ['create_wish', 'run_forge', 'run_review', 'transform_prompt'];
    const neuronTools = ['continue_task', 'create_subtask'];
    const totalTools = coreTools.length + wsTools.length + neuronTools.length;
    console.error(`Tools: ${totalTools} total`);
    console.error(`  - ${coreTools.length} core (agents, sessions, spells, workspace)`);
    console.error(`  - ${wsTools.length} WebSocket-native (create_wish, run_forge, run_review, transform_prompt)`);
    console.error(`  - ${neuronTools.length} neuron (continue_task, create_subtask)`);
    console.error('WebSocket: Real-time streaming enabled');
    console.error('');
}
// Check for existing server and cleanup orphans
(async () => {
    // Cleanup orphaned servers on startup
    const cleanupResult = await (0, process_cleanup_js_1.cleanupStaleMcpServers)({
        killOrphans: true,
        dryRun: false
    });
    if (debugMode && cleanupResult.orphans > 0) {
        console.error(`🧹 Cleaned up ${cleanupResult.killed} orphaned MCP server(s)`);
        if (cleanupResult.failed > 0) {
            console.error(`⚠️  Failed to kill ${cleanupResult.failed} process(es)`);
        }
    }
    // Check if another server is already running for this workspace
    const serverStatus = (0, process_cleanup_js_1.isServerAlreadyRunning)(WORKSPACE_ROOT);
    if (serverStatus.running) {
        console.error(`⚠️  MCP server already running (PID ${serverStatus.pid})`);
        console.error('   Kill the existing server first or check for stale PID file');
        process.exit(1);
    }
    // Write PID file for this instance
    (0, process_cleanup_js_1.writePidFile)(WORKSPACE_ROOT);
})();
// Forge sync (always show, one line)
process.stderr.write('🔄 Syncing agent profiles...');
// Sync agents before starting server (async but non-blocking)
// Note: forge-executor.ts handles the completion message, so we don't print anything here
(0, server_helpers_js_1.syncAgentProfilesToForge)()
    .then(() => {
    // forge-executor.ts already printed the completion message
    // No additional output needed (prevents duplicate checkmarks)
})
    .catch(err => {
    console.warn(`\n⚠️  Agent sync failed: ${err.message}`);
});
(async () => {
    if (TRANSPORT === 'stdio') {
        const transport = new stdio_js_1.StdioServerTransport();
        await server.connect(transport);
        serverConnection = transport;
        console.error('✅ Server started successfully (stdio)');
        console.error('Ready for Claude Desktop or MCP Inspector connections');
        // Keep process alive until the transport signals shutdown.
        await waitForStdioTransportShutdown(transport);
    }
    else if (TRANSPORT === 'httpStream' || TRANSPORT === 'http') {
        // HTTP Stream transport with OAuth2 authentication
        if (!oauth2Config) {
            console.error('❌ OAuth2 config not found. Cannot start HTTP server.');
            console.error('Run `genie mcp configure` to set up OAuth2.');
            process.exit(1);
        }
        if (debugMode) {
            console.error(`Starting Genie MCP Server v${(0, server_helpers_js_1.getGenieVersion)()} (HTTP Stream)...`);
            console.error(`Port: ${PORT}`);
        }
        // Use http-server.ts (Express + SDK StreamableHTTPServerTransport + OAuth)
        await (0, http_server_js_1.startHttpServer)({
            server,
            oauth2Config,
            port: PORT,
            onReady: (url) => {
                // http-server.ts already prints the success message
                // This callback is kept for backwards compatibility
            }
        });
    }
    else {
        console.error(`❌ Unknown transport type: ${TRANSPORT}`);
        console.error('Set MCP_TRANSPORT to "stdio" or "httpStream"');
        process.exit(1);
    }
})().catch((error) => {
    console.error('❌ Server startup failed:', error);
    process.exit(1);
});
