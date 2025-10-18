"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStopHandler = createStopHandler;
const session_helpers_1 = require("../../lib/session-helpers");
const shared_1 = require("./shared");
function createStopHandler(ctx) {
    return async (parsed) => {
        const [sessionName] = parsed.commandArgs;
        if (!sessionName) {
            throw new Error('Usage: genie stop <session-name>');
        }
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        const found = (0, session_helpers_1.findSessionEntry)(store, sessionName, ctx.paths);
        if (!found) {
            return {
                success: false,
                name: sessionName,
                message: `No session found with name '${sessionName}'.`,
                events: [{ label: sessionName, status: 'failed', message: 'Session not found' }]
            };
        }
        const { agentName, entry } = found;
        const identifier = entry.name || agentName;
        // Check if this is a Forge-managed session
        const forgeEnabled = process.env.FORGE_BASE_URL || process.env.GENIE_USE_FORGE === 'true';
        if (forgeEnabled && entry.executor === 'forge' && entry.sessionId) {
            // Use Forge stop API
            try {
                const { createForgeExecutor } = require('../../lib/forge-executor');
                const forgeExecutor = createForgeExecutor();
                await forgeExecutor.stopSession(entry.sessionId);
                entry.status = 'stopped';
                entry.lastUsed = new Date().toISOString();
                entry.signal = 'SIGTERM';
                await (0, shared_1.persistStore)(ctx, store);
                return {
                    success: true,
                    name: identifier,
                    message: `Session ${identifier} stopped via Forge`,
                    events: [{ label: identifier, detail: 'Stopped via Forge API', status: 'done' }]
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    success: false,
                    name: identifier,
                    message: `Failed to stop Forge session: ${message}`,
                    events: [{ label: identifier, detail: 'Forge stop failed', status: 'failed', message }]
                };
            }
        }
        // Traditional PID-based stop
        const alivePids = [entry.runnerPid, entry.executorPid]
            .filter((pid) => ctx.backgroundManager.isAlive(pid));
        if (!alivePids.length) {
            return {
                success: false,
                name: identifier,
                message: `No active process found for ${identifier}.`,
                events: [{ label: identifier, detail: 'No active process', status: 'pending' }]
            };
        }
        const events = [];
        alivePids.forEach((pid) => {
            try {
                const ok = ctx.backgroundManager.stop(pid);
                if (ok !== false) {
                    events.push({ label: `${identifier}`, detail: `PID ${pid} stopped`, status: 'done' });
                }
                else {
                    events.push({ label: `${identifier}`, detail: `PID ${pid} not running`, status: 'failed' });
                }
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                events.push({ label: `${identifier}`, detail: `PID ${pid}`, status: 'failed', message });
            }
        });
        entry.status = 'stopped';
        entry.lastUsed = new Date().toISOString();
        entry.signal = entry.signal || 'SIGTERM';
        if (entry.exitCode === undefined)
            entry.exitCode = null;
        await (0, shared_1.persistStore)(ctx, store);
        return {
            success: true,
            name: identifier,
            message: `Stop signal handled for ${identifier}`,
            events
        };
    };
}
