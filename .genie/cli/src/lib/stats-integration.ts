/**
 * Stats Integration - Hook stats tracker into Genie execution
 *
 * Automatically tracks sessions, tokens, and tasks without manual intervention.
 * Call these functions from the appropriate places in the CLI.
 */

import { StatsTracker } from './stats-tracker';

// Singleton tracker instance
let tracker: StatsTracker | null = null;

export function getStatsTracker(): StatsTracker {
  if (!tracker) {
    tracker = new StatsTracker(process.cwd());
  }
  return tracker;
}

/**
 * Hook 1: Start Session (call from 'genie run' command start)
 */
export function hookSessionStart(projectId: string, projectName: string): void {
  const tracker = getStatsTracker();
  const session = tracker.startSession(projectId, projectName);
  console.error(`📊 Session started: ${session.id}`);
}

/**
 * Hook 2: End Session (call from execution completion or SIGINT)
 */
export function hookSessionEnd(sessionId: string): void {
  const tracker = getStatsTracker();
  tracker.endSession(sessionId);
  console.error(`📊 Session ended: ${sessionId}`);
}

/**
 * Hook 3: Record Tokens (call from execution process token updates)
 */
export function hookTokenUpdate(sessionId: string, inputTokens: number, outputTokens: number): void {
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
export function hookTaskCompletion(sessionId: string, taskId: string, taskTitle: string): void {
  const tracker = getStatsTracker();
  tracker.recordTaskCompletion(sessionId, taskId, taskTitle);
  console.error(`✅ Task completed: ${taskTitle}`);
}

/**
 * Hook 5: Record Wish Fulfillment (call when wish is marked complete)
 */
export function hookWishFulfillment(sessionId: string): void {
  const tracker = getStatsTracker();
  tracker.recordWishFulfillment(sessionId);
  console.error(`🎯 Wish fulfilled!`);
}

/**
 * Hook 6: Record Agent Invocation (call when agent starts)
 */
export function hookAgentInvocation(sessionId: string, agentId: string): void {
  const tracker = getStatsTracker();
  tracker.recordAgentInvocation(sessionId, agentId);
}

/**
 * Get current session ID (for passing to other hooks)
 */
export function getCurrentSessionId(): string | null {
  const tracker = getStatsTracker();
  const session = tracker.getCurrentSession();
  return session ? session.id : null;
}

/**
 * Auto-start session if none exists (convenience)
 */
export function ensureSession(projectId: string = 'default', projectName: string = 'Genie Workspace'): string {
  const tracker = getStatsTracker();
  let session = tracker.getCurrentSession();

  if (!session) {
    session = tracker.startSession(projectId, projectName);
  }

  return session.id;
}
