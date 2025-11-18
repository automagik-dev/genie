// @ts-ignore - forge-client.js is compiled JS without type declarations
import { getForgeConfig, getMcpConfig } from './service-config.js';
import { ForgeClient } from '../../../src/lib/forge-client.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface ForgeExecutorConfig {
  forgeBaseUrl: string;
  forgeToken?: string;
  genieProjectId?: string;
}

export interface CreateTaskParams {
  agentName: string;
  prompt: string;
  executorKey: string;
  executorVariant?: string;
  executionMode: string;
  model?: string;
  name?: string;
}

export interface CreateTaskResult {
  attemptId: string;
  taskId: string;
  projectId: string;
  forgeUrl: string;
}

export interface ForgeTaskSummary {
  id: string;
  name: string;
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

  async createTask(params: CreateTaskParams): Promise<CreateTaskResult> {
    const { agentName, prompt, executorKey, executorVariant, executionMode, model, name } = params;

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

    // Generate task title: use provided name or extract from prompt
    const emojiPrefix = this.getAgentEmoji(agentName);
    let taskTitle: string;

    if (name) {
      // User-provided name
      taskTitle = `[${emojiPrefix}] ${name}`;
    } else {
      // Smart default: extract keywords from prompt
      const smartName = this.generateSmartTaskName(prompt);
      taskTitle = `[${emojiPrefix}] ${smartName}`;
    }

    const requestBody = {
      task: {
        project_id: projectId,
        title: taskTitle,
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

  async resumeTask(taskId: string, followUpPrompt: string): Promise<void> {
    await this.forge.followUpTaskAttempt(taskId, followUpPrompt);
  }

  async stopTask(taskId: string): Promise<void> {
    await this.forge.stopTaskAttemptExecution(taskId);
  }

  async getTaskStatus(taskId: string): Promise<{ status: string }> {
    const attempt = await this.forge.getTaskAttempt(taskId);
    return { status: attempt.status || 'unknown' };
  }

  async fetchTaskLogs(taskId: string): Promise<string | null> {
    try {
      const processes = await this.forge.listExecutionProcesses(taskId);
      if (!Array.isArray(processes) || !processes.length) return null;
      const latest = processes[processes.length - 1];
      return latest?.output || null;
    } catch {
      return null;
    }
  }

  async listTasks(): Promise<ForgeTaskSummary[]> {
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
      const displayName = task?.title || attempt.description || attempt.id;
      return {
        id: attempt.id,  // ✅ Now returns attempt ID (UUID) instead of task ID
        name: displayName,
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
      // Use git root directory (works for both main workspace and worktrees)
      // This prevents worktrees from creating duplicate projects
      let repoRoot: string;
      try {
        repoRoot = execSync('git rev-parse --show-toplevel', {
          encoding: 'utf8',
          cwd: process.cwd(),
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
      } catch {
        // Fallback to process.cwd() if not in git repo
        repoRoot = process.cwd();
      }

      const projects = await this.forge.listProjects();
      const existingProject = projects.find((p: any) => p.git_repo_path === repoRoot);

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
          cwd: repoRoot,
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
          const dirName = path.basename(repoRoot);
          if (dirName) {
            projectName = dirName;
          }
        } catch {
          // Keep default "Genie Project"
        }
      }

      const newProject = await this.forge.createProject({
        name: projectName,
        git_repo_path: repoRoot,
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

  /**
   * Generate a smart task name from the prompt by extracting keywords
   * Examples:
   *   "Fix authentication bug in login" → "fix-authentication-bug"
   *   "Daily health check" → "daily-health-check"
   *   "Analyze performance metrics" → "analyze-performance-metrics"
   */
  private generateSmartTaskName(prompt: string): string {
    // Remove common filler words
    const stopWords = new Set([
      'a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
      'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has',
      'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may',
      'might', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they'
    ]);

    // Extract first ~6 meaningful words
    const words = prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ') // Remove special chars
      .split(/\s+/)
      .filter(w => w.length > 0 && !stopWords.has(w))
      .slice(0, 6); // Take first 6 keywords

    if (words.length === 0) {
      // Fallback if no keywords found
      return 'task-' + Date.now().toString().slice(-6);
    }

    return words.join('-');
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
    forgeBaseUrl: process.env.FORGE_BASE_URL || getForgeConfig().baseUrl,
    forgeToken: process.env.FORGE_TOKEN,
    genieProjectId: process.env.GENIE_PROJECT_ID
  };

  return new ForgeExecutor({ ...defaultConfig, ...config });
}
