"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createListHandler = createListHandler;
const shared_1 = require("./shared");
const forge_executor_1 = require("../../lib/forge-executor");
function createListHandler(ctx) {
    return async (parsed) => {
        const [targetRaw] = parsed.commandArgs;
        if (!targetRaw) {
            throw new Error('Usage: genie list <agents|sessions>');
        }
        const target = targetRaw.toLowerCase();
        if (target === 'agents' || target === 'agents') {
            const agents = (0, shared_1.listAgents)();
            return {
                type: 'agents',
                agents: agents.map(agent => ({
                    id: agent.id,
                    displayId: agent.displayId,
                    label: agent.label,
                    folder: agent.folder,
                    meta: agent.meta
                }))
            };
        }
        if (target === 'sessions') {
            // ALWAYS query Forge for sessions (complete executor replacement)
            try {
                const forgeExecutor = (0, forge_executor_1.createForgeExecutor)();
                const forgeSessions = await forgeExecutor.listSessions();
                return {
                    type: 'sessions',
                    sessions: forgeSessions.map(entry => ({
                        name: entry.name || entry.sessionId,
                        agent: entry.agent,
                        status: entry.status || 'unknown',
                        created: entry.created || null,
                        lastUsed: entry.lastUsed || entry.created || null,
                        mode: 'default',
                        logFile: null
                    }))
                };
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
