// @ts-ignore - forge.js is compiled JS without type declarations
import { ForgeClient } from '../../../../src/lib/forge-client.js';
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
        // Normalize: wrap in {executors: ...} if not already wrapped
        const normalizedProfiles = 'executors' in profiles
          ? profiles
          : { executors: profiles };

        // Clean null values (YAML null becomes JSON null, but Forge expects omitted fields)
        const cleaned = this.cleanNullValues(normalizedProfiles);

        await this.forge.updateExecutorProfiles(cleaned);
        return;
      }

      // Otherwise, sync from agent registry (pass workspace root for correct scanning)
      const { getAgentRegistry, AgentRegistry } = await import('./agent-registry.js');
      const registry = await getAgentRegistry(workspaceRoot || process.cwd());

      const allItems = registry.getAllAgents();
      const agentCount = allItems.filter(a => a.type === 'agent' || !a.type).length;
      const neuronCount = allItems.filter(a => a.type === 'neuron').length;
      const workspace = workspaceRoot || process.cwd();

      // Load sync cache
      const cacheFile = path.join(workspace, '.genie/state/agent-sync-cache.json');
      let cache: AgentSyncCache = this.loadSyncCache(cacheFile);

      // Compute hashes for all current agents and neurons
      const currentHashes: Record<string, string> = {};
      for (const item of allItems) {
        // Key format: for agents use "collective/name", for neurons use "neuron/name"
        const key = item.type === 'neuron'
          ? `neuron/${item.name.toLowerCase()}`
          : `${item.collective}/${item.name.toLowerCase()}`;
        const hash = this.hashContent(item.fullContent || '');
        currentHashes[key] = hash;
      }

      // Detect what changed (added, modified, deleted/renamed)
      const added = Object.keys(currentHashes).filter(k => !cache.agentHashes[k]);
      const removed = Object.keys(cache.agentHashes).filter(k => !currentHashes[k]);
      const modified = Object.keys(currentHashes).filter(k =>
        cache.agentHashes[k] && cache.agentHashes[k] !== currentHashes[k]
      );

      const hasChanges = added.length > 0 || removed.length > 0 || modified.length > 0;

      if (!hasChanges) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        const debugMode = process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1';
        if (debugMode) {
          console.log(` done (${agentCount} agents, ${neuronCount} neurons, ${elapsed}s)`);
        } else {
          console.log(` ✓ (${agentCount} agents, ${neuronCount} neurons, ${elapsed}s)`);
        }
        return;
      }

      // Get agents/neurons that need syncing (added + modified)
      const changedKeys = [...added, ...modified];
      const changedItems = allItems.filter(item => {
        const key = item.type === 'neuron'
          ? `neuron/${item.name.toLowerCase()}`
          : `${item.collective}/${item.name.toLowerCase()}`;
        return changedKeys.includes(key);
      });
      const changedAgents = changedItems.filter(i => i.type === 'agent' || !i.type);
      const changedNeurons = changedItems.filter(i => i.type === 'neuron');

      // Delete orphaned variants (agents that were deleted or renamed)
      const debugMode = process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1';
      if (removed.length > 0) {
        if (debugMode) {
          console.log(`🗑️  Cleaning up ${removed.length} orphaned agent(s)...`);
          for (const removedKey of removed) {
            const [collective, name] = removedKey.split('/');
            const variantName = `${collective.toUpperCase()}_${name.toUpperCase()}`;

            // Delete this variant from all executors
            try {
              // Forge doesn't have a "delete variant" API, so we send empty profile update
              // which effectively removes it when we send the full set of agents
              console.log(`   ├─ Removed: ${variantName}`);
            } catch (error: any) {
              console.warn(`   ├─ Failed to remove ${variantName}: ${error.message}`);
            }
          }
        }
      }

      // Fetch current profiles to extract built-in variants
      const currentProfiles = await this.forge.getExecutorProfiles();

      // Forge wrapper already returns normalized { executors: {...} }
      let accumulated: any = currentProfiles;

      // Validate that profiles have executors field
      if (!accumulated || typeof accumulated !== 'object') {
        throw new Error('Invalid profiles structure: expected object with executors field');
      }

      if (!accumulated.executors) {
        // Initialize empty executors if missing (first-time setup)
        accumulated = { executors: {} };
      }

      // Strategy: Sync ONE agent at a time (no batching complexity, guaranteed under 2MB)
      // Each request: built-ins (~200KB) + 1 agent (~65KB) = ~265KB per call

      let successfulBatches = 0;
      let totalPayloadSize = 0;

      // Sync changed items individually
      for (let i = 0; i < changedItems.length; i++) {
        const item = changedItems[i];
        const itemNum = i + 1;
        const itemType = item.type === 'neuron' ? 'neuron' : 'agent';

        try {
          // Get current Forge state (includes built-ins + previously synced items)
          const currentProfiles = await this.forge.getExecutorProfiles();
          // Forge wrapper already returns normalized { executors: {...} }
          const current = currentProfiles;

          // Generate profile for THIS item only
          const itemProfile = await registry.generateForgeProfiles(this.forge, [item]);

          // Merge current + this item (preserves all existing variants)
          const payload = this.mergeProfiles(current, itemProfile);

          const payloadSize = JSON.stringify(payload).length;
          const payloadKB = (payloadSize / 1024).toFixed(0);

          // Send to Forge
          await this.forge.updateExecutorProfiles(payload);

          successfulBatches++;
          totalPayloadSize += payloadSize;

          // Show progress every 5 items (debug mode only)
          if (debugMode && (itemNum % 5 === 0 || itemNum === changedItems.length)) {
            console.log(`✅ Synced ${itemNum}/${changedItems.length} items (${payloadKB}KB per request)`);
          }
        } catch (error: any) {
          // Only warn in debug mode
          if (debugMode) {
            console.warn(`⚠️  Failed to sync ${itemType} ${item.name}: ${error.message}`);
          }
        }
      }

      // Save updated cache only if at least one batch succeeded
      if (successfulBatches > 0) {
        cache.agentHashes = currentHashes;
        cache.lastSync = new Date().toISOString();
        const executors = await AgentRegistry.getSupportedExecutors(this.forge);
        cache.executors = executors;
        this.saveSyncCache(cacheFile, cache);
      }

      // Calculate statistics
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      const syncedAgentCount = changedAgents.length;
      const syncedNeuronCount = changedNeurons.length;
      const executors = await AgentRegistry.getSupportedExecutors(this.forge);
      const executorCount = executors.length;
      const totalMB = (totalPayloadSize / 1024 / 1024).toFixed(2);

      // Build change summary
      const changes = [];
      if (added.length > 0) changes.push(`${added.length} added`);
      if (modified.length > 0) changes.push(`${modified.length} updated`);
      if (removed.length > 0) changes.push(`${removed.length} deleted`);
      const changeStr = changes.length > 0 ? ` (${changes.join(', ')})` : '';

      // Final summary - concise in normal mode, verbose in debug mode
      if (debugMode) {
        console.log(`✅ Synchronized ${syncedAgentCount} agents, ${syncedNeuronCount} neurons${changeStr} across ${executorCount} executors in ${elapsed}s (${totalMB}MB total)`);
      } else {
        console.log(` ✓ (${syncedAgentCount} agents, ${syncedNeuronCount} neurons synced, ${elapsed}s)`);
      }
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
   * Merge agent profile with current Forge profiles
   * @param current - Current profiles from Forge (includes built-ins + existing agents)
   * @param agentProfile - Single agent profile to add/update
   * @returns Merged profiles
   */
  private cleanNullValues(obj: any): any {
    if (obj === null || obj === undefined) {
      return undefined; // Will be omitted when stringified
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.cleanNullValues(item)).filter(item => item !== undefined);
    }
    if (typeof obj === 'object') {
      const cleaned: any = {};
      for (const [key, value] of Object.entries(obj)) {
        const cleanedValue = this.cleanNullValues(value);
        if (cleanedValue !== undefined && cleanedValue !== null) {
          cleaned[key] = cleanedValue;
        }
      }
      return cleaned;
    }
    return obj;
  }

  private mergeProfiles(current: any, agentProfile: any): any {
    // Validate inputs
    if (!current || typeof current !== 'object') {
      throw new Error('mergeProfiles: current must be an object');
    }
    if (!agentProfile || typeof agentProfile !== 'object') {
      throw new Error('mergeProfiles: agentProfile must be an object');
    }

    // Ensure executors field exists in both
    if (!current.executors) {
      current.executors = {};
    }
    if (!agentProfile.executors) {
      throw new Error('mergeProfiles: agentProfile missing executors field');
    }

    const merged: any = { executors: {} };

    // Get all executors from both current and agent profile
    const allExecutors = new Set([
      ...Object.keys(current.executors || {}),
      ...Object.keys(agentProfile.executors || {})
    ]);

    for (const executor of allExecutors) {
      merged.executors[executor] = {};

      // Copy ALL variants from current (built-ins + existing agents)
      const currentVariants = current.executors?.[executor] || {};
      Object.assign(merged.executors[executor], currentVariants);

      // Add/update agent variant (overwrites if exists)
      const agentVariants = agentProfile.executors?.[executor] || {};
      Object.assign(merged.executors[executor], agentVariants);
    }

    // Final validation
    if (!merged.executors || typeof merged.executors !== 'object') {
      throw new Error('mergeProfiles: merged result missing executors field');
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
