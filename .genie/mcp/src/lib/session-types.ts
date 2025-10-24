/**
 * Session types for workflow session management
 *
 * Phase 2: In-memory session reuse to prevent orphaned tasks
 */

export type WorkflowType = 'wish' | 'forge' | 'review';

/**
 * Session information stored for each workflow
 */
export interface SessionInfo {
  taskId: string;
  attemptId: string;
  url: string;
  projectId: string;
  created: string;
  lastUsed: string;
}

/**
 * Session key format: {projectId}:{workflow}
 * Example: "ee8f0a72-44da-411d-a23e-f2c6529b62ce:wish"
 */
export type SessionKey = string;
