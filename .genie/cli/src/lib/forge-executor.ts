// @ts-ignore - forge.js is compiled JS without type declarations
import { ForgeClient } from '../../../../forge.js';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
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

export interface AgentSyncCache {
  version: number;
  lastSync: string;
  agentHashes: Record<string, string>; // key: collective/agent-name, value: content hash
  executors: string[]; // cached executor list
}

export class ForgeExecutor {
  private forge: ForgeClient;
  private config: ForgeExecutorConfig;

  constructor(config: ForgeExecutorConfig) {
    this.config = config;
    this.forge = new ForgeClient(config.forgeBaseUrl, config.forgeToken);
  }

  async syncProfiles(profiles?: Record<string, any>, workspaceRoot?: string): Promise<void> {
    try {
      const startTime = Date.now();

      // If profiles provided, use them directly (bypass change detection)
      if (profiles) {
        await this.forge.updateExecutorProfiles(profiles);
        return;
      }

      // Otherwise, sync from agent registry (pass workspace root for correct scanning)
      const { getAgentRegistry } = await import('./agent-registry.js');
      const registry = await getAgentRegistry(workspaceRoot || process.cwd());

      const agentCount = registry.count();
      const workspace = workspaceRoot || process.cwd();

      // Load sync cache
      const cacheFile = path.join(workspace, '.genie/state/agent-sync-cache.json');
      let cache: AgentSyncCache = this.loadSyncCache(cacheFile);

      // Compute hashes for all current agents
      const currentHashes: Record<string, string> = {};
      for (const agent of registry.getAllAgents()) {
        const key = `${agent.collective}/${agent.name.toLowerCase()}`;
        const hash = this.hashContent(agent.fullContent || '');
        currentHashes[key] = hash;
      }

      // Check if anything changed
      const hasChanges = this.detectChanges(cache.agentHashes, currentHashes);

      if (!hasChanges) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✅ Agent profiles up to date (${agentCount} agents, ${elapsed}s)`);
        return;
      }

      // Get current Forge profiles to preserve DEFAULT variants
      const currentProfiles = await this.forge.getExecutorProfiles();
      let current: any = {};

      try {
        if (typeof currentProfiles === 'string') {
          current = JSON.parse(currentProfiles);
        } else if (currentProfiles && typeof currentProfiles.content === 'string') {
          current = JSON.parse(currentProfiles.content);
        } else if (currentProfiles && typeof currentProfiles === 'object') {
          current = currentProfiles.content || currentProfiles;
        }

        // Validate structure - must have executors object
        if (!current.executors || typeof current.executors !== 'object') {
          current = { executors: {} };
        }
      } catch (parseError: any) {
        current = { executors: {} };
      }

      // Batched sync strategy: Split agents into chunks to avoid payload size limits
      const allAgents = Array.from(registry.getAllAgents());
      const BATCH_SIZE = 10; // 10 agents × 8 executors = ~80 variants per request
      const maxPayloadSize = 10 * 1024 * 1024; // 10MB
      const totalBatches = Math.ceil(allAgents.length / BATCH_SIZE);

      let successfulBatches = 0;
      let skippedBatches = 0;
      let totalPayloadSize = 0;

      for (let i = 0; i < allAgents.length; i += BATCH_SIZE) {
        const batch = allAgents.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;

        try {
          // Generate profiles for this batch only
          const batchProfiles = await registry.generateForgeProfiles(this.forge, batch);

          // Build clean profiles (preserves DEFAULT, adds batch agent variants)
          const merged = this.buildCleanProfiles(current, batchProfiles);

          // Check payload size before sending
          const payloadSize = JSON.stringify(merged).length;
          const payloadMB = (payloadSize / 1024 / 1024).toFixed(2);

          if (payloadSize > maxPayloadSize) {
            console.warn(`⚠️  Batch ${batchNum}/${totalBatches} exceeds ${(maxPayloadSize/1024/1024).toFixed(0)}MB (${payloadMB}MB), skipping...`);
            skippedBatches++;
            continue;
          }

          // Update Forge with merged profiles (pass object, not string)
          await this.forge.updateExecutorProfiles(merged);

          // Update current profiles for next batch (accumulate changes)
          current = merged;

          totalPayloadSize += payloadSize;
          successfulBatches++;
          console.log(`✅ Batch ${batchNum}/${totalBatches}: ${batch.length} agents synced (${payloadMB}MB)`);
        } catch (error: any) {
          console.warn(`⚠️  Batch ${batchNum}/${totalBatches} failed: ${error.message}`);
          skippedBatches++;
        }
      }

      // Save updated cache only if at least one batch succeeded
      if (successfulBatches > 0) {
        cache.agentHashes = currentHashes;
        cache.lastSync = new Date().toISOString();
        cache.executors = Object.keys(current.executors || {});
        this.saveSyncCache(cacheFile, cache);
      }

      // Calculate statistics
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      const agentsPerSec = (agentCount / parseFloat(elapsed)).toFixed(0);
      const executorCount = cache.executors.length;
      const avgPayloadMB = (totalPayloadSize / successfulBatches / 1024 / 1024).toFixed(2);

      // Calculate change stats
      const added = Object.keys(currentHashes).filter(k => !cache.agentHashes[k]).length;
      const removed = Object.keys(cache.agentHashes).filter(k => !currentHashes[k]).length;
      const updated = Object.keys(currentHashes).filter(k =>
        cache.agentHashes[k] && cache.agentHashes[k] !== currentHashes[k]
      ).length;

      // One-line summary output
      const changes = [];
      if (added > 0) changes.push(`${added} added`);
      if (updated > 0) changes.push(`${updated} updated`);
      if (removed > 0) changes.push(`${removed} deleted`);
      const changeStr = changes.length > 0 ? ` (${changes.join(', ')})` : '';

      const batchInfo = totalBatches > 1 ? ` [${successfulBatches}/${totalBatches} batches, ${avgPayloadMB}MB avg]` : ` [${avgPayloadMB}MB]`;
      console.log(`✅ Synced ${agentCount} agents${changeStr} across ${executorCount} executors in ${elapsed}s [${agentsPerSec} agents/s${batchInfo}]`);
    } catch (error: any) {
      // Provide helpful error messages for common failures
      if (error.message?.includes('413') || error.message?.includes('Payload Too Large')) {
        console.warn(`⚠️  Failed to sync agent profiles: Payload too large for Forge server`);
        console.warn(`   Solution: Reduce number of agents or increase Forge body limit`);
        console.warn(`   Agents will still work, but won't appear in Forge executor profiles`);
      } else {
        console.warn(`⚠️  Failed to sync agent profiles to Forge: ${error.message}`);
      }
    }
  }

  /**
   * Load sync cache from file
   */
  private loadSyncCache(cacheFile: string): AgentSyncCache {
    try {
      if (fs.existsSync(cacheFile)) {
        const content = fs.readFileSync(cacheFile, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      // Cache corrupt or missing, start fresh
    }

    return {
      version: 1,
      lastSync: '',
      agentHashes: {},
      executors: []
    };
  }

  /**
   * Save sync cache to file
   */
  private saveSyncCache(cacheFile: string, cache: AgentSyncCache): void {
    try {
      const dir = path.dirname(cacheFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (error) {
      // Non-fatal, cache will be rebuilt next time
    }
  }

  /**
   * Hash content for change detection
   */
  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Detect if any agent content changed
   */
  private detectChanges(oldHashes: Record<string, string>, newHashes: Record<string, string>): boolean {
    const oldKeys = Object.keys(oldHashes);
    const newKeys = Object.keys(newHashes);

    // Check for additions or deletions
    if (oldKeys.length !== newKeys.length) {
      return true;
    }

    // Check for content changes
    for (const key of newKeys) {
      if (oldHashes[key] !== newHashes[key]) {
        return true;
      }
    }

    return false;
  }

  /**
   * Build clean profiles - preserves DEFAULT variants, replaces all agent variants
   * This implements proper deletion (removed agents won't persist)
   */
  private buildCleanProfiles(current: any, agents: any): any {
    const merged: any = { executors: {} };

    // Get all executors from both current and new profiles
    const allExecutors = new Set([
      ...Object.keys(current.executors || {}),
      ...Object.keys(agents.executors || {})
    ]);

    for (const executor of allExecutors) {
      merged.executors[executor] = {};

      // Preserve DEFAULT and non-agent variants from current profiles
      const currentVariants = current.executors?.[executor] || {};
      for (const [variantName, variantConfig] of Object.entries(currentVariants)) {
        // Keep DEFAULT, APPROVALS, and other system variants (not CODE_* or CREATE_*)
        if (variantName === 'DEFAULT' ||
            variantName === 'APPROVALS' ||
            (!variantName.startsWith('CODE_') && !variantName.startsWith('CREATE_'))) {
          merged.executors[executor][variantName] = variantConfig;
        }
      }

      // Add all agent variants from new profiles (replaces old agent variants)
      const agentVariants = agents.executors?.[executor] || {};
      Object.assign(merged.executors[executor], agentVariants);
    }

    return merged;
  }


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
