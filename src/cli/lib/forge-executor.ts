// @ts-ignore - forge-client.js is compiled JS without type declarations
import { ForgeClient } from '../../../src/lib/forge-client.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

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

export interface CreateSessionResult {
  attemptId: string;
  taskId: string;
  projectId: string;
  forgeUrl: string;
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

// NOTE: AgentSyncCache interface removed - Forge discovers .genie folders natively

export class ForgeExecutor {
  private forge: ForgeClient;
  private config: ForgeExecutorConfig;

  constructor(config: ForgeExecutorConfig) {
    this.config = config;
    this.forge = new ForgeClient(config.forgeBaseUrl, config.forgeToken);
  }

  /**
   * NOTE: syncProfiles and helper methods removed - Forge discovers .genie folders natively
   * Removed: syncProfiles, loadSyncCache, saveSyncCache, hashContent, cleanNullValues, mergeProfiles
   */

  async createSession(params: CreateSessionParams): Promise<CreateSessionResult> {
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

    // Use emoji format per @.genie/code/skills/emoji-naming-convention.md
    const emojiPrefix = this.getAgentEmoji(agentName);
    const formattedTitle = `[${emojiPrefix}] ${agentName}: ${executionMode}`;

    const requestBody = {
      task: {
        project_id: projectId,
        title: formattedTitle,
        description: prompt
      },
      executor_profile_id: this.mapExecutorToProfile(executorKey, executorVariant, model),
      base_branch: baseBranch
    };

    const response = await this.forge.createAndStartTask(requestBody);

    // Response contains: { id: taskId, project_id: projectId, attempts: [{ id: attemptId, ... }] }
    const taskId = response.id;
    const attemptId = response.attempts?.[0]?.id || response.id; // Fallback to taskId if attempts array missing

    // Build Forge URL
    const forgeUrl = `${this.config.forgeBaseUrl}/projects/${projectId}/tasks/${taskId}/attempts/${attemptId}?view=diffs`;

    return {
      attemptId,
      taskId,
      projectId,
      forgeUrl
    };
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

    // Query tasks and attempts separately
    const [tasks, allAttempts] = await Promise.all([
      this.forge.listTasks(projectId),
      this.forge.listTaskAttempts()
    ]);

    // Filter attempts to current project
    const projectAttempts = allAttempts.filter((attempt: any) => attempt.project_id === projectId);

    // Build task lookup map (task_id -> task)
    const taskMap = new Map<string, any>();
    for (const task of tasks) {
      taskMap.set(task.id, task);
    }

    // Group attempts by task_id and get latest attempt for each task
    const latestAttemptsByTask = new Map<string, any>();
    for (const attempt of projectAttempts) {
      const taskId = attempt.task_id;
      const existing = latestAttemptsByTask.get(taskId);

      // Keep the most recently created attempt for each task
      if (!existing || new Date(attempt.created_at) > new Date(existing.created_at)) {
        latestAttemptsByTask.set(taskId, attempt);
      }
    }

    // Return attempt summaries (using attempt ID, not task ID)
    return Array.from(latestAttemptsByTask.values()).map((attempt: any) => {
      const task = taskMap.get(attempt.task_id);
      return {
        id: attempt.id,  // ✅ Now returns attempt ID (UUID) instead of task ID
        agent: this.extractAgentNameFromTitle(task?.title || ''),
        status: attempt.status || 'unknown',
        executor: (attempt.executor_profile_id?.executor || '').toLowerCase() || null,
        variant: attempt.executor_profile_id?.variant || null,
        model: attempt.executor_profile_id?.model || null,
        created: attempt.created_at,
        updated: attempt.updated_at
      };
    });
  }

  /**
   * Get or create the Genie project for the current workspace
   * @returns Project ID
   * @public Exposed for install helpers and other orchestration needs
   */
  async getOrCreateGenieProject(): Promise<string> {
    if (this.config.genieProjectId) {
      return this.config.genieProjectId;
    }

    try {
      const currentRepoPath = process.cwd();
      const projects = await this.forge.listProjects();
      const existingProject = projects.find((p: any) => p.git_repo_path === currentRepoPath);

      if (existingProject) {
        this.config.genieProjectId = existingProject.id;
        return existingProject.id;
      }

      // Auto-detect project name from git repo or directory name
      let projectName = 'Genie Project';
      try {
        // Try git remote first
        const remoteUrl = execSync('git config --get remote.origin.url', {
          encoding: 'utf8',
          cwd: currentRepoPath,
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();

        // Extract repo name from URL (e.g., "automagik-genie.git" → "automagik-genie")
        const match = remoteUrl.match(/\/([^\/]+?)(\.git)?$/);
        if (match && match[1]) {
          projectName = match[1].replace(/\.git$/, '');
        }
      } catch {
        // Fallback to directory name if git fails
        try {
          const dirName = execSync('basename "$(pwd)"', {
            encoding: 'utf8',
            cwd: currentRepoPath,
            stdio: ['pipe', 'pipe', 'ignore']
          }).trim();
          if (dirName) {
            projectName = dirName;
          }
        } catch {
          // Keep default "Genie Project"
        }
      }

      const newProject = await this.forge.createProject({
        name: projectName,
        git_repo_path: currentRepoPath,
        use_existing_repo: true
      });

      this.config.genieProjectId = newProject.id;
      return newProject.id;
    } catch (error: any) {
      // Provide context for downstream error handlers
      const message = error.message || String(error);
      throw new Error(`Failed to create Forge project: ${message}`);
    }
  }

  private mapExecutorToProfile(
    executorKey: string,
    variant?: string,
    model?: string
  ): { executor: string; variant: string; model?: string } {
    // Frontmatter now uses Forge format directly (CLAUDE_CODE, OPENCODE, etc.)
    // No mapping needed - use executor as-is
    const executor = executorKey.trim().toUpperCase();
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
    // Handle old format "Genie: agent (mode)" and new emoji format "[🧞] agent: mode"
    const oldMatch = title.match(/^Genie: ([^\(]+)/);
    if (oldMatch) return oldMatch[1].trim();

    const emojiMatch = title.match(/^\[[\p{Emoji}]\]\s+([^:]+)/u);
    return emojiMatch ? emojiMatch[1].trim() : title;
  }

  private getAgentEmoji(agentName: string): string {
    // Map agent names to emojis per @.genie/code/skills/emoji-naming-convention.md
    const normalized = agentName.toLowerCase().trim();

    // Agent emojis
    const agentEmojis: Record<string, string> = {
      // Orchestrators & Planning
      'genie': '🧞',
      'wish': '💭',
      'plan': '📋',
      'forge': '⚙️',

      // Execution agents (robots do the work)
      'implementor': '🤖',
      'tests': '🤖',
      'polish': '🤖',
      'refactor': '🤖',

      // Validation & Review
      'review': '✅',

      // Tools & Utilities
      'git': '🔧',
      'release': '🚀',
      'commit': '📦',

      // Analysis & Learning
      'learn': '📚',
      'debug': '🐞',
      'analyze': '🔍',
      'thinkdeep': '🧠',

      // Communication & Consensus
      'consensus': '🤝',
      'prompt': '📝',
      'roadmap': '🗺️'
    };

    return agentEmojis[normalized] || '🧞'; // Default to genie emoji
  }
}

export function createForgeExecutor(config: Partial<ForgeExecutorConfig> = {}): ForgeExecutor {
  const defaultConfig: ForgeExecutorConfig = {
    forgeBaseUrl: process.env.FORGE_BASE_URL || 'http://localhost:8887',
    forgeToken: process.env.FORGE_TOKEN,
    genieProjectId: process.env.GENIE_PROJECT_ID
  };

  return new ForgeExecutor({ ...defaultConfig, ...config });
}
