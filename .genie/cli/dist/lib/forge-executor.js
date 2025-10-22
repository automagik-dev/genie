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
    async syncProfiles(profiles) {
        // Skip profile sync for now - Forge manages profiles separately
        // TODO: Fix profile sync API format mismatch
        return;
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
        const attempt = await this.forge.createAndStartTask(requestBody);
        return attempt.id;
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
        const newProject = await this.forge.createProject({
            name: 'Genie Sessions',
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
