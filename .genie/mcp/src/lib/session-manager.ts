/**
 * Session Manager - In-memory session storage for workflow reuse
 *
 * Phase 2: Prevents orphaned tasks by reusing existing sessions
 * Architecture: In-memory Map (simple, fast, lost on restart)
 *
 * Future enhancement: Add persistence via JSON or database if needed
 */

import { WorkflowType, SessionInfo, SessionKey } from './session-types.js';

export class SessionManager {
  private sessions: Map<SessionKey, SessionInfo>;

  constructor() {
    this.sessions = new Map();
  }

  /**
   * Get existing session for workflow + project
   * Returns null if no session exists
   */
  getSession(workflow: WorkflowType, projectId: string): SessionInfo | null {
    const key = this.makeKey(projectId, workflow);
    const session = this.sessions.get(key);

    if (session) {
      // Update lastUsed timestamp
      session.lastUsed = new Date().toISOString();
    }

    return session || null;
  }

  /**
   * Store new session for workflow + project
   * Overwrites existing session if present
   */
  setSession(workflow: WorkflowType, projectId: string, info: Omit<SessionInfo, 'projectId'>): void {
    const key = this.makeKey(projectId, workflow);
    const session: SessionInfo = {
      ...info,
      projectId,
      lastUsed: new Date().toISOString()
    };
    this.sessions.set(key, session);
  }

  /**
   * Check if session exists for workflow + project
   */
  hasSession(workflow: WorkflowType, projectId: string): boolean {
    const key = this.makeKey(projectId, workflow);
    return this.sessions.has(key);
  }

  /**
   * Clear session for workflow + project
   * Used when session completes or encounters error
   */
  clearSession(workflow: WorkflowType, projectId: string): void {
    const key = this.makeKey(projectId, workflow);
    this.sessions.delete(key);
  }

  /**
   * Clear all sessions (for testing or reset)
   */
  clearAll(): void {
    this.sessions.clear();
  }

  /**
   * Get all active sessions (for debugging)
   */
  getAllSessions(): Map<SessionKey, SessionInfo> {
    return new Map(this.sessions);
  }

  /**
   * Get session count (for monitoring)
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Make session key from project ID and workflow type
   * Format: {projectId}:{workflow}
   */
  private makeKey(projectId: string, workflow: WorkflowType): SessionKey {
    return `${projectId}:${workflow}`;
  }
}

/**
 * Global session manager instance
 * Shared across all MCP tool calls during server lifetime
 */
export const sessionManager = new SessionManager();
