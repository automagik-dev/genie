"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runStop = runStop;
const session_store_1 = require("../session-store");
const session_helpers_1 = require("../lib/session-helpers");
const config_defaults_1 = require("../lib/config-defaults");
const stop_1 = require("../views/stop");
const common_1 = require("../views/common");
const view_helpers_1 = require("../lib/view-helpers");
const background_manager_instance_1 = require("../lib/background-manager-instance");
async function runStop(parsed, config, paths) {
    const [target] = parsed.commandArgs;
    if (!target) {
        throw new Error('Usage: genie stop <sessionId>');
    }
    const warnings = [];
    const store = (0, session_store_1.loadSessions)(paths, config, config_defaults_1.DEFAULT_CONFIG, { onWarning: (message) => warnings.push(message) });
    const found = (0, session_helpers_1.findSessionEntry)(store, target, paths);
    const events = [];
    let summary = '';
    const appendWarningView = async () => {
        if (warnings.length) {
            await (0, view_helpers_1.emitView)((0, common_1.buildWarningView)('Session warnings', warnings), parsed.options);
        }
    };
    if (!found) {
        events.push({ label: target, status: 'failed', message: 'Session id not found' });
        summary = `No run found with session id '${target}'.`;
        const envelope = (0, stop_1.buildStopView)({ target, events, summary });
        await (0, view_helpers_1.emitView)(envelope, parsed.options);
        await appendWarningView();
        return;
    }
    const { agentName, entry } = found;
    const identifier = entry.sessionId || agentName;
    const alivePids = [entry.runnerPid, entry.executorPid].filter((pid) => background_manager_instance_1.backgroundManager.isAlive(pid));
    if (!alivePids.length) {
        events.push({ label: identifier, detail: 'No active process', status: 'pending' });
        summary = `No active process found for ${identifier}.`;
    }
    else {
        alivePids.forEach((pid) => {
            try {
                const ok = background_manager_instance_1.backgroundManager.stop(pid);
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
        summary = `Stop signal handled for ${identifier}`;
        entry.status = 'stopped';
        entry.lastUsed = new Date().toISOString();
        entry.signal = entry.signal || 'SIGTERM';
        if (entry.exitCode === undefined)
            entry.exitCode = null;
        (0, session_store_1.saveSessions)(paths, store);
    }
    const envelope = (0, stop_1.buildStopView)({ target, events, summary });
    await (0, view_helpers_1.emitView)(envelope, parsed.options);
    await appendWarningView();
}
