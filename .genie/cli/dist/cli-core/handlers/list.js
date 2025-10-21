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
                await forgeExecutor.syncProfiles(ctx.config.forge?.executors);
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
    const allCollectives = (0, agent_resolver_1.listCollectives)();
    const activeCollectives = allCollectives.filter(info => info.agentsDir);
    const agents = (0, agent_resolver_1.listAgents)();
    const agentsByCollective = new Map();
    agents.forEach(agent => {
        const key = agent.collective || 'root';
        if (!agentsByCollective.has(key)) {
            agentsByCollective.set(key, []);
        }
        agentsByCollective.get(key).push(agent);
    });
    const workspaceRoot = path_1.default.join(process.cwd(), '.genie');
    const workspaceDocs = listMarkdownDocs(workspaceRoot, new Set([COLLECTIVE_MARKER]));
    const supportingDirs = ['skills', 'product', 'teams']
        .filter(dir => fs_1.default.existsSync(path_1.default.join(workspaceRoot, dir)) && fs_1.default.statSync(path_1.default.join(workspaceRoot, dir)).isDirectory());
    const orderedCollectives = activeCollectives.slice().sort((a, b) => a.collective.localeCompare(b.collective));
    const lines = [];
    lines.push(`# Genie Atlas`);
    lines.push(`Workspace: ${workspaceRoot}`);
    if (workspaceDocs.length) {
        lines.push(`Workspace docs: ${workspaceDocs.join(', ')}`);
    }
    if (supportingDirs.length) {
        lines.push(`Supporting directories (context only): ${supportingDirs.join(', ')}`);
    }
    lines.push('');
    lines.push(`Collectives: ${orderedCollectives.length} • Agents: ${agents.length}`);
    lines.push('');
    orderedCollectives.forEach(info => {
        const collectiveAgents = agentsByCollective.get(info.collective) || [];
        const summary = buildCollectiveSummary(info, collectiveAgents);
        lines.push(`## ${summary.title}`);
        lines.push(`Path: ${summary.relativePath}`);
        lines.push(`Counts → agents: ${summary.counts.agents} • workflows: ${summary.counts.workflows} • skills: ${summary.counts.skills} • teams: ${summary.counts.teams}`);
        if (summary.agentsDir)
            lines.push(`Agents dir: ${summary.agentsDir}`);
        if (summary.skillsDir && summary.skills.length)
            lines.push(`Skills dir: ${summary.skillsDir}`);
        if (summary.teamsDir && summary.teams.length)
            lines.push(`Teams dir: ${summary.teamsDir}`);
        const docLine = formatInlineList(summary.docs, 'Docs');
        if (docLine)
            lines.push(docLine);
        const skillLine = formatInlineList(summary.skills, 'Skills');
        if (skillLine)
            lines.push(skillLine);
        const teamLine = formatInlineList(summary.teams, 'Teams');
        if (teamLine)
            lines.push(teamLine);
        if (summary.agentTree.length) {
            summary.agentTree.forEach(line => lines.push(line));
        }
        else {
            lines.push('_No executable agents._');
        }
        summary.notes.forEach(note => lines.push(note));
        lines.push('');
    });
    lines.push('Tip: Use `genie run <collective>/<agent> "<prompt>"` to start sessions.');
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
function buildCollectiveSummary(info, agents) {
    const workspaceRoot = path_1.default.join(process.cwd(), '.genie');
    const relativePath = path_1.default.relative(workspaceRoot, info.root) || '.genie';
    // Discover documented workflows under <collective>/workflows (markdown)
    const workflowsDir = path_1.default.join(info.root, 'workflows');
    const workflows = fs_1.default.existsSync(workflowsDir) && fs_1.default.statSync(workflowsDir).isDirectory()
        ? listMarkdownDocs(workflowsDir)
        : [];
    const agentTree = agents.length ? renderTree(buildTree(agents)) : [];
    const skillsDir = path_1.default.join(info.root, 'skills');
    const skills = fs_1.default.existsSync(skillsDir) && fs_1.default.statSync(skillsDir).isDirectory()
        ? listMarkdownDocs(skillsDir)
        : [];
    const teamsDir = path_1.default.join(info.root, 'teams');
    const teams = [];
    if (fs_1.default.existsSync(teamsDir) && fs_1.default.statSync(teamsDir).isDirectory()) {
        const entries = fs_1.default.readdirSync(teamsDir, { withFileTypes: true });
        entries.forEach(entry => {
            if (entry.name.startsWith('.'))
                return;
            if (entry.isFile() && entry.name.endsWith('.md')) {
                teams.push(entry.name.replace(/\.md$/i, ''));
            }
            else if (entry.isDirectory()) {
                teams.push(`${entry.name}/`);
            }
        });
        teams.sort((a, b) => a.localeCompare(b));
    }
    const rawDocs = listMarkdownDocs(info.root, new Set([COLLECTIVE_MARKER]));
    const docs = rawDocs.filter(name => !skills.includes(name) && !teams.includes(name));
    const counts = {
        agents: agents.filter(agent => !agent.id.includes('/workflows/')).length,
        workflows: workflows.length,
        skills: skills.length,
        teams: teams.length
    };
    const notes = [];
    if (!info.agentsDir) {
        notes.push('_Documentation-only collective (no executable agents)._');
    }
    return {
        title: `${info.collective} collective • agents=${counts.agents} • workflows=${counts.workflows}`,
        relativePath,
        counts,
        docs,
        workflows,
        skills,
        teams,
        agentsDir: info.agentsDir ? path_1.default.relative(workspaceRoot, info.agentsDir) : null,
        workflowsDir: workflows.length ? path_1.default.relative(workspaceRoot, workflowsDir) : null,
        skillsDir: skills.length ? path_1.default.relative(workspaceRoot, skillsDir) : null,
        teamsDir: teams.length ? path_1.default.relative(workspaceRoot, teamsDir) : null,
        agentTree,
        notes
    };
}
function buildTree(agents) {
    const root = {
        name: 'root',
        type: 'folder',
        path: '',
        description: '',
        children: new Map()
    };
    agents.forEach((agent) => {
        const parts = agent.id.split('/');
        let current = root;
        let nodeType = 'agent';
        if (agent.id.includes('/workflows/'))
            nodeType = 'workflow';
        else if (agent.id.includes('/skills/'))
            nodeType = 'skill';
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;
            if (!current.children.has(part)) {
                current.children.set(part, {
                    name: part,
                    type: isLast ? nodeType : 'folder',
                    path: parts.slice(0, i + 1).join('/'),
                    description: isLast
                        ? ((agent.meta?.description || agent.meta?.summary || '')
                            .replace(/\s+/g, ' ')
                            .trim() || '')
                        : '',
                    children: new Map()
                });
            }
            current = current.children.get(part);
        }
    });
    return root;
}
function renderTree(node, prefix = '', isLast = true, depth = 0) {
    const lines = [];
    if (depth > 0) {
        const connector = isLast ? '└── ' : '├── ';
        const icon = node.type === 'agent' ? '🧠' : node.type === 'workflow' ? '⚙️ ' : node.type === 'skill' ? '💡' : '📁';
        const desc = node.description ? ` - ${(0, utils_1.truncateText)(node.description, 80)}` : '';
        lines.push(`${prefix}${connector}${icon} ${node.name}${desc}`);
    }
    const children = Array.from(node.children.values()).sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder')
            return -1;
        if (a.type !== 'folder' && b.type === 'folder')
            return 1;
        if (a.type !== b.type)
            return a.type.localeCompare(b.type);
        return a.name.localeCompare(b.name);
    });
    children.forEach((child, index) => {
        const isChildLast = index === children.length - 1;
        const extension = isLast ? '    ' : '│   ';
        const childPrefix = depth > 0 ? prefix + extension : '';
        lines.push(...renderTree(child, childPrefix, isChildLast, depth + 1));
    });
    return lines;
}
function formatInlineList(items, label, limit = 6) {
    if (!items.length)
        return null;
    const truncated = items.slice(0, limit);
    if (items.length > limit) {
        truncated.push(`… (+${items.length - limit})`);
    }
    return `${label}: ${truncated.join(', ')}`;
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
