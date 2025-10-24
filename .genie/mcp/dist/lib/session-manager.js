"use strict";
/**
 * Session Manager - Query Forge for master orchestrators
 *
 * Phase 2: Prevents orphaned tasks by reusing master orchestrators
 * Architecture: Query Forge database for existing masters (persists across restarts)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionManager = exports.SessionManager = void 0;
const path_1 = __importDefault(require("path"));
// Load ForgeClient
const geniePackageRoot = path_1.default.resolve(__dirname, '../../../..');
const ForgeClient = require(path_1.default.join(geniePackageRoot, 'forge.js')).ForgeClient;
const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
class SessionManager {
    constructor() {
        this.forgeClient = new ForgeClient(FORGE_URL);
    }
    /**
     * Get existing master orchestrator for workflow + project
     * Queries Forge database for active master
     */
    async getSession(workflow, projectId) {
        try {
            // Query Forge for tasks
            const tasks = await this.forgeClient.listTasks(projectId);
            // Find master orchestrator (status='agent', executor contains neuron-{workflow}, no parent)
            const master = tasks.find((t) => t.status === 'agent' &&
                t.executor?.includes(`:neuron-${workflow}`) &&
                !t.parent_task_attempt);
            if (master && master.latest_attempt) {
                return {
                    taskId: master.id,
                    attemptId: master.latest_attempt.id,
                    url: `${FORGE_URL}/projects/${projectId}/tasks/${master.id}/attempts/${master.latest_attempt.id}?view=diffs`,
                    projectId,
                    created: master.created_at,
                    lastUsed: master.updated_at
                };
            }
            return null;
        }
        catch (error) {
            console.error(`Failed to query Forge for ${workflow} master:`, error);
            return null;
        }
    }
    /**
     * Delegate work to existing master via follow-up
     * Sends prompt to master's latest attempt
     */
    async delegateToMaster(attemptId, prompt) {
        try {
            await this.forgeClient.followUpTaskAttempt(attemptId, prompt);
        }
        catch (error) {
            console.error(`Failed to delegate to master attempt ${attemptId}:`, error);
            throw error;
        }
    }
    /**
     * Create new master orchestrator
     * Returns session info for the new master
     */
    async createMaster(workflow, projectId, title, prompt) {
        try {
            const result = await this.forgeClient.createAndStartTask({
                project_id: projectId,
                title,
                prompt,
                executor: `CLAUDE_CODE:neuron-${workflow}`,
                status: 'agent', // Hidden from main Kanban
                parent_task_attempt: null // Masters have no parent
            });
            const { task_id: taskId, attempt_id: attemptId } = result;
            return {
                taskId,
                attemptId,
                url: `${FORGE_URL}/projects/${projectId}/tasks/${taskId}/attempts/${attemptId}?view=diffs`,
                projectId,
                created: new Date().toISOString(),
                lastUsed: new Date().toISOString()
            };
        }
        catch (error) {
            console.error(`Failed to create ${workflow} master:`, error);
            throw error;
        }
    }
    /**
     * Get or create master orchestrator
     * Reuses existing master if found, creates new one if not
     */
    async getOrCreateMaster(workflow, projectId, title, prompt) {
        // Try to find existing master
        const existing = await this.getSession(workflow, projectId);
        if (existing) {
            return existing;
        }
        // No master found, create new one
        return await this.createMaster(workflow, projectId, title, prompt);
    }
}
exports.SessionManager = SessionManager;
/**
 * Global session manager instance
 * Shared across all MCP tool calls during server lifetime
 */
exports.sessionManager = new SessionManager();
