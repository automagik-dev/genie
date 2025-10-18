"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.maybeHandleBackgroundLaunch = maybeHandleBackgroundLaunch;
const path_1 = __importDefault(require("path"));
const session_store_1 = require("../session-store");
const background_manager_instance_1 = require("./background-manager-instance");
const background_manager_1 = require("../background-manager");
const async_1 = require("./async");
const config_defaults_1 = require("./config-defaults");
/**
 * Handle background launching of agents
 * @returns true if handled as background, false if should continue as foreground
 */
async function maybeHandleBackgroundLaunch(params) {
    const { parsed, config, paths, store, entry, agentName, executorKey, executionMode, startTime, logFile, allowResume } = params;
    if (!parsed.options.background || parsed.options.backgroundRunner) {
        return false;
    }
    const runnerPid = background_manager_instance_1.backgroundManager.launch({
        rawArgs: parsed.options.rawArgs,
        startTime,
        logFile,
        backgroundConfig: config.background,
        scriptPath: path_1.default.resolve(__dirname, '..', 'genie.js'),
        env: entry.sessionId ? { [background_manager_1.INTERNAL_SESSION_ID_ENV]: entry.sessionId } : undefined
    });
    entry.runnerPid = runnerPid;
    entry.status = 'running';
    entry.background = parsed.options.background;
    (0, session_store_1.saveSessions)(paths, store);
    process.stdout.write(`▸ Launching ${agentName} in background...\n`);
    process.stdout.write(`▸ Waiting for session ID...\n`);
    const pollStart = Date.now();
    // Configurable timeout (default 60s, was 20s) - fixes race condition on slow starts
    const pollTimeout = parseInt(process.env.GENIE_POLL_TIMEOUT || '60000', 10);
    let pollInterval = 500;
    const maxPollInterval = 5000;
    let lastProgressTime = pollStart;
    while (Date.now() - pollStart < pollTimeout) {
        await (0, async_1.sleep)(pollInterval);
        const liveStore = (0, session_store_1.loadSessions)(paths, config, config_defaults_1.DEFAULT_CONFIG);
        // Use V2 session store format: sessions keyed by sessionId
        // The foreground process already persisted `entry` under its UUID key.
        // Poll for that specific session record instead of legacy agent-keyed lookup.
        const liveEntry = entry.sessionId ? liveStore.sessions?.[entry.sessionId] : undefined;
        if (liveEntry?.sessionId) {
            const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
            entry.sessionId = liveEntry.sessionId;
            process.stdout.write(`▸ Session ID: ${liveEntry.sessionId} (${elapsed}s)\n\n`);
            process.stdout.write(`  View output:\n`);
            process.stdout.write(`    npx automagik-genie view ${liveEntry.sessionId}\n\n`);
            process.stdout.write(`  Continue conversation:\n`);
            if (allowResume) {
                process.stdout.write(`    npx automagik-genie resume ${liveEntry.sessionId} "..."\n\n`);
            }
            else {
                process.stdout.write(`    npx automagik-genie continue ${agentName} "..."\n\n`);
            }
            process.stdout.write(`  Stop the agent:\n`);
            process.stdout.write(`    npx automagik-genie stop ${liveEntry.sessionId}\n\n`);
            return true;
        }
        if (liveEntry?.status === 'failed' || liveEntry?.status === 'completed') {
            process.stdout.write(`\n▸ Agent failed to start (status: ${liveEntry.status})\n`);
            if (liveEntry?.error) {
                process.stdout.write(`▸ Error: ${liveEntry.error}\n`);
            }
            process.stdout.write(`▸ Check log: ${logFile}\n`);
            return true;
        }
        // Progress feedback every 5 seconds
        const now = Date.now();
        if (now - lastProgressTime >= 5000) {
            const elapsed = Math.floor((now - pollStart) / 1000);
            process.stdout.write(`▸ Still waiting... (${elapsed}s elapsed)\n`);
            lastProgressTime = now;
        }
        // Exponential backoff: 500ms → 750ms → 1125ms → 1688ms → 2532ms → 3798ms → 5000ms (max)
        pollInterval = Math.min(Math.floor(pollInterval * 1.5), maxPollInterval);
    }
    process.stdout.write(`\n▸ Timeout waiting for session ID (waited ${Math.floor(pollTimeout / 1000)}s)\n`);
    process.stdout.write(`▸ Increase timeout with: GENIE_POLL_TIMEOUT=120000 (for 120s)\n`);
    process.stdout.write(`▸ Check log: ${logFile}\n`);
    return true;
}
