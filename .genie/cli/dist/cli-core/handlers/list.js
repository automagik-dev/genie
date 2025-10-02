"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createListHandler = createListHandler;
const shared_1 = require("./shared");
function createListHandler(ctx) {
    return async (parsed) => {
        const [targetRaw] = parsed.commandArgs;
        if (!targetRaw) {
            throw new Error('Usage: genie list <agents|sessions>');
        }
        const target = targetRaw.toLowerCase();
        if (target === 'agents') {
            const agents = (0, shared_1.listAgents)();
            return {
                type: 'agents',
                agents: agents.map(agent => ({
                    id: agent.id,
                    label: agent.label,
                    folder: agent.folder,
                    meta: agent.meta
                }))
            };
        }
        if (target === 'sessions') {
            const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
            const entries = Object.entries(store.agents || {});
            const sessions = entries.map(([agent, entry]) => {
                const iso = entry.lastUsed || entry.created;
                return {
                    agent,
                    status: resolveDisplayStatus(entry, ctx),
                    sessionId: entry.sessionId || null,
                    created: entry.created || null,
                    lastUsed: entry.lastUsed || entry.created || null,
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
            return {
                type: 'sessions',
                sessions
            };
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
