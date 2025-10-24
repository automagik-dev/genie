"use strict";
/**
 * Stats Integration - Hook stats tracker into Genie execution
 *
 * Automatically tracks sessions, tokens, and tasks without manual intervention.
 * Call these functions from the appropriate places in the CLI.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStatsTracker = getStatsTracker;
exports.hookSessionStart = hookSessionStart;
exports.hookSessionEnd = hookSessionEnd;
exports.hookTokenUpdate = hookTokenUpdate;
exports.hookTaskCompletion = hookTaskCompletion;
exports.hookWishFulfillment = hookWishFulfillment;
exports.hookAgentInvocation = hookAgentInvocation;
exports.getCurrentSessionId = getCurrentSessionId;
exports.ensureSession = ensureSession;
const stats_tracker_1 = require("./stats-tracker");
// Singleton tracker instance
let tracker = null;
function getStatsTracker() {
    if (!tracker) {
        tracker = new stats_tracker_1.StatsTracker(process.cwd());
    }
    return tracker;
}
/**
 * Hook 1: Start Session (call from 'genie run' command start)
 */
function hookSessionStart(projectId, projectName) {
    const tracker = getStatsTracker();
    const session = tracker.startSession(projectId, projectName);
    console.error(`📊 Session started: ${session.id}`);
}
/**
 * Hook 2: End Session (call from execution completion or SIGINT)
 */
function hookSessionEnd(sessionId) {
    const tracker = getStatsTracker();
    tracker.endSession(sessionId);
    console.error(`📊 Session ended: ${sessionId}`);
}
/**
 * Hook 3: Record Tokens (call from execution process token updates)
 */
function hookTokenUpdate(sessionId, inputTokens, outputTokens) {
    const tracker = getStatsTracker();
    tracker.recordTokens(sessionId, inputTokens, outputTokens);
    // Check for milestones
    const session = tracker.getCurrentSession();
    if (session) {
        const milestones = tracker.getRecentMilestones(1);
        if (milestones.length > 0) {
            const latest = milestones[0];
            // Flash milestone notification
            console.error(`\n🎉 ${latest.title}\n`);
        }
    }
}
/**
 * Hook 4: Record Task Completion (call when Forge task status changes to 'done')
 */
function hookTaskCompletion(sessionId, taskId, taskTitle) {
    const tracker = getStatsTracker();
    tracker.recordTaskCompletion(sessionId, taskId, taskTitle);
    console.error(`✅ Task completed: ${taskTitle}`);
}
/**
 * Hook 5: Record Wish Fulfillment (call when wish is marked complete)
 */
function hookWishFulfillment(sessionId) {
    const tracker = getStatsTracker();
    tracker.recordWishFulfillment(sessionId);
    console.error(`🎯 Wish fulfilled!`);
}
/**
 * Hook 6: Record Agent Invocation (call when agent starts)
 */
function hookAgentInvocation(sessionId, agentId) {
    const tracker = getStatsTracker();
    tracker.recordAgentInvocation(sessionId, agentId);
}
/**
 * Get current session ID (for passing to other hooks)
 */
function getCurrentSessionId() {
    const tracker = getStatsTracker();
    const session = tracker.getCurrentSession();
    return session ? session.id : null;
}
/**
 * Auto-start session if none exists (convenience)
 */
function ensureSession(projectId = 'default', projectName = 'Genie Workspace') {
    const tracker = getStatsTracker();
    let session = tracker.getCurrentSession();
    if (!session) {
        session = tracker.startSession(projectId, projectName);
    }
    return session.id;
}
