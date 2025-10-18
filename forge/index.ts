/**
 * ForgeClient - Minimal wrapper around Forge MCP tools
 *
 * Provides type-safe interface for forge-executor.ts
 * This is a thin wrapper around mcp__automagik_forge__* tools
 */

export interface Project {
  id: string;
  name: string;
  repo_path?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: string;
  created_at: string;
  updated_at: string;
  project_id?: string;
}

export interface TaskAttempt {
  id: string;
  task_id: string;
  status: string;
  executor_profile_id?: string;
  base_branch?: string;
  branch_name?: string;
  worktree_path?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ProjectData {
  name: string;
  repo_path: string;
}

export interface TaskData {
  title: string;
  description: string;
  executor_profile_id: string;
  base_branch: string;
}

/**
 * ForgeClient - HTTP API client for Forge backend
 *
 * Makes direct HTTP calls to Forge backend at localhost:8887
 * This is a minimal implementation for Wish #120-A integration
 */
export class ForgeClient {
  private baseUrl: string;
  private token?: string;

  constructor(baseUrl: string, token?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.token = token;
  }

  /**
   * Make authenticated HTTP request to Forge API
   */
  private async request(method: string, path: string, body?: any): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const url = `${this.baseUrl}${path}`;
    const options: RequestInit = {
      method,
      headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Forge API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Forge responses are wrapped in { success, data, error_data }
    if (data.success === false) {
      throw new Error(`Forge API error: ${data.error_data || 'Unknown error'}`);
    }

    return data.data || data;
  }

  /**
   * List all projects
   * GET /api/projects
   */
  async listProjects(): Promise<Project[]> {
    const result = await this.request('GET', '/api/projects');
    return result.projects || result || [];
  }

  /**
   * Create a new project
   * POST /api/projects
   */
  async createProject(data: ProjectData): Promise<Project> {
    const result = await this.request('POST', '/api/projects', {
      name: data.name,
      repo_path: data.repo_path,
    });
    return result.project || result;
  }

  /**
   * List tasks in a project
   * GET /api/projects/:projectId/tasks
   */
  async listTasks(projectId: string): Promise<Task[]> {
    const result = await this.request('GET', `/api/projects/${projectId}/tasks`);
    return result.tasks || result || [];
  }

  /**
   * Create task and start attempt (atomic operation)
   * POST /api/projects/:projectId/tasks
   * POST /api/tasks/:taskId/attempts/start
   */
  async createAndStartTask(projectId: string, taskData: TaskData): Promise<TaskAttempt> {
    // Step 1: Create task
    const taskResult = await this.request('POST', `/api/projects/${projectId}/tasks`, {
      title: taskData.title,
      description: taskData.description,
    });

    const taskId = taskResult.task_id || taskResult.task?.id || taskResult.id;
    if (!taskId) {
      throw new Error('Failed to create task: no task_id returned');
    }

    // Step 2: Start task attempt
    const attemptResult = await this.request('POST', `/api/tasks/${taskId}/attempts/start`, {
      executor: taskData.executor_profile_id,
      base_branch: taskData.base_branch,
    });

    const attemptId = attemptResult.attempt_id || attemptResult.id;
    if (!attemptId) {
      throw new Error('Failed to start task attempt: no attempt_id returned');
    }

    // Return task attempt object
    return {
      id: attemptId,
      task_id: taskId,
      status: 'running',
      executor_profile_id: taskData.executor_profile_id,
      base_branch: taskData.base_branch,
    };
  }

  /**
   * Get task attempt details
   * GET /api/tasks/:taskId
   */
  async getTaskAttempt(attemptId: string): Promise<TaskAttempt> {
    const result = await this.request('GET', `/api/tasks/${attemptId}`);
    const task = result.task || result;

    if (!task) {
      throw new Error(`Task attempt not found: ${attemptId}`);
    }

    return {
      id: attemptId,
      task_id: task.id,
      status: task.status || 'unknown',
      created_at: task.created_at,
      updated_at: task.updated_at,
    };
  }

  /**
   * Resume task attempt with follow-up prompt
   * PUT /api/tasks/:taskId
   */
  async followUpTaskAttempt(attemptId: string, prompt: string): Promise<void> {
    await this.request('PUT', `/api/tasks/${attemptId}`, {
      description: prompt, // Send follow-up as description update
    });
  }

  /**
   * Stop task attempt execution
   * PUT /api/tasks/:taskId
   */
  async stopTaskAttemptExecution(attemptId: string): Promise<void> {
    await this.request('PUT', `/api/tasks/${attemptId}`, {
      status: 'cancelled',
    });
  }

  /**
   * Get WebSocket URL for raw logs streaming
   *
   * TODO: Implement when Forge provides WebSocket endpoint
   * For now, returns placeholder
   */
  getRawLogsStreamUrl(attemptId: string): string {
    return `${this.baseUrl}/api/task-attempts/${attemptId}/logs/stream`;
  }
}
