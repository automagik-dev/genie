"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStopHandler = createStopHandler;
const session_helpers_1 = require("../../lib/session-helpers");
const shared_1 = require("./shared");
function createStopHandler(ctx) {
    return async (parsed) => {
        const [target] = parsed.commandArgs;
        if (!target) {
            throw new Error('Usage: genie stop <sessionId>');
        }
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        const found = (0, session_helpers_1.findSessionEntry)(store, target, ctx.paths);
        if (!found) {
            return {
                success: false,
                sessionId: target,
                message: `No run found with session id '${target}'.`,
                events: [{ label: target, status: 'failed', message: 'Session id not found' }]
            };
        }
        const { agentName, entry } = found;
        const identifier = entry.sessionId || agentName;
        const alivePids = [entry.runnerPid, entry.executorPid]
            .filter((pid) => ctx.backgroundManager.isAlive(pid));
        if (!alivePids.length) {
            return {
                success: false,
                sessionId: identifier,
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
            sessionId: identifier,
            message: `Stop signal handled for ${identifier}`,
            events
        };
    };
}
