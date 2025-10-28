/**
 * Forge API Client Wrapper
 * Wraps the ForgeClient with MCP-friendly error handling
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ForgeClient: BaseForgeClient } = require('../../../../src/lib/forge-client.js');

/**
 * User-facing error for MCP tools
 * Thrown when user input is invalid or operation cannot be completed
 */
export class UserError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'UserError';
  }
}

/**
 * Enhanced Forge Client with better error handling for MCP
 */
export class ForgeClient {
  private client: typeof BaseForgeClient.prototype;

  constructor(baseUrl: string = 'http://localhost:8887', token?: string) {
    this.client = new BaseForgeClient(baseUrl, token);
  }

  /**
   * Wrap API calls with user-friendly error messages
   */
  private async wrap<T>(operation: () => Promise<T>, context: string): Promise<T> {
    try {
      return await operation();
    } catch (error: any) {
      // Parse error message
      const message = error.message || 'Unknown error';

      // Handle common HTTP errors
      if (message.includes('[404]')) {
        throw new UserError(`${context}: Resource not found`, { original: message });
      }
      if (message.includes('[401]') || message.includes('[403]')) {
        throw new UserError(`${context}: Authentication failed. Please check your API key.`, { original: message });
      }
      if (message.includes('[400]')) {
        throw new UserError(`${context}: Invalid request. ${message}`, { original: message });
      }
      if (message.includes('[500]')) {
        throw new UserError(`${context}: Server error. Please try again later.`, { original: message });
      }

      // Generic error
      throw new UserError(`${context}: ${message}`, { original: message });
    }
  }

  // ============================================================================
  // HEALTH & SYSTEM
  // ============================================================================

  async healthCheck() {
    return this.wrap(() => this.client.healthCheck(), 'Health check');
  }

  async getSystemInfo() {
    return this.wrap(() => this.client.getSystemInfo(), 'Get system info');
  }

  async getExecutorProfiles() {
    // Prefer /api/info which already contains executor profiles under a stable shape
    // This avoids strict schema issues from /api/profiles (e.g., missing top-level `executors`).
    return this.wrap(async () => {
      const response: any = await this.client.getSystemInfo();
      // Base client returns { success, data: {...} }, so unwrap it
      const info = response?.data || response;

      if (process.env.DEBUG_FORGE_PROFILES === '1') {
        console.log('[DEBUG] getExecutorProfiles: response keys:', Object.keys(response || {}));
        console.log('[DEBUG] getExecutorProfiles: info keys:', Object.keys(info || {}));
        console.log('[DEBUG] getExecutorProfiles: has executors:', !!info?.executors);
      }

      // Normalize to the same shape expected by callers of this method
      // Priority order:
      // 1) info.executors (current API format from /api/info)
      // 2) info.executor_profiles (legacy fallback)
      // 3) info.profiles (legacy fallback)
      // 4) Fallback to direct /api/profiles
      const profiles = info?.executors || info?.executor_profiles || info?.profiles;
      if (profiles) {
        // Ensure consistent shape: { executors: {...} }
        if (profiles.executors) {
          return profiles;
        } else {
          return { executors: profiles };
        }
      }
      // Fallback for older servers
      if (process.env.DEBUG_FORGE_PROFILES === '1') {
        console.log('[DEBUG] getExecutorProfiles: falling back to getExecutorProfiles()');
      }
      return await this.client.getExecutorProfiles();
    }, 'Get executor profiles');
  }

  // ============================================================================
  // PROJECTS
  // ============================================================================

  async listProjects() {
    return this.wrap(() => this.client.listProjects(), 'List projects');
  }

  async createProject(project: any) {
    return this.wrap(() => this.client.createProject(project), 'Create project');
  }

  async getProject(id: string) {
    return this.wrap(() => this.client.getProject(id), `Get project ${id}`);
  }

  async updateProject(id: string, updates: any) {
    return this.wrap(() => this.client.updateProject(id, updates), `Update project ${id}`);
  }

  async deleteProject(id: string) {
    return this.wrap(() => this.client.deleteProject(id), `Delete project ${id}`);
  }

  async listProjectBranches(id: string) {
    return this.wrap(() => this.client.listProjectBranches(id), `List branches for project ${id}`);
  }

  async searchProjectFiles(id: string, query: string, mode: 'FileName' | 'DirectoryName' | 'FullPath' = 'FileName') {
    return this.wrap(() => this.client.searchProjectFiles(id, query, mode), `Search files in project ${id}`);
  }

  // ============================================================================
  // TASKS
  // ============================================================================

  async listTasks(projectId: string) {
    return this.wrap(() => this.client.listTasks(projectId), `List tasks for project ${projectId}`);
  }

  async createTask(projectId: string, task: any) {
    return this.wrap(() => this.client.createTask(projectId, task), `Create task in project ${projectId}`);
  }

  async createAndStartTask(projectId: string, request: any) {
    return this.wrap(() => this.client.createAndStartTask(projectId, request), `Create and start task in project ${projectId}`);
  }

  async getTask(projectId: string, taskId: string) {
    return this.wrap(() => this.client.getTask(projectId, taskId), `Get task ${taskId}`);
  }

  async updateTask(projectId: string, taskId: string, updates: any) {
    return this.wrap(() => this.client.updateTask(projectId, taskId, updates), `Update task ${taskId}`);
  }

  async deleteTask(projectId: string, taskId: string) {
    return this.wrap(() => this.client.deleteTask(projectId, taskId), `Delete task ${taskId}`);
  }

  // ============================================================================
  // TASK ATTEMPTS
  // ============================================================================

  async listTaskAttempts(taskId?: string) {
    return this.wrap(() => this.client.listTaskAttempts(taskId), 'List task attempts');
  }

  async createTaskAttempt(request: any) {
    return this.wrap(() => this.client.createTaskAttempt(request), 'Create task attempt');
  }

  async getTaskAttempt(id: string) {
    return this.wrap(() => this.client.getTaskAttempt(id), `Get task attempt ${id}`);
  }

  async followUpTaskAttempt(id: string, prompt: string) {
    return this.wrap(() => this.client.followUpTaskAttempt(id, prompt), `Follow up task attempt ${id}`);
  }

  async stopTaskAttemptExecution(id: string) {
    return this.wrap(() => this.client.stopTaskAttemptExecution(id), `Stop task attempt ${id}`);
  }

  async getTaskAttemptBranchStatus(id: string) {
    return this.wrap(() => this.client.getTaskAttemptBranchStatus(id), `Get branch status for task attempt ${id}`);
  }

  async rebaseTaskAttempt(id: string, baseBranch: string) {
    return this.wrap(() => this.client.rebaseTaskAttempt(id, baseBranch), `Rebase task attempt ${id}`);
  }

  async mergeTaskAttempt(id: string) {
    return this.wrap(() => this.client.mergeTaskAttempt(id), `Merge task attempt ${id}`);
  }

  async pushTaskAttemptBranch(id: string) {
    return this.wrap(() => this.client.pushTaskAttemptBranch(id), `Push task attempt ${id}`);
  }

  async createTaskAttemptPullRequest(id: string, request: any) {
    return this.wrap(() => this.client.createTaskAttemptPullRequest(id, request), `Create PR for task attempt ${id}`);
  }

  async attachExistingPullRequest(id: string, prNumber: number) {
    return this.wrap(() => this.client.attachExistingPullRequest(id, prNumber), `Attach PR to task attempt ${id}`);
  }

  async changeTaskAttemptTargetBranch(id: string, targetBranch: string) {
    return this.wrap(() => this.client.changeTaskAttemptTargetBranch(id, targetBranch), `Change target branch for task attempt ${id}`);
  }

  async replaceTaskAttemptProcess(id: string, request: any) {
    return this.wrap(() => this.client.replaceTaskAttemptProcess(id, request), `Replace process for task attempt ${id}`);
  }

  // ============================================================================
  // EXECUTION PROCESSES
  // ============================================================================

  async listExecutionProcesses(taskAttemptId: string, showSoftDeleted = false) {
    return this.wrap(() => this.client.listExecutionProcesses(taskAttemptId, showSoftDeleted), `List execution processes for task attempt ${taskAttemptId}`);
  }

  async getExecutionProcess(id: string) {
    return this.wrap(() => this.client.getExecutionProcess(id), `Get execution process ${id}`);
  }

  async stopExecutionProcess(id: string) {
    return this.wrap(() => this.client.stopExecutionProcess(id), `Stop execution process ${id}`);
  }

  // ============================================================================
  // TEMPLATES
  // ============================================================================

  async listTaskTemplates(options?: any) {
    return this.wrap(() => this.client.listTaskTemplates(options), 'List task templates');
  }

  async createTaskTemplate(template: any) {
    return this.wrap(() => this.client.createTaskTemplate(template), 'Create task template');
  }

  async getTaskTemplate(templateId: string) {
    return this.wrap(() => this.client.getTaskTemplate(templateId), `Get task template ${templateId}`);
  }

  async updateTaskTemplate(templateId: string, updates: any) {
    return this.wrap(() => this.client.updateTaskTemplate(templateId, updates), `Update task template ${templateId}`);
  }

  async deleteTaskTemplate(templateId: string) {
    return this.wrap(() => this.client.deleteTaskTemplate(templateId), `Delete task template ${templateId}`);
  }

  // ============================================================================
  // IMAGES
  // ============================================================================

  async uploadImage(file: any) {
    return this.wrap(() => this.client.uploadImage(file), 'Upload image');
  }

  async uploadTaskImage(taskId: string, file: any) {
    return this.wrap(() => this.client.uploadTaskImage(taskId, file), `Upload image for task ${taskId}`);
  }

  async getTaskImages(taskId: string) {
    return this.wrap(() => this.client.getTaskImages(taskId), `Get images for task ${taskId}`);
  }

  async deleteImage(id: string) {
    return this.wrap(() => this.client.deleteImage(id), `Delete image ${id}`);
  }

  // ============================================================================
  // APPROVALS
  // ============================================================================

  async createApprovalRequest(request: any) {
    return this.wrap(() => this.client.createApprovalRequest(request), 'Create approval request');
  }

  async getApprovalStatus(id: string) {
    return this.wrap(() => this.client.getApprovalStatus(id), `Get approval status ${id}`);
  }

  async respondToApprovalRequest(id: string, approved: boolean, comment?: string) {
    return this.wrap(() => this.client.respondToApprovalRequest(id, approved, comment), `Respond to approval ${id}`);
  }

  async getPendingApprovals() {
    return this.wrap(() => this.client.getPendingApprovals(), 'Get pending approvals');
  }

  // ============================================================================
  // DRAFTS
  // ============================================================================

  async saveDraft(id: string, type: string, content: any) {
    return this.wrap(() => this.client.saveDraft(id, type, content), `Save draft for task attempt ${id}`);
  }

  async getDraft(id: string, type: string) {
    return this.wrap(() => this.client.getDraft(id, type), `Get draft for task attempt ${id}`);
  }

  async deleteDraft(id: string, type: string) {
    return this.wrap(() => this.client.deleteDraft(id, type), `Delete draft for task attempt ${id}`);
  }

  // ============================================================================
  // FILESYSTEM
  // ============================================================================

  async listDirectory(path?: string) {
    return this.wrap(() => this.client.listDirectory(path), 'List directory');
  }

  async listGitRepositories(path?: string) {
    return this.wrap(() => this.client.listGitRepositories(path), 'List git repositories');
  }
}
