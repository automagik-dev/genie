"use strict";
/**
 * Token Usage Tracker
 *
 * Aggregates token usage metrics from execution process logs
 * Parses JSONL events to extract input/output/total tokens
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectTokensForAttempt = collectTokensForAttempt;
exports.collectAllTokenMetrics = collectAllTokenMetrics;
exports.formatTokenMetrics = formatTokenMetrics;
// @ts-ignore - compiled client shipped at project root
const forge_js_1 = require("../../../../forge.js");
/**
 * Parse token events from JSONL logs
 */
function parseTokensFromLogs(logs) {
    const metrics = {
        input: 0,
        output: 0,
        cached: 0,
        total: 0,
        costUsd: 0,
        processCount: 0
    };
    if (!logs || typeof logs !== 'string') {
        return metrics;
    }
    const lines = logs.split('\n').filter(line => line.trim());
    for (const line of lines) {
        try {
            const event = JSON.parse(line);
            // Handle different event formats
            const envelope = event && typeof event === 'object' ? event : {};
            const actualEvent = envelope.payload || envelope;
            const payload = actualEvent.msg || actualEvent;
            const type = payload?.type || event?.type;
            // Result events (Claude executor)
            if (type === 'result' && event.success !== false) {
                if (event.tokens) {
                    metrics.input += event.tokens.input || 0;
                    metrics.output += event.tokens.output || 0;
                }
                if (event.cost_usd) {
                    metrics.costUsd += event.cost_usd;
                }
                if (event.usage) {
                    metrics.input += event.usage.input_tokens || 0;
                    metrics.output += event.usage.output_tokens || 0;
                }
            }
            // token_count events (Codex executor)
            if (type === 'token_count') {
                const info = envelope.info || payload.info;
                if (info?.total_token_usage) {
                    metrics.input += info.total_token_usage.input_tokens || 0;
                    metrics.output += info.total_token_usage.output_tokens || 0;
                    metrics.cached += info.total_token_usage.cached_input_tokens || 0;
                }
            }
            // token.usage events
            if (type === 'token.usage') {
                metrics.input += payload.input_tokens || 0;
                metrics.output += payload.output_tokens || 0;
                metrics.total += payload.total_tokens || 0;
            }
            // response.usage events
            if (type === 'response.usage') {
                const usage = envelope.usage || payload.usage || payload;
                if (usage) {
                    metrics.input += usage.input_tokens || usage.prompt_tokens || 0;
                    metrics.output += usage.output_tokens || usage.completion_tokens || 0;
                    metrics.cached += usage.cached_input_tokens || 0;
                }
            }
        }
        catch {
            // Skip invalid JSON lines
            continue;
        }
    }
    // Calculate total if not explicitly set
    if (metrics.total === 0) {
        metrics.total = metrics.input + metrics.output;
    }
    metrics.processCount = 1;
    return metrics;
}
/**
 * Collect token metrics for a single task attempt
 */
async function collectTokensForAttempt(client, attemptId) {
    const aggregated = {
        input: 0,
        output: 0,
        cached: 0,
        total: 0,
        costUsd: 0,
        processCount: 0
    };
    try {
        const processes = await client.listExecutionProcesses(attemptId, false);
        if (!processes || processes.length === 0) {
            return aggregated;
        }
        for (const process of processes) {
            try {
                // Get full process details with logs
                const fullProcess = await client.getExecutionProcess(process.id);
                const logs = fullProcess.logs || fullProcess.output || '';
                const processMetrics = parseTokensFromLogs(logs);
                aggregated.input += processMetrics.input;
                aggregated.output += processMetrics.output;
                aggregated.cached += processMetrics.cached;
                aggregated.total += processMetrics.total;
                aggregated.costUsd += processMetrics.costUsd;
                aggregated.processCount++;
            }
            catch {
                // Skip process if we can't fetch its details
                continue;
            }
        }
    }
    catch {
        // Failed to fetch processes
    }
    return aggregated;
}
/**
 * Collect token metrics across all task attempts
 */
async function collectAllTokenMetrics(baseUrl = 'http://localhost:8887') {
    const aggregated = {
        input: 0,
        output: 0,
        cached: 0,
        total: 0,
        costUsd: 0,
        processCount: 0
    };
    try {
        const client = new forge_js_1.ForgeClient(baseUrl, process.env.FORGE_TOKEN);
        // Get all task attempts
        const attempts = await client.listTaskAttempts();
        if (!attempts || attempts.length === 0) {
            return aggregated;
        }
        // Limit to recent attempts for performance (last 20)
        const recentAttempts = attempts.slice(0, 20);
        for (const attempt of recentAttempts) {
            const attemptMetrics = await collectTokensForAttempt(client, attempt.id);
            aggregated.input += attemptMetrics.input;
            aggregated.output += attemptMetrics.output;
            aggregated.cached += attemptMetrics.cached;
            aggregated.total += attemptMetrics.total;
            aggregated.costUsd += attemptMetrics.costUsd;
            aggregated.processCount += attemptMetrics.processCount;
        }
    }
    catch {
        // Failed to collect metrics
    }
    return aggregated;
}
/**
 * Format token metrics for display
 */
function formatTokenMetrics(metrics, compact = false) {
    if (metrics.total === 0) {
        return compact ? 'No usage yet' : '   No token usage yet';
    }
    const indent = compact ? '' : '   ';
    const lines = [];
    if (compact) {
        // Compact format for real-time dashboard
        lines.push(`${(metrics.total / 1000).toFixed(1)}k tokens`);
        if (metrics.costUsd > 0) {
            lines.push(`($${metrics.costUsd.toFixed(3)})`);
        }
    }
    else {
        // Detailed format for goodbye report
        lines.push(`${indent}Input:   ${metrics.input.toLocaleString()} tokens`);
        lines.push(`${indent}Output:  ${metrics.output.toLocaleString()} tokens`);
        if (metrics.cached > 0) {
            lines.push(`${indent}Cached:  ${metrics.cached.toLocaleString()} tokens`);
        }
        lines.push(`${indent}Total:   ${metrics.total.toLocaleString()} tokens`);
        if (metrics.costUsd > 0) {
            lines.push(`${indent}Cost:    $${metrics.costUsd.toFixed(4)} USD`);
        }
    }
    return lines.join(compact ? ' ' : '\n');
}
