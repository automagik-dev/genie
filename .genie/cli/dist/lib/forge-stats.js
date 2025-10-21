"use strict";
/**
 * Forge Statistics Collection
 *
 * Aggregates statistics from Forge backend for dashboard display:
 * - Project counts
 * - Task counts (by status)
 * - Task attempt counts (total + running)
 * - Active execution processes
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectForgeStats = collectForgeStats;
exports.formatStatsForDashboard = formatStatsForDashboard;
// @ts-ignore - compiled client shipped at project root
const forge_js_1 = require("../../../../forge.js");
async function collectForgeStats(baseUrl = 'http://localhost:8887') {
    try {
        const client = new forge_js_1.ForgeClient(baseUrl, process.env.FORGE_TOKEN);
        // Initialize stats
        const stats = {
            projects: { total: 0 },
            tasks: {
                total: 0,
                byStatus: {
                    todo: 0,
                    inprogress: 0,
                    inreview: 0,
                    done: 0,
                    cancelled: 0,
                },
            },
            attempts: {
                total: 0,
                running: 0,
                paused: 0,
                completed: 0,
                failed: 0,
            },
            hasRunningWork: false,
        };
        // Fetch all projects
        const projects = await client.listProjects();
        stats.projects.total = projects.length;
        // Get all task attempts and derive task count
        // Note: Forge 0.3.18 doesn't have project tasks endpoint, derive from attempts
        try {
            const allAttempts = await client.listTaskAttempts();
            stats.attempts.total = allAttempts.length;
            // Derive unique task count from attempts (group by task_id)
            const uniqueTaskIds = new Set(allAttempts.map((a) => a.task_id));
            stats.tasks.total = uniqueTaskIds.size;
            // For live status, check recent attempts (balance between accuracy and speed)
            // Check up to 15 attempts to get better distribution
            const recentAttempts = allAttempts.slice(0, 15);
            for (const attempt of recentAttempts) {
                try {
                    // Query execution processes for this attempt
                    const processes = await client.listExecutionProcesses(attempt.id, false);
                    if (processes && processes.length > 0) {
                        // Find the most recent process
                        const latestProcess = processes[processes.length - 1];
                        // Note: Forge uses 'status' not 'state'
                        // Known statuses: running, paused, completed, failed, killed
                        if (latestProcess.status === 'running') {
                            stats.attempts.running++;
                            stats.hasRunningWork = true;
                        }
                        else if (latestProcess.status === 'paused') {
                            stats.attempts.paused++;
                        }
                        else if (latestProcess.status === 'failed' || latestProcess.status === 'killed') {
                            stats.attempts.failed++;
                        }
                        else if (latestProcess.status === 'completed') {
                            stats.attempts.completed++;
                        }
                    }
                }
                catch {
                    // Skip this attempt if we can't query its processes
                }
            }
        }
        catch {
            // Failed to fetch attempts - API may not support it in this version
        }
        return stats;
    }
    catch (error) {
        // Forge is not available or errored
        return null;
    }
}
/**
 * Format stats for dashboard display
 */
function formatStatsForDashboard(stats) {
    if (!stats) {
        return '   (Unable to fetch stats)';
    }
    const lines = [];
    // Projects & Tasks
    lines.push(`   Projects: ${stats.projects.total}`);
    lines.push(`   Tasks: ${stats.tasks.total}`);
    // Attempts breakdown with live indicators
    const attemptParts = [];
    if (stats.attempts.running > 0) {
        attemptParts.push(`🔴 ${stats.attempts.running} running`);
    }
    if (stats.attempts.paused > 0) {
        attemptParts.push(`⏸️  ${stats.attempts.paused} paused`);
    }
    if (stats.attempts.failed > 0) {
        attemptParts.push(`❌ ${stats.attempts.failed} failed`);
    }
    if (stats.attempts.completed > 0 && stats.attempts.total > 0) {
        attemptParts.push(`✅ ${stats.attempts.completed} done`);
    }
    if (stats.attempts.total > 0) {
        lines.push(`   Attempts: ${stats.attempts.total} total`);
        if (attemptParts.length > 0) {
            attemptParts.forEach(part => lines.push(`      ${part}`));
        }
    }
    else {
        lines.push(`   Attempts: None active`);
    }
    return lines.join('\n');
}
