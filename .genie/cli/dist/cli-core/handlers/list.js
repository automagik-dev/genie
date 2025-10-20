"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createListHandler = createListHandler;
const shared_1 = require("./shared");
const forge_executor_1 = require("../../lib/forge-executor");
const markdown_formatter_1 = require("../../lib/markdown-formatter");
function createListHandler(ctx) {
    return async (parsed) => {
        const [targetRaw] = parsed.commandArgs;
        if (!targetRaw) {
            throw new Error('Usage: genie list <agents|sessions>');
        }
        const target = targetRaw.toLowerCase();
        if (target === 'agents' || target === 'agents') {
            const agents = (0, shared_1.listAgents)();
            const sections = new Map();
            agents.forEach(agent => {
                const section = agent.folder || 'core';
                if (!sections.has(section)) {
                    sections.set(section, []);
                }
                sections.get(section).push(agent);
            });
            const orderedSections = Array.from(sections.entries()).sort(([a], [b]) => {
                if (a === 'core')
                    return -1;
                if (b === 'core')
                    return 1;
                return a.localeCompare(b);
            });
            const lines = [];
            lines.push(`## Genie Agents`);
            lines.push(`**Total:** ${agents.length}`);
            lines.push('');
            orderedSections.forEach(([section, items]) => {
                lines.push(`**${section}:**`);
                items
                    .sort((a, b) => a.displayId.localeCompare(b.displayId))
                    .forEach(agent => {
                    let line = `  • ${agent.displayId}`;
                    if (agent.label && agent.label !== agent.displayId) {
                        line += ` (${agent.label})`;
                    }
                    const description = (agent.meta?.description || agent.meta?.summary || '').trim();
                    if (description) {
                        line += ` - ${description}`;
                    }
                    lines.push(line);
                });
                lines.push('');
            });
            lines.push('Use `genie run <agent> "<prompt>"` to start a session.');
            await ctx.emitView(lines.join('\n'), parsed.options);
            return;
        }
        if (target === 'sessions') {
            // ALWAYS query Forge for sessions (complete executor replacement)
            try {
                const forgeExecutor = (0, forge_executor_1.createForgeExecutor)();
                const forgeSessions = await forgeExecutor.listSessions();
                const sessions = forgeSessions.map(entry => ({
                    sessionId: entry.sessionId || entry.name || 'unknown',
                    agent: entry.agent,
                    status: entry.status || 'unknown',
                    executor: 'forge',
                    started: entry.created || undefined,
                    updated: entry.lastUsed || entry.created || undefined
                }));
                const markdown = (0, markdown_formatter_1.formatSessionList)(sessions);
                await ctx.emitView(markdown, parsed.options);
                return;
            }
            catch (error) {
                console.warn('Failed to fetch Forge sessions, falling back to local store');
            }
            // Fallback to local store if Forge API fails
            const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
            const entries = Object.entries(store.sessions || {});
            // In v3, sessions are keyed by name (not sessionId)
            const sessions = entries.map(([key, entry]) => {
                return {
                    name: entry.name || key, // key IS the name in v3
                    agent: entry.agent,
                    status: resolveDisplayStatus(entry, ctx),
                    created: entry.created || undefined,
                    lastUsed: entry.lastUsed || entry.created || undefined,
                    mode: entry.mode || entry.preset,
                    logFile: entry.logFile
                };
            });
            // Sort by lastUsed descending
            sessions.sort((a, b) => {
                const aTime = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
                const bTime = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
                return bTime - aTime;
            });
            const markdown = (0, markdown_formatter_1.formatSessionList)(sessions.map(session => ({
                sessionId: session.name,
                agent: session.agent,
                status: session.status,
                executor: session.mode || 'default',
                started: session.created || undefined,
                updated: session.lastUsed || undefined
            })));
            await ctx.emitView(markdown, parsed.options);
            return;
        }
        throw new Error(`Unknown list target '${targetRaw}'. Try 'agents' or 'sessions'.`);
    };
}
function resolveDisplayStatus(entry, ctx) {
    const baseStatus = entry.status || 'unknown';
    const executorRunning = ctx.backgroundManager.isAlive(entry.executorPid);
    const runnerRunning = ctx.backgroundManager.isAlive(entry.runnerPid);
    if (baseStatus === 'running') {
        if (executorRunning)
            return 'running';
        if (!executorRunning && runnerRunning)
            return 'pending-completion';
        if (entry.exitCode === 0)
            return 'completed';
        if (typeof entry.exitCode === 'number' && entry.exitCode !== 0) {
            return `failed (${entry.exitCode})`;
        }
        return 'stopped';
    }
    if (baseStatus === 'completed' || baseStatus === 'failed') {
        return baseStatus;
    }
    if (runnerRunning || executorRunning) {
        return 'running';
    }
    return baseStatus;
}
