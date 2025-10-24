/**
 * Session Manager - Query Forge for master orchestrators
 *
 * Phase 2: Prevents orphaned tasks by reusing master orchestrators
 * Architecture: Query Forge database for existing masters (persists across restarts)
 */

import { WorkflowType, SessionInfo } from './session-types.js';
import path from 'path';

// Load ForgeClient
const geniePackageRoot = path.resolve(__dirname, '../../../..');
const ForgeClient = require(path.join(geniePackageRoot, 'forge.js')).ForgeClient;

const FORGE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';

export class SessionManager {
  private forgeClient: any;

  constructor() {
    this.forgeClient = new ForgeClient(FORGE_URL);
  }

  /**
   * Get existing master orchestrator for workflow + project
   * Queries Forge database for active master
   */
  async getSession(workflow: WorkflowType, projectId: string): Promise<SessionInfo | null> {
    try {
      // Query Forge for tasks
      const tasks = await this.forgeClient.listTasks(projectId);

      // Find master orchestrator (status='agent', executor contains neuron-{workflow}, no parent)
      const master = tasks.find((t: any) =>
        t.status === 'agent' &&
        t.executor?.includes(`:neuron-${workflow}`) &&
        !t.parent_task_attempt
      );

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
    } catch (error) {
      console.error(`Failed to query Forge for ${workflow} master:`, error);
      return null;
    }
  }

  /**
   * Delegate work to existing master via follow-up
   * Sends prompt to master's latest attempt
   */
  async delegateToMaster(attemptId: string, prompt: string): Promise<void> {
    try {
      await this.forgeClient.followUpTaskAttempt(attemptId, prompt);
    } catch (error) {
      console.error(`Failed to delegate to master attempt ${attemptId}:`, error);
      throw error;
    }
  }

  /**
   * Create new master orchestrator
   * Returns session info for the new master
   */
  async createMaster(
    workflow: WorkflowType,
    projectId: string,
    title: string,
    prompt: string
  ): Promise<SessionInfo> {
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
    } catch (error) {
      console.error(`Failed to create ${workflow} master:`, error);
      throw error;
    }
  }

  /**
   * Get or create master orchestrator
   * Reuses existing master if found, creates new one if not
   */
  async getOrCreateMaster(
    workflow: WorkflowType,
    projectId: string,
    title: string,
    prompt: string
  ): Promise<SessionInfo> {
    // Try to find existing master
    const existing = await this.getSession(workflow, projectId);
    if (existing) {
      return existing;
    }

    // No master found, create new one
    return await this.createMaster(workflow, projectId, title, prompt);
  }

}

/**
 * Global session manager instance
 * Shared across all MCP tool calls during server lifetime
 */
export const sessionManager = new SessionManager();
