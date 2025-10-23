"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ForgeExecutor = void 0;
exports.createForgeExecutor = createForgeExecutor;
// @ts-ignore - forge.js is compiled JS without type declarations
const forge_js_1 = require("../../../../forge.js");
const child_process_1 = require("child_process");
class ForgeExecutor {
    constructor(config) {
        this.config = config;
        this.forge = new forge_js_1.ForgeClient(config.forgeBaseUrl, config.forgeToken);
    }
    async syncProfiles(profiles, workspaceRoot) {
        try {
            // If profiles provided, use them directly
            if (profiles) {
                await this.forge.updateExecutorProfiles(profiles);
                return;
            }
            // Otherwise, sync from agent registry (pass workspace root for correct scanning)
            const { getAgentRegistry } = await import('./agent-registry.js');
            const registry = await getAgentRegistry(workspaceRoot || process.cwd());
            // Generate profiles for all agents × all executors (fetch executors from Forge dynamically)
            const agentProfiles = await registry.generateForgeProfiles(this.forge);
            // Get current Forge profiles to merge with
            const currentProfiles = await this.forge.getExecutorProfiles();
            let current = {};
            try {
                if (typeof currentProfiles === 'string') {
                    current = JSON.parse(currentProfiles);
                }
                else if (currentProfiles && typeof currentProfiles.content === 'string') {
                    current = JSON.parse(currentProfiles.content);
                }
                else if (currentProfiles && typeof currentProfiles === 'object') {
                    current = currentProfiles.content || currentProfiles;
                }
                // Validate structure - must have executors object
                if (!current.executors || typeof current.executors !== 'object') {
                    console.warn('⚠️  Current executor profiles missing "executors" field, starting fresh');
                    current = { executors: {} };
                }
            }
            catch (parseError) {
                console.warn(`⚠️  Failed to parse current executor profiles: ${parseError.message}, starting fresh`);
                current = { executors: {} };
            }
            // Merge agent profiles with existing profiles
            const merged = this.mergeProfiles(current, agentProfiles);
            // Update Forge with merged profiles (pass object, not string)
            await this.forge.updateExecutorProfiles(merged);
            // Count executors from merged profiles (dynamic, not hardcoded)
            const executorCount = Object.keys(merged.executors || {}).length;
            console.log(`✅ Synced ${registry.count()} agents to Forge across ${executorCount} executors`);
        }
        catch (error) {
            console.warn(`⚠️  Failed to sync agent profiles to Forge: ${error.message}`);
        }
    }
    /**
     * Merge agent profiles with existing Forge profiles
     * Preserves non-agent variants (DEFAULT, APPROVALS, etc.)
     */
    mergeProfiles(current, agents) {
        const merged = { executors: {} };
        // Start with current profiles
        for (const [executor, variants] of Object.entries(current.executors || {})) {
            merged.executors[executor] = { ...variants };
        }
        // Add/overwrite agent variants
        for (const [executor, variants] of Object.entries(agents.executors || {})) {
            merged.executors[executor] = merged.executors[executor] || {};
            Object.assign(merged.executors[executor], variants);
        }
        return merged;
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
        const mapping = {
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
