"use strict";
/**
 * Agent Registry - Dynamic agent metadata scanner
 *
 * Scans .genie/code/agents/ and .genie/create/agents/ directories
 * to build a registry of all available agents with their metadata.
 *
 * NOTE: Forge sync logic removed - Forge discovers .genie folders natively.
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
        await this.scanDirectory(path_1.default.join(this.workspaceRoot, '.genie/code/agents'), 'code', 'agent');
        // Scan create collective agents
        await this.scanDirectory(path_1.default.join(this.workspaceRoot, '.genie/create/agents'), 'create', 'agent');
        // Scan global neurons
        await this.scanNeurons();
    }
    /**
     * Scan neurons directory
     */
    async scanNeurons() {
        const neuronDir = path_1.default.join(this.workspaceRoot, '.genie/neurons');
        if (!fs_1.default.existsSync(neuronDir)) {
            return;
        }
        const files = fs_1.default.readdirSync(neuronDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
            const filePath = path_1.default.join(neuronDir, file);
            try {
                const content = fs_1.default.readFileSync(filePath, 'utf-8');
                // Parse frontmatter
                const frontmatterMatch = content.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n/);
                if (!frontmatterMatch) {
                    if (process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1') {
                        console.warn(`Neuron file ${filePath} missing frontmatter`);
                    }
                    continue;
                }
                const frontmatter = (0, yaml_1.parse)(frontmatterMatch[1]);
                if (!frontmatter.name) {
                    if (process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1') {
                        console.warn(`Neuron file ${filePath} missing 'name' in frontmatter`);
                    }
                    continue;
                }
                // Extract markdown body
                const markdownBody = content.substring(frontmatterMatch[0].length);
                const metadata = {
                    name: frontmatter.name,
                    description: frontmatter.description || '',
                    type: 'neuron',
                    color: frontmatter.color,
                    emoji: frontmatter.emoji,
                    forge_profile_name: frontmatter.forge_profile_name,
                    genie: frontmatter.genie,
                    // No collective for neurons (global)
                    filePath: filePath,
                    fullContent: markdownBody
                };
                // Use neuron/ prefix for namespacing
                const namespacedKey = `neuron/${frontmatter.name.toLowerCase()}`;
                this.agents.set(namespacedKey, metadata);
            }
            catch (error) {
                console.warn(`Failed to parse neuron file ${filePath}: ${error.message}`);
            }
        }
    }
    /**
     * Scan a directory for agent markdown files (recursive)
     * Pattern: If <folder>/<folder>.md exists at root level, skip scanning <folder>/*.md subfiles
     * This allows agents to have helper workflows in subfolders without registering them
     */
    async scanDirectory(dir, collective, type = 'agent') {
        if (!fs_1.default.existsSync(dir)) {
            return;
        }
        const entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path_1.default.join(dir, entry.name);
            // Recurse into subdirectories
            if (entry.isDirectory()) {
                // Check if root-level agent exists: <parent>/<folder>.md
                const rootAgentPath = path_1.default.join(dir, `${entry.name}.md`);
                // If root agent exists, skip scanning subfolder (contains helper workflows only)
                if (fs_1.default.existsSync(rootAgentPath)) {
                    continue;
                }
                await this.scanDirectory(fullPath, collective, type);
                continue;
            }
            // Process only markdown files
            if (!entry.isFile() || !entry.name.endsWith('.md')) {
                continue;
            }
            // Skip README.md files (documentation, not agent definitions)
            if (entry.name === 'README.md') {
                continue;
            }
            try {
                const content = fs_1.default.readFileSync(fullPath, 'utf-8');
                // Parse frontmatter manually (YAML between --- markers)
                // Allow optional leading whitespace/newlines before frontmatter
                const frontmatterMatch = content.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n/);
                if (!frontmatterMatch) {
                    // Only warn in debug mode
                    if (process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1') {
                        console.warn(`Agent file ${fullPath} missing frontmatter`);
                    }
                    continue;
                }
                const frontmatter = (0, yaml_1.parse)(frontmatterMatch[1]);
                if (!frontmatter.name) {
                    // Only warn in debug mode
                    if (process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1') {
                        console.warn(`Agent file ${fullPath} missing 'name' in frontmatter`);
                    }
                    continue;
                }
                // Extract markdown body (everything after frontmatter)
                const markdownBody = content.substring(frontmatterMatch[0].length);
                const metadata = {
                    name: frontmatter.name,
                    description: frontmatter.description || '',
                    type, // Set type based on parameter
                    color: frontmatter.color,
                    emoji: frontmatter.emoji, // If explicitly set in frontmatter
                    forge_profile_name: frontmatter.forge_profile_name, // Explicit Forge profile variant name
                    genie: frontmatter.genie,
                    collective,
                    filePath: fullPath,
                    fullContent: markdownBody // Store only markdown body (no YAML frontmatter)
                };
                // Use namespaced key: collective/name (prevents collisions)
                const namespacedKey = `${collective}/${frontmatter.name.toLowerCase()}`;
                this.agents.set(namespacedKey, metadata);
            }
            catch (error) {
                console.warn(`Failed to parse agent file ${fullPath}: ${error.message}`);
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
