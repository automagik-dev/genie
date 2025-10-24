"use strict";
/**
 * Session Manager - In-memory session storage for workflow reuse
 *
 * Phase 2: Prevents orphaned tasks by reusing existing sessions
 * Architecture: In-memory Map (simple, fast, lost on restart)
 *
 * Future enhancement: Add persistence via JSON or database if needed
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionManager = exports.SessionManager = void 0;
class SessionManager {
    constructor() {
        this.sessions = new Map();
    }
    /**
     * Get existing session for workflow + project
     * Returns null if no session exists
     */
    getSession(workflow, projectId) {
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
    setSession(workflow, projectId, info) {
        const key = this.makeKey(projectId, workflow);
        const session = {
            ...info,
            projectId,
            lastUsed: new Date().toISOString()
        };
        this.sessions.set(key, session);
    }
    /**
     * Check if session exists for workflow + project
     */
    hasSession(workflow, projectId) {
        const key = this.makeKey(projectId, workflow);
        return this.sessions.has(key);
    }
    /**
     * Clear session for workflow + project
     * Used when session completes or encounters error
     */
    clearSession(workflow, projectId) {
        const key = this.makeKey(projectId, workflow);
        this.sessions.delete(key);
    }
    /**
     * Clear all sessions (for testing or reset)
     */
    clearAll() {
        this.sessions.clear();
    }
    /**
     * Get all active sessions (for debugging)
     */
    getAllSessions() {
        return new Map(this.sessions);
    }
    /**
     * Get session count (for monitoring)
     */
    getSessionCount() {
        return this.sessions.size;
    }
    /**
     * Make session key from project ID and workflow type
     * Format: {projectId}:{workflow}
     */
    makeKey(projectId, workflow) {
        return `${projectId}:${workflow}`;
    }
}
exports.SessionManager = SessionManager;
/**
 * Global session manager instance
 * Shared across all MCP tool calls during server lifetime
 */
exports.sessionManager = new SessionManager();
