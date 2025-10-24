"use strict";
/**
 * Headless Execution Helpers
 *
 * Utilities for running agents in headless mode (JSON/raw output)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureForgeRunning = ensureForgeRunning;
exports.waitForTaskCompletion = waitForTaskCompletion;
exports.extractFinalOutput = extractFinalOutput;
const forge_manager_1 = require("./forge-manager");
const path_1 = __importDefault(require("path"));
/**
 * Ensure Forge is running, start if needed
 * Silent or with minimal output based on quiet flag
 */
async function ensureForgeRunning(quiet = false) {
    const baseUrl = process.env.FORGE_BASE_URL || 'http://localhost:8887';
    const logDir = path_1.default.join(process.cwd(), '.genie', 'state');
    const running = await (0, forge_manager_1.isForgeRunning)(baseUrl);
    if (running)
        return;
    // Start Forge
    if (!quiet) {
        process.stderr.write('Starting Forge... ');
    }
    const startTime = Date.now();
    const result = (0, forge_manager_1.startForgeInBackground)({ baseUrl, logDir });
    if (!result.ok) {
        const error = 'error' in result ? result.error : new Error('Unknown error');
        throw new Error(`Failed to start Forge: ${error.message}`);
    }
    const ready = await (0, forge_manager_1.waitForForgeReady)(baseUrl, 60000, 500, false);
    if (!ready) {
        throw new Error('Forge did not start in time (60s)');
    }
    if (!quiet) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        process.stderr.write(`ready (${elapsed}s)\n\n`);
    }
}
/**
 * Wait for task completion by polling Forge API
 */
async function waitForTaskCompletion(attemptId, executor, maxWaitMs = 300000 // 5 minutes default
) {
    const pollInterval = 1000; // 1s
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const status = await executor.getSessionStatus(attemptId);
            if (status.status === 'completed' || status.status === 'success') {
                // Task completed successfully
                const logs = await executor.fetchLatestLogs(attemptId);
                const output = extractFinalOutput(logs);
                return { status: 'completed', output };
            }
            if (status.status === 'failed' || status.status === 'error') {
                // Task failed
                const logs = await executor.fetchLatestLogs(attemptId);
                const output = extractFinalOutput(logs);
                return {
                    status: 'failed',
                    output,
                    error: 'Task execution failed'
                };
            }
            // Still running or pending, wait and retry
            await sleep(pollInterval);
        }
        catch (error) {
            // If we can't fetch status, wait and retry
            await sleep(pollInterval);
        }
    }
    // Timeout
    return {
        status: 'timeout',
        output: '',
        error: 'Task did not complete within timeout'
    };
}
/**
 * Extract final output from executor logs
 * Attempts to find the agent's final answer/response
 */
function extractFinalOutput(logs) {
    if (!logs)
        return '(no output)';
    // Try to extract meaningful output
    // This is a simple heuristic - can be improved based on executor output format
    const lines = logs.trim().split('\n').filter(l => l.trim());
    // Look for common patterns indicating final output
    // - Last assistant message
    // - Output after completion markers
    // - Last non-empty line
    if (lines.length === 0)
        return '(no output)';
    // Return last non-empty line as fallback
    return lines[lines.length - 1] || '(no output)';
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
