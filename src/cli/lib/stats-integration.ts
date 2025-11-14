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
  const task = tracker.startSession(projectId, projectName);
  console.error(`📊 Session started: ${task.id}`);
}

/**
 * Hook 2: End Session (call from execution completion or SIGINT)
 */
export function hookSessionEnd(taskId: string): void {
  const tracker = getStatsTracker();
  tracker.endSession(taskId);
  console.error(`📊 Session ended: ${taskId}`);
}

/**
 * Hook 3: Record Tokens (call from execution process token updates)
 */
export function hookTokenUpdate(taskId: string, inputTokens: number, outputTokens: number): void {
  const tracker = getStatsTracker();
  tracker.recordTokens(taskId, inputTokens, outputTokens);

  // Check for milestones
  const task = tracker.getCurrentSession();
  if (task) {
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
export function hookTaskCompletion(sessionTaskId: string, forgeTaskId: string, taskTitle: string): void {
  const tracker = getStatsTracker();
  tracker.recordTaskCompletion(sessionTaskId, forgeTaskId, taskTitle);
  console.error(`✅ Task completed: ${taskTitle}`);
}

/**
 * Hook 5: Record Wish Fulfillment (call when wish is marked complete)
 */
export function hookWishFulfillment(taskId: string): void {
  const tracker = getStatsTracker();
  tracker.recordWishFulfillment(taskId);
  console.error(`🎯 Wish fulfilled!`);
}

/**
 * Hook 6: Record Agent Invocation (call when agent starts)
 */
export function hookAgentInvocation(taskId: string, agentId: string): void {
  const tracker = getStatsTracker();
  tracker.recordAgentInvocation(taskId, agentId);
}

/**
 * Get current session ID (for passing to other hooks)
 */
export function getCurrentSessionId(): string | null {
  const tracker = getStatsTracker();
  const task = tracker.getCurrentSession();
  return task ? task.id : null;
}

/**
 * Auto-start session if none exists (convenience)
 */
export function ensureSession(projectId: string = 'default', projectName: string = 'Genie Workspace'): string {
  const tracker = getStatsTracker();
  let task = tracker.getCurrentSession();

  if (!task) {
    task = tracker.startSession(projectId, projectName);
  }

  return task.id;
}
