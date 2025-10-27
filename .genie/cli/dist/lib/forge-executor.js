"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForgeExecutor = void 0;
exports.createForgeExecutor = createForgeExecutor;
// @ts-ignore - forge.js is compiled JS without type declarations
const forge_js_1 = require("../../../../forge.js");
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class ForgeExecutor {
    constructor(config) {
        this.config = config;
        this.forge = new forge_js_1.ForgeClient(config.forgeBaseUrl, config.forgeToken);
    }
    async syncProfiles(profiles, workspaceRoot) {
        try {
            const startTime = Date.now();
            // If profiles provided, use them directly (bypass change detection)
            if (profiles) {
                await this.forge.updateExecutorProfiles(profiles);
                return;
            }
            // Otherwise, sync from agent registry (pass workspace root for correct scanning)
            const { getAgentRegistry, AgentRegistry } = await import('./agent-registry.js');
            const registry = await getAgentRegistry(workspaceRoot || process.cwd());
            const agentCount = registry.count();
            const workspace = workspaceRoot || process.cwd();
            // Load sync cache
            const cacheFile = path_1.default.join(workspace, '.genie/state/agent-sync-cache.json');
            let cache = this.loadSyncCache(cacheFile);
            // Compute hashes for all current agents
            const currentHashes = {};
            for (const agent of registry.getAllAgents()) {
                const key = `${agent.collective}/${agent.name.toLowerCase()}`;
                const hash = this.hashContent(agent.fullContent || '');
                currentHashes[key] = hash;
            }
            // Detect what changed (added, modified, deleted/renamed)
            const added = Object.keys(currentHashes).filter(k => !cache.agentHashes[k]);
            const removed = Object.keys(cache.agentHashes).filter(k => !currentHashes[k]);
            const modified = Object.keys(currentHashes).filter(k => cache.agentHashes[k] && cache.agentHashes[k] !== currentHashes[k]);
            const hasChanges = added.length > 0 || removed.length > 0 || modified.length > 0;
            if (!hasChanges) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                console.log(`✅ Agent profiles up to date (${agentCount} agents, ${elapsed}s)`);
                return;
            }
            // Get agents that need syncing (added + modified)
            const changedKeys = [...added, ...modified];
            const changedAgents = registry.getAllAgents().filter(agent => {
                const key = `${agent.collective}/${agent.name.toLowerCase()}`;
                return changedKeys.includes(key);
            });
            // Delete orphaned variants (agents that were deleted or renamed)
            if (removed.length > 0) {
                console.log(`🗑️  Cleaning up ${removed.length} orphaned agent(s)...`);
                for (const removedKey of removed) {
                    const [collective, name] = removedKey.split('/');
                    const variantName = `${collective.toUpperCase()}_${name.toUpperCase()}`;
                    // Delete this variant from all executors
                    try {
                        // Forge doesn't have a "delete variant" API, so we send empty profile update
                        // which effectively removes it when we send the full set of agents
                        console.log(`   ├─ Removed: ${variantName}`);
                    }
                    catch (error) {
                        console.warn(`   ├─ Failed to remove ${variantName}: ${error.message}`);
                    }
                }
            }
            // Batched sync strategy: Split CHANGED agents into chunks
            const allAgents = Array.from(changedAgents);
            const BATCH_SIZE = 3; // 3 agents × 8 executors = ~24 variants per request (reduced due to Forge HTTP body limit ~2MB)
            const maxPayloadSize = 2 * 1024 * 1024; // 2MB (Forge's Axum server limit)
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
                    // Send batch profiles directly - Forge merges on its end
                    // No need to fetch/merge current profiles (was causing 2MB payloads)
                    const payload = batchProfiles;
                    // Check payload size before sending
                    const payloadSize = JSON.stringify(payload).length;
                    const payloadMB = (payloadSize / 1024 / 1024).toFixed(2);
                    if (payloadSize > maxPayloadSize) {
                        console.warn(`⚠️  Batch ${batchNum}/${totalBatches} exceeds ${(maxPayloadSize / 1024 / 1024).toFixed(0)}MB (${payloadMB}MB), skipping...`);
                        skippedBatches++;
                        continue;
                    }
                    // Update Forge with batch profiles (pass object, not string)
                    await this.forge.updateExecutorProfiles(payload);
                    // DO NOT accumulate batches - each batch adds to Forge independently
                    // Accumulation was causing 2MB+ payloads (3 agents became 30+ variants)
                    totalPayloadSize += payloadSize;
                    successfulBatches++;
                    console.log(`✅ Batch ${batchNum}/${totalBatches}: ${batch.length} agents synced (${payloadMB}MB)`);
                }
                catch (error) {
                    console.warn(`⚠️  Batch ${batchNum}/${totalBatches} failed: ${error.message}`);
                    skippedBatches++;
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
            const syncedCount = changedAgents.length;
            const agentsPerSec = syncedCount > 0 ? (syncedCount / parseFloat(elapsed)).toFixed(0) : '0';
            const executors = await AgentRegistry.getSupportedExecutors(this.forge);
            const executorCount = executors.length;
            const avgPayloadMB = successfulBatches > 0 ? (totalPayloadSize / successfulBatches / 1024 / 1024).toFixed(2) : '0.00';
            // Build change summary
            const changes = [];
            if (added.length > 0)
                changes.push(`${added.length} added`);
            if (modified.length > 0)
                changes.push(`${modified.length} updated`);
            if (removed.length > 0)
                changes.push(`${removed.length} deleted`);
            const changeStr = changes.length > 0 ? ` (${changes.join(', ')})` : '';
            const batchInfo = totalBatches > 1 ? ` [${successfulBatches}/${totalBatches} batches, ${avgPayloadMB}MB avg]` : ` [${avgPayloadMB}MB]`;
            console.log(`✅ Synced ${syncedCount} agent(s)${changeStr} across ${executorCount} executors in ${elapsed}s [${agentsPerSec} agents/s${batchInfo}]`);
        }
        catch (error) {
            // Provide helpful error messages for common failures
            if (error.message?.includes('413') || error.message?.includes('Payload Too Large')) {
                console.warn(`⚠️  Failed to sync agent profiles: Payload too large for Forge server`);
                console.warn(`   Solution: Reduce number of agents or increase Forge body limit`);
                console.warn(`   Agents will still work, but won't appear in Forge executor profiles`);
            }
            else {
                console.warn(`⚠️  Failed to sync agent profiles to Forge: ${error.message}`);
            }
        }
    }
    /**
     * Load sync cache from file
     */
    loadSyncCache(cacheFile) {
        try {
            if (fs_1.default.existsSync(cacheFile)) {
                const content = fs_1.default.readFileSync(cacheFile, 'utf-8');
                return JSON.parse(content);
            }
        }
        catch (error) {
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
    saveSyncCache(cacheFile, cache) {
        try {
            const dir = path_1.default.dirname(cacheFile);
            if (!fs_1.default.existsSync(dir)) {
                fs_1.default.mkdirSync(dir, { recursive: true });
            }
            fs_1.default.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf-8');
        }
        catch (error) {
            // Non-fatal, cache will be rebuilt next time
        }
    }
    /**
     * Hash content for change detection
     */
    hashContent(content) {
        return (0, crypto_1.createHash)('sha256').update(content).digest('hex');
    }
    async createSession(params) {
        const { agentName, prompt, executorKey, executorVariant, executionMode, model } = params;
        const projectId = await this.getOrCreateGenieProject();
        // Detect current git branch and use it as base_branch
        let baseBranch = 'main'; // Default fallback
        try {
            baseBranch = (0, child_process_1.execSync)('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', cwd: process.cwd() }).trim();
            await this.forge.updateProject(projectId, { default_base_branch: baseBranch });
        }
        catch (error) {
            // If git detection fails, try to get default_base_branch from project
            try {
                const project = await this.forge.getProject(projectId);
                if (project.default_base_branch) {
                    baseBranch = project.default_base_branch;
                }
            }
            catch {
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
    async resumeSession(sessionId, followUpPrompt) {
        await this.forge.followUpTaskAttempt(sessionId, followUpPrompt);
    }
    async stopSession(sessionId) {
        await this.forge.stopTaskAttemptExecution(sessionId);
    }
    async getSessionStatus(sessionId) {
        const attempt = await this.forge.getTaskAttempt(sessionId);
        return { status: attempt.status || 'unknown' };
    }
    async fetchLatestLogs(sessionId) {
        try {
            const processes = await this.forge.listExecutionProcesses(sessionId);
            if (!Array.isArray(processes) || !processes.length)
                return null;
            const latest = processes[processes.length - 1];
            return latest?.output || null;
        }
        catch {
            return null;
        }
    }
    async listSessions() {
        const projectId = await this.getOrCreateGenieProject();
        const tasks = await this.forge.listTasks(projectId);
        return tasks.map((task) => ({
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
    async getOrCreateGenieProject() {
        if (this.config.genieProjectId) {
            return this.config.genieProjectId;
        }
        const currentRepoPath = process.cwd();
        const projects = await this.forge.listProjects();
        const existingProject = projects.find((p) => p.git_repo_path === currentRepoPath);
        if (existingProject) {
            this.config.genieProjectId = existingProject.id;
            return existingProject.id;
        }
        // Auto-detect project name from git repo or directory name
        let projectName = 'Genie Project';
        try {
            // Try git remote first
            const remoteUrl = (0, child_process_1.execSync)('git config --get remote.origin.url', {
                encoding: 'utf8',
                cwd: currentRepoPath,
                stdio: ['pipe', 'pipe', 'ignore']
            }).trim();
            // Extract repo name from URL (e.g., "automagik-genie.git" → "automagik-genie")
            const match = remoteUrl.match(/\/([^\/]+?)(\.git)?$/);
            if (match && match[1]) {
                projectName = match[1].replace(/\.git$/, '');
            }
        }
        catch {
            // Fallback to directory name if git fails
            try {
                const dirName = (0, child_process_1.execSync)('basename "$(pwd)"', {
                    encoding: 'utf8',
                    cwd: currentRepoPath,
                    stdio: ['pipe', 'pipe', 'ignore']
                }).trim();
                if (dirName) {
                    projectName = dirName;
                }
            }
            catch {
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
    mapExecutorToProfile(executorKey, variant, model) {
        // Frontmatter now uses Forge format directly (CLAUDE_CODE, OPENCODE, etc.)
        // No mapping needed - use executor as-is
        const executor = executorKey.trim().toUpperCase();
        const resolvedVariant = (variant || 'DEFAULT').toUpperCase();
        const profile = {
            executor,
            variant: resolvedVariant
        };
        if (model && model.trim().length) {
            profile.model = model.trim();
        }
        return profile;
    }
    extractAgentNameFromTitle(title) {
        // Handle old format "Genie: agent (mode)" and new emoji format "[🧞] agent: mode"
        const oldMatch = title.match(/^Genie: ([^\(]+)/);
        if (oldMatch)
            return oldMatch[1].trim();
        const emojiMatch = title.match(/^\[[\p{Emoji}]\]\s+([^:]+)/u);
        return emojiMatch ? emojiMatch[1].trim() : title;
    }
    getAgentEmoji(agentName) {
        // Map agent names to emojis per @.genie/code/skills/emoji-naming-convention.md
        const normalized = agentName.toLowerCase().trim();
        // Agent emojis
        const agentEmojis = {
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
exports.ForgeExecutor = ForgeExecutor;
function createForgeExecutor(config = {}) {
    const defaultConfig = {
        forgeBaseUrl: process.env.FORGE_BASE_URL || 'http://localhost:8887',
        forgeToken: process.env.FORGE_TOKEN,
        genieProjectId: process.env.GENIE_PROJECT_ID
    };
    return new ForgeExecutor({ ...defaultConfig, ...config });
}
