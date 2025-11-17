"use strict";
/**
 * Task Manager - Query Forge for master orchestrators
 *
 * Phase 2: Prevents orphaned tasks by reusing master orchestrators
 * Architecture: Query Forge database for existing masters (persists across restarts)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.taskManager = exports.TaskManager = void 0;
const path_1 = __importDefault(require("path"));
const service_config_js_1 = require("../lib/service-config.js");
// Load ForgeClient from src/lib (resolves from package root)
// Compiled location: dist/mcp/lib/session-manager.js
// Target: src/lib/forge-client.js
const geniePackageRoot = path_1.default.resolve(__dirname, '../../..');
const ForgeClient = require(path_1.default.join(geniePackageRoot, 'src/lib/forge-client.js')).ForgeClient;
const { baseUrl: FORGE_URL } = (0, service_config_js_1.getForgeConfig)();
class TaskManager {
    constructor() {
        this.forgeClient = new ForgeClient(FORGE_URL);
    }
    /**
     * Get agent definition for workflow type
     * Looks up neuron agent from registry, falls back to hardcoded variant
     */
    async getAgentForWorkflow(workflow) {
        try {
            // Import agent registry (resolve from global package or workspace)
            // @ts-ignore - Dynamic import from compiled CLI
            const { getAgentRegistry } = await import('../../cli/lib/agent-registry.js');
            const registry = await getAgentRegistry();
            // Try to find neuron agent by workflow name
            // Neurons are registered as "neuron/${workflow}" without collective
            // e.g., "wish" -> registry key "neuron/wish"
            const neuronAgent = registry.getAgent(workflow);
            if (neuronAgent) {
                // Derive forge_profile_name: use explicit or derive from neuron name
                const profileName = neuronAgent.forge_profile_name
                    || (neuronAgent.type === 'neuron' ? neuronAgent.name.toUpperCase() : workflow.toUpperCase());
                return {
                    forge_profile_name: profileName,
                    executor: neuronAgent.genie?.executor || 'CLAUDE_CODE',
                    model: neuronAgent.forge?.model, // Model moved to forge namespace
                    background: neuronAgent.genie?.background
                };
            }
        }
        catch (error) {
            // Registry not available, fall back
            console.warn(`Failed to load agent for workflow ${workflow}, using fallback`);
        }
        // Fallback: Use uppercase workflow name (WISH, FORGE, REVIEW, MASTER)
        return {
            forge_profile_name: workflow.toUpperCase(),
            executor: 'CLAUDE_CODE'
        };
    }
    /**
     * Get existing master orchestrator for workflow + project
     * Uses new forge_agents table (persistent, no status-based filtering)
     */
    async getTask(workflow, projectId) {
        try {
            // Query forge_agents table for this workflow type
            const agents = await this.forgeClient.getForgeAgents(projectId, workflow);
            if (agents && agents.length > 0) {
                const agent = agents[0];
                // Get the task details
                const task = await this.forgeClient.getTask(projectId, agent.task_id);
                // Get latest attempt
                const attempts = await this.forgeClient.listTaskAttempts(agent.task_id);
                const latestAttempt = attempts
                    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
                if (latestAttempt) {
                    return {
                        taskId: agent.task_id,
                        attemptId: latestAttempt.id,
                        url: `${FORGE_URL}/projects/${projectId}/tasks/${agent.task_id}/attempts/${latestAttempt.id}?view=diffs`,
                        projectId,
                        created: agent.created_at,
                        lastUsed: agent.updated_at
                    };
                }
            }
            return null;
        }
        catch (error) {
            console.error(`Failed to query Forge for ${workflow} master:`, error);
            return null;
        }
    }
    /**
     * Delegate work to existing master via follow-up
     * Sends prompt to master's latest attempt
     */
    async delegateToMaster(attemptId, prompt) {
        try {
            await this.forgeClient.followUpTaskAttempt(attemptId, prompt);
        }
        catch (error) {
            console.error(`Failed to delegate to master attempt ${attemptId}:`, error);
            throw error;
        }
    }
    /**
     * Create new master orchestrator
     * Returns task info for the new master
     */
    async createMaster(workflow, projectId, title, prompt) {
        try {
            // Create the agent entry and its fixed task
            const agent = await this.forgeClient.createForgeAgent(projectId, workflow);
            // Lookup agent definition from registry
            const agentConfig = await this.getAgentForWorkflow(workflow);
            // Start the first attempt with the initial prompt
            const attempt = await this.forgeClient.createTaskAttempt({
                task_id: agent.task_id,
                executor_profile_id: {
                    executor: agentConfig.executor || 'CLAUDE_CODE',
                    variant: agentConfig.forge_profile_name || workflow.toUpperCase()
                },
                base_branch: 'main'
            });
            // Send the initial prompt as a follow-up
            await this.forgeClient.followUpTaskAttempt(attempt.id, prompt);
            return {
                taskId: agent.task_id,
                attemptId: attempt.id,
                url: `${FORGE_URL}/projects/${projectId}/tasks/${agent.task_id}/attempts/${attempt.id}?view=diffs`,
                projectId,
                created: agent.created_at,
                lastUsed: agent.updated_at
            };
        }
        catch (error) {
            console.error(`Failed to create ${workflow} master:`, error);
            throw error;
        }
    }
    /**
     * Get or create master orchestrator
     * Reuses existing master if found, creates new one if not
     */
    async getOrCreateMaster(workflow, projectId, title, prompt) {
        // Try to find existing master
        const existing = await this.getTask(workflow, projectId);
        if (existing) {
            return existing;
        }
        // No master found, create new one
        return await this.createMaster(workflow, projectId, title, prompt);
    }
}
exports.TaskManager = TaskManager;
/**
 * Global task manager instance
 * Shared across all MCP tool calls during server lifetime
 */
exports.taskManager = new TaskManager();
