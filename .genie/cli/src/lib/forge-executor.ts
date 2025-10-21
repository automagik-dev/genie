// @ts-ignore - forge.js is compiled JS without type declarations
import { ForgeClient } from '../../../../forge.js';
import { execSync } from 'child_process';

export interface ForgeExecutorConfig {
  forgeBaseUrl: string;
  forgeToken?: string;
  genieProjectId?: string;
}

export interface CreateSessionParams {
  agentName: string;
  prompt: string;
  executorKey: string;
  executorVariant?: string;
  executionMode: string;
  model?: string;
}

export interface ForgeSessionSummary {
  id: string;
  agent: string;
  status: string;
  executor?: string | null;
  variant?: string | null;
  model?: string | null;
  created?: string;
  updated?: string;
}

export class ForgeExecutor {
  private forge: ForgeClient;
  private config: ForgeExecutorConfig;

  constructor(config: ForgeExecutorConfig) {
    this.config = config;
    this.forge = new ForgeClient(config.forgeBaseUrl, config.forgeToken);
  }

  async syncProfiles(profiles?: Record<string, any>): Promise<void> {
    // Skip profile sync for now - Forge manages profiles separately
    // TODO: Fix profile sync API format mismatch
    return;
  }

  async createSession(params: CreateSessionParams): Promise<string> {
    const { agentName, prompt, executorKey, executorVariant, executionMode, model } = params;

    const projectId = await this.getOrCreateGenieProject();

    // Detect current git branch and use it as base_branch
    let baseBranch = 'main'; // Default fallback
    try {
      baseBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', cwd: process.cwd() }).trim();
      await this.forge.updateProject(projectId, { default_base_branch: baseBranch });
    } catch (error) {
      // If git detection fails, try to get default_base_branch from project
      try {
        const project = await this.forge.getProject(projectId);
        if (project.default_base_branch) {
          baseBranch = project.default_base_branch;
        }
      } catch {
        // Use fallback 'main'
      }
    }

    const requestBody = {
      task: {
        project_id: projectId,
        title: `Genie: ${agentName} (${executionMode})`,
        description: prompt
      },
      executor_profile_id: this.mapExecutorToProfile(executorKey, executorVariant, model),
      base_branch: baseBranch
    };

    const attempt = await this.forge.createAndStartTask(requestBody);
    return attempt.id;
  }

  async resumeSession(sessionId: string, followUpPrompt: string): Promise<void> {
    await this.forge.followUpTaskAttempt(sessionId, followUpPrompt);
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.forge.stopTaskAttemptExecution(sessionId);
  }

  async getSessionStatus(sessionId: string): Promise<{ status: string }> {
    const attempt = await this.forge.getTaskAttempt(sessionId);
    return { status: attempt.status || 'unknown' };
  }

  async fetchLatestLogs(sessionId: string): Promise<string | null> {
    try {
      const processes = await this.forge.listExecutionProcesses(sessionId);
      if (!Array.isArray(processes) || !processes.length) return null;
      const latest = processes[processes.length - 1];
      return latest?.output || null;
    } catch {
      return null;
    }
  }

  async listSessions(): Promise<ForgeSessionSummary[]> {
    const projectId = await this.getOrCreateGenieProject();
    const tasks = await this.forge.listTasks(projectId);
    return tasks.map((task: any) => ({
      id: task.id,
      agent: this.extractAgentNameFromTitle(task.title),
      status: task.status || 'unknown',
      executor: (task.executor_profile_id?.executor || '').toLowerCase() || null,
      variant: task.executor_profile_id?.variant || null,
      model: task.executor_profile_id?.model || null,
      created: task.created_at,
      updated: task.updated_at
    }));
  }

  private async getOrCreateGenieProject(): Promise<string> {
    if (this.config.genieProjectId) {
      return this.config.genieProjectId;
    }

    const currentRepoPath = process.cwd();
    const projects = await this.forge.listProjects();
    const existingProject = projects.find((p: any) => p.git_repo_path === currentRepoPath);

    if (existingProject) {
      this.config.genieProjectId = existingProject.id;
      return existingProject.id;
    }

    const newProject = await this.forge.createProject({
      name: 'Genie Sessions',
      git_repo_path: currentRepoPath,
      use_existing_repo: true
    });

    this.config.genieProjectId = newProject.id;
    return newProject.id;
  }

  private mapExecutorToProfile(
    executorKey: string,
    variant?: string,
    model?: string
  ): { executor: string; variant: string; model?: string } {
    const mapping: Record<string, string> = {
      'claude': 'CLAUDE_CODE',
      'claude-code': 'CLAUDE_CODE',
      'codex': 'CODEX',
      'opencode': 'OPENCODE',
      'gemini': 'GEMINI',
      'cursor': 'CURSOR',
      'qwen_code': 'QWEN_CODE',
      'amp': 'AMP',
      'copilot': 'COPILOT'
    };

    const normalizedKey = executorKey.trim().toLowerCase();
    const executor = mapping[normalizedKey] || normalizedKey.toUpperCase();
    const resolvedVariant = (variant || 'DEFAULT').toUpperCase();

    const profile: { executor: string; variant: string; model?: string } = {
      executor,
      variant: resolvedVariant
    };

    if (model && model.trim().length) {
      profile.model = model.trim();
    }

    return profile;
  }

  private extractAgentNameFromTitle(title: string): string {
    const match = title.match(/^Genie: ([^\(]+)/);
    return match ? match[1].trim() : title;
  }
}

export function createForgeExecutor(config: Partial<ForgeExecutorConfig> = {}): ForgeExecutor {
  const defaultConfig: ForgeExecutorConfig = {
    forgeBaseUrl: process.env.FORGE_BASE_URL || 'http://localhost:8888',
    forgeToken: process.env.FORGE_TOKEN,
    genieProjectId: process.env.GENIE_PROJECT_ID
  };

  return new ForgeExecutor({ ...defaultConfig, ...config });
}
