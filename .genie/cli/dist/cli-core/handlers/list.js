"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createListHandler = createListHandler;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const agent_resolver_1 = require("../../lib/agent-resolver");
const forge_executor_1 = require("../../lib/forge-executor");
const forge_helpers_1 = require("../../lib/forge-helpers");
const markdown_formatter_1 = require("../../lib/markdown-formatter");
const utils_1 = require("../../lib/utils");
const COLLECTIVE_MARKER = 'AGENTS.md';
function createListHandler(ctx) {
    return async (parsed) => {
        const [targetRaw] = parsed.commandArgs;
        const target = (targetRaw || 'collectives').toLowerCase();
        if (target === 'collectives' || target === 'agents') {
            return listCollectivesView(ctx, parsed);
        }
        if (target === 'workflows') {
            return listWorkflowsView(ctx, parsed);
        }
        if (target === 'skills') {
            return listSkillsView(ctx, parsed);
        }
        if (target === 'sessions') {
            const forgeExecutor = (0, forge_executor_1.createForgeExecutor)();
            let forgeAvailable = true;
            try {
                // Skip config.forge.executors - incompatible format, Forge loads from its own config
                await forgeExecutor.syncProfiles();
            }
            catch (error) {
                forgeAvailable = false;
                const reason = (0, forge_helpers_1.describeForgeError)(error);
                ctx.recordRuntimeWarning(`Forge sync failed: ${reason}`);
            }
            if (forgeAvailable) {
                try {
                    const sessions = await forgeExecutor.listSessions();
                    const markdown = (0, markdown_formatter_1.formatSessionList)(sessions.map((session) => ({
                        sessionId: session.id,
                        agent: session.agent,
                        status: session.status,
                        executor: [session.executor, session.variant].filter(Boolean).join('/'),
                        model: session.model || undefined,
                        started: session.created,
                        updated: session.updated
                    })));
                    await ctx.emitView(markdown, parsed.options);
                    return;
                }
                catch (error) {
                    forgeAvailable = false;
                    const reason = (0, forge_helpers_1.describeForgeError)(error);
                    ctx.recordRuntimeWarning(`Forge session listing failed: ${reason}`);
                }
            }
            const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
            const sessions = Object.entries(store.sessions || {}).map(([name, entry]) => ({
                sessionId: name,
                agent: entry.agent,
                status: entry.status || 'unknown',
                executor: [entry.executor, entry.executorVariant].filter(Boolean).join('/'),
                model: entry.model || undefined,
                started: entry.created,
                updated: entry.lastUsed
            }));
            const markdown = (0, markdown_formatter_1.formatSessionList)(sessions);
            const fallbackLines = [
                '⚠️ Forge backend unreachable. Showing cached sessions from `.genie/state/agents/sessions.json`.',
                forge_helpers_1.FORGE_RECOVERY_HINT,
                '',
                markdown.trim()
            ];
            await ctx.emitView(fallbackLines.join('\n'), parsed.options);
            return;
        }
        throw new Error(`Unknown list target '${targetRaw}'. Try 'agents', 'workflows', 'skills', or 'sessions'.`);
    };
}
async function listCollectivesView(ctx, parsed) {
    const agents = (0, agent_resolver_1.listAgents)();
    const lines = [];
    lines.push(`# Genie Agents (${agents.length} total)\n`);
    // Group by collective
    const byCollective = new Map();
    agents.forEach(agent => {
        const key = agent.collective || 'root';
        if (!byCollective.has(key))
            byCollective.set(key, []);
        byCollective.get(key).push(agent);
    });
    // Sort collectives
    const sorted = Array.from(byCollective.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    sorted.forEach(([collective, items]) => {
        lines.push(`## ${collective} (${items.length})`);
        items
            .sort((a, b) => a.id.localeCompare(b.id))
            .forEach(agent => {
            const desc = agent.meta?.description || agent.meta?.summary || '';
            const shortDesc = desc ? ` - ${(0, utils_1.truncateText)(desc.replace(/\s+/g, ' ').trim(), 60)}` : '';
            lines.push(`  ${agent.id}${shortDesc}`);
        });
        lines.push('');
    });
    lines.push('Usage: `genie run <agent-id> "<prompt>"`');
    await ctx.emitView(lines.join('\n'), parsed.options);
}
function listMarkdownDocs(dir, exclude = new Set()) {
    if (!fs_1.default.existsSync(dir) || !fs_1.default.statSync(dir).isDirectory())
        return [];
    return fs_1.default
        .readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.md') && !exclude.has(entry.name))
        .map(entry => entry.name.replace(/\.md$/i, ''))
        .sort((a, b) => a.localeCompare(b));
}
async function listWorkflowsView(ctx, parsed) {
    const workspaceRoot = path_1.default.join(process.cwd(), '.genie');
    const globalWorkflowsDir = path_1.default.join(workspaceRoot, 'workflows');
    const globalWorkflows = listMarkdownDocs(globalWorkflowsDir);
    const collectives = (0, agent_resolver_1.listCollectives)();
    const ordered = collectives.slice().sort((a, b) => a.collective.localeCompare(b.collective));
    const lines = [];
    lines.push(`# Workflows Index`);
    lines.push('');
    lines.push(`## Global (.genie/workflows/)`);
    lines.push(globalWorkflows.length ? `- ${globalWorkflows.join('\n- ')}` : '_None_');
    lines.push('');
    ordered.forEach(info => {
        const wfDir = path_1.default.join(info.root, 'workflows');
        const items = listMarkdownDocs(wfDir);
        lines.push(`## ${info.collective} (${path_1.default.relative(workspaceRoot, wfDir)})`);
        lines.push(items.length ? `- ${items.join('\n- ')}` : '_None_');
        lines.push('');
    });
    await ctx.emitView(lines.join('\n'), parsed.options);
}
async function listSkillsView(ctx, parsed) {
    const workspaceRoot = path_1.default.join(process.cwd(), '.genie');
    const globalSkillsDir = path_1.default.join(workspaceRoot, 'skills');
    const globalSkills = listMarkdownDocs(globalSkillsDir);
    const collectives = (0, agent_resolver_1.listCollectives)();
    const ordered = collectives.slice().sort((a, b) => a.collective.localeCompare(b.collective));
    const lines = [];
    lines.push(`# Skills Index`);
    lines.push('');
    lines.push(`## Global (.genie/skills/)`);
    lines.push(globalSkills.length ? `- ${globalSkills.join('\n- ')}` : '_None_');
    lines.push('');
    ordered.forEach(info => {
        const skillsDir = path_1.default.join(info.root, 'skills');
        const items = listMarkdownDocs(skillsDir);
        lines.push(`## ${info.collective} (${path_1.default.relative(workspaceRoot, skillsDir)})`);
        lines.push(items.length ? `- ${items.join('\n- ')}` : '_None_');
        lines.push('');
    });
    await ctx.emitView(lines.join('\n'), parsed.options);
}
