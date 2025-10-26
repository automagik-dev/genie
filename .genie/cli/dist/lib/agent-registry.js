"use strict";
/**
 * Agent Registry - Dynamic agent metadata scanner and Forge profile sync
 *
 * Scans .genie/code/agents/ and .genie/create/agents/ directories
 * to build a registry of all available agents with their metadata.
 *
 * Syncs agent prompts to Forge profiles as `append_prompt` variants.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRegistry = void 0;
exports.getAgentRegistry = getAgentRegistry;
exports.rescanAgents = rescanAgents;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const yaml_1 = require("yaml");
class AgentRegistry {
    constructor(workspaceRoot = process.cwd()) {
        this.agents = new Map();
        this.workspaceRoot = workspaceRoot;
    }
    /**
     * Scan all agent files and build registry
     */
    async scan() {
        this.agents.clear();
        // Scan code collective agents
        await this.scanDirectory(path_1.default.join(this.workspaceRoot, '.genie/code/agents'), 'code');
        // Scan create collective agents
        await this.scanDirectory(path_1.default.join(this.workspaceRoot, '.genie/create/agents'), 'create');
    }
    /**
     * Scan a directory for agent markdown files
     */
    async scanDirectory(dir, collective) {
        if (!fs_1.default.existsSync(dir)) {
            return;
        }
        const files = fs_1.default.readdirSync(dir);
        for (const file of files) {
            if (!file.endsWith('.md')) {
                continue;
            }
            // Skip README.md files (documentation, not agent definitions)
            if (file === 'README.md') {
                continue;
            }
            const filePath = path_1.default.join(dir, file);
            const stats = fs_1.default.statSync(filePath);
            if (!stats.isFile()) {
                continue;
            }
            try {
                const content = fs_1.default.readFileSync(filePath, 'utf-8');
                // Parse frontmatter manually (YAML between --- markers)
                // Allow optional leading whitespace/newlines before frontmatter
                const frontmatterMatch = content.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n/);
                if (!frontmatterMatch) {
                    console.warn(`Agent file ${filePath} missing frontmatter`);
                    continue;
                }
                const frontmatter = (0, yaml_1.parse)(frontmatterMatch[1]);
                if (!frontmatter.name) {
                    console.warn(`Agent file ${filePath} missing 'name' in frontmatter`);
                    continue;
                }
                // Extract markdown body (everything after frontmatter)
                const markdownBody = content.substring(frontmatterMatch[0].length);
                const metadata = {
                    name: frontmatter.name,
                    description: frontmatter.description || '',
                    color: frontmatter.color,
                    emoji: frontmatter.emoji, // If explicitly set in frontmatter
                    genie: frontmatter.genie,
                    collective,
                    filePath,
                    fullContent: markdownBody // Store only markdown body (no YAML frontmatter)
                };
                // Use namespaced key: collective/name (prevents collisions)
                const namespacedKey = `${collective}/${frontmatter.name.toLowerCase()}`;
                this.agents.set(namespacedKey, metadata);
            }
            catch (error) {
                console.warn(`Failed to parse agent file ${filePath}: ${error.message}`);
            }
        }
    }
    /**
     * Get agent metadata by name
     * @param name - Agent name (e.g., "install")
     * @param collective - Optional collective filter (e.g., "code", "create")
     */
    getAgent(name, collective) {
        const lowerName = name.toLowerCase();
        // If collective specified, use namespaced lookup
        if (collective) {
            return this.agents.get(`${collective}/${lowerName}`);
        }
        // Otherwise, search across all collectives (backward compatibility)
        // Try namespaced keys first
        for (const [key, agent] of this.agents.entries()) {
            if (key.endsWith(`/${lowerName}`)) {
                return agent;
            }
        }
        // Fallback: try non-namespaced key (legacy support)
        return this.agents.get(lowerName);
    }
    /**
     * Get all registered agents
     */
    getAllAgents() {
        return Array.from(this.agents.values());
    }
    /**
     * Get agent emoji (with fallback to default mapping)
     */
    getAgentEmoji(agentName) {
        const normalized = agentName.toLowerCase().trim();
        // Try to get from registered agents first
        const agent = this.agents.get(normalized);
        if (agent?.emoji) {
            return agent.emoji;
        }
        // Fallback to default emoji mapping
        // This ensures backward compatibility while agent files are being updated
        const defaultEmojis = {
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
            'roadmap': '🗺️',
            // Create collective
            'editor': '✏️',
            'writer': '📄',
            'researcher': '🔬'
        };
        return defaultEmojis[normalized] || '🧞'; // Default to genie emoji
    }
    /**
     * Check if agent exists
     */
    hasAgent(name) {
        return this.agents.has(name.toLowerCase());
    }
    /**
     * Get count of registered agents
     */
    count() {
        return this.agents.size;
    }
    /**
     * Get supported executors from Forge profiles (dynamic, not hardcoded)
     * Fallback to common executors if Forge is unavailable
     */
    static async getSupportedExecutors(forgeClient) {
        // If ForgeClient provided, fetch executors from Forge profiles
        if (forgeClient) {
            try {
                const profiles = await forgeClient.getExecutorProfiles();
                const profileData = typeof profiles.content === 'string'
                    ? JSON.parse(profiles.content)
                    : profiles;
                // Extract executor names from profiles.executors object
                if (profileData?.executors) {
                    return Object.keys(profileData.executors);
                }
            }
            catch (error) {
                console.warn(`⚠️  Failed to fetch executors from Forge, using fallback: ${error.message}`);
            }
        }
        // Fallback to common executors if Forge unavailable
        return ['CLAUDE_CODE', 'CODEX', 'GEMINI', 'CURSOR', 'QWEN_CODE', 'AMP', 'OPENCODE', 'COPILOT'];
    }
    /**
     * Generate Forge profiles for all agents across all executors
     * Creates a variant for each agent on each executor, inheriting required fields from DEFAULT
     * Prepends collective AGENTS.md context to each agent (code agents get .genie/code/AGENTS.md)
     * @param forgeClient - Optional ForgeClient to fetch executors dynamically
     */
    async generateForgeProfiles(forgeClient) {
        const executors = await AgentRegistry.getSupportedExecutors(forgeClient);
        const profiles = { executors: {} };
        // Load collective AGENTS.md files (prepended to all agents in that collective)
        const collectiveContexts = new Map();
        for (const collective of ['code', 'create']) {
            const collectivePath = path_1.default.join(this.workspaceRoot, `.genie/${collective}/AGENTS.md`);
            if (fs_1.default.existsSync(collectivePath)) {
                try {
                    const content = fs_1.default.readFileSync(collectivePath, 'utf-8');
                    // Extract markdown body (skip frontmatter - same logic as scanDirectory)
                    const frontmatterMatch = content.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n/);
                    const markdownBody = frontmatterMatch
                        ? content.substring(frontmatterMatch[0].length)
                        : content;
                    collectiveContexts.set(collective, markdownBody);
                }
                catch (error) {
                    console.warn(`⚠️  Failed to load ${collective} collective AGENTS.md: ${error.message}`);
                }
            }
        }
        // Get current profiles to extract DEFAULT variants (for inheriting required fields)
        let defaultVariants = {};
        if (forgeClient) {
            try {
                const currentProfiles = await forgeClient.getExecutorProfiles();
                const current = typeof currentProfiles.content === 'string'
                    ? JSON.parse(currentProfiles.content)
                    : currentProfiles;
                // Extract DEFAULT variant config for each executor
                for (const [executor, variants] of Object.entries(current.executors || {})) {
                    if (variants.DEFAULT && variants.DEFAULT[executor]) {
                        defaultVariants[executor] = variants.DEFAULT[executor];
                    }
                }
            }
            catch (error) {
                // If fetching fails, proceed without defaults
            }
        }
        // For each executor, create agent variants
        for (const executor of executors) {
            profiles.executors[executor] = profiles.executors[executor] || {};
            // Get base config from DEFAULT variant (inherits model, additional_params, etc.)
            const baseConfig = defaultVariants[executor] || {};
            // Add each agent as a variant
            for (const agent of this.agents.values()) {
                if (!agent.fullContent)
                    continue;
                // Use namespaced variant name: CODE_INSTALL, CREATE_INSTALL (explicit collective)
                const variantName = `${agent.collective.toUpperCase()}_${agent.name.toUpperCase()}`;
                // Prepend collective AGENTS.md context to agent content
                const collectiveContext = collectiveContexts.get(agent.collective) || '';
                const fullPrompt = collectiveContext
                    ? `${collectiveContext}\n\n---\n\n${agent.fullContent}`
                    : agent.fullContent;
                profiles.executors[executor][variantName] = {
                    [executor]: {
                        // Inherit all fields from DEFAULT variant
                        ...baseConfig,
                        // Override append_prompt with collective context + agent content
                        append_prompt: fullPrompt,
                        // Preserve any executor-specific settings from agent metadata
                        ...(agent.genie?.background !== undefined && { background: agent.genie.background })
                    }
                };
            }
        }
        return profiles;
    }
}
exports.AgentRegistry = AgentRegistry;
/**
 * Global singleton instance
 */
let globalRegistry = null;
/**
 * Get or create global agent registry
 */
async function getAgentRegistry(workspaceRoot) {
    if (!globalRegistry || (workspaceRoot && globalRegistry['workspaceRoot'] !== workspaceRoot)) {
        globalRegistry = new AgentRegistry(workspaceRoot);
        await globalRegistry.scan();
    }
    return globalRegistry;
}
/**
 * Force rescan of agents (useful for testing or dynamic updates)
 */
async function rescanAgents(workspaceRoot) {
    if (!globalRegistry) {
        globalRegistry = new AgentRegistry(workspaceRoot);
    }
    await globalRegistry.scan();
    return globalRegistry;
}
