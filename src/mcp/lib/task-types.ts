/**
 * Task types for workflow task management
 *
 * Phase 2: In-memory task reuse to prevent orphaned tasks
 */

export type WorkflowType = 'wish' | 'forge' | 'review';

/**
 * Task information stored for each workflow
 */
export interface TaskInfo {
  taskId: string;
  attemptId: string;
  url: string;
  projectId: string;
  created: string;
  lastUsed: string;
}

/**
 * Task key format: {projectId}:{workflow}
 * Example: "ee8f0a72-44da-411d-a23e-f2c6529b62ce:wish"
 */
export type TaskKey = string;
