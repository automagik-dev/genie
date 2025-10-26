/**
 * Agent Registry - Dynamic agent metadata scanner and Forge profile sync
 *
 * Scans .genie/code/agents/ and .genie/create/agents/ directories
 * to build a registry of all available agents with their metadata.
 *
 * Syncs agent prompts to Forge profiles as `append_prompt` variants.
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYAML } from 'yaml';

export interface AgentMetadata {
  name: string;
  description: string;
  color?: string;
  emoji?: string;
  genie?: {
    executor?: string;
    executorVariant?: string;
    background?: boolean;
    model?: string;

    // Executor-specific permission flags (from Forge API 2025-10-26)
    dangerously_skip_permissions?: boolean;  // CLAUDE_CODE only
    sandbox?: string;                        // CODEX only ('danger-full-access' | 'read-only' | 'safe')
    dangerously_allow_all?: boolean;         // AMP only
    // OPENCODE has no permission flags

    // Executor-specific additional fields
    model_reasoning_effort?: string;         // CODEX only ('low' | 'medium' | 'high')
  };
  collective: 'code' | 'create';
  filePath: string;
  fullContent?: string; // Full markdown content for Forge sync
}

export class AgentRegistry {
  private agents: Map<string, AgentMetadata> = new Map();
  private workspaceRoot: string;

  constructor(workspaceRoot: string = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Scan all agent files and build registry
   */
  async scan(): Promise<void> {
    this.agents.clear();

    // Scan code collective agents
    await this.scanDirectory(path.join(this.workspaceRoot, '.genie/code/agents'), 'code');

    // Scan create collective agents
    await this.scanDirectory(path.join(this.workspaceRoot, '.genie/create/agents'), 'create');
  }

  /**
   * Scan a directory for agent markdown files (recursive)
   */
  private async scanDirectory(dir: string, collective: 'code' | 'create'): Promise<void> {
    if (!fs.existsSync(dir)) {
      return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Recurse into subdirectories
      if (entry.isDirectory()) {
        await this.scanDirectory(fullPath, collective);
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
        const content = fs.readFileSync(fullPath, 'utf-8');

        // Parse frontmatter manually (YAML between --- markers)
        // Allow optional leading whitespace/newlines before frontmatter
        const frontmatterMatch = content.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n/);
        if (!frontmatterMatch) {
          console.warn(`Agent file ${fullPath} missing frontmatter`);
          continue;
        }

        const frontmatter = parseYAML(frontmatterMatch[1]);

        if (!frontmatter.name) {
          console.warn(`Agent file ${fullPath} missing 'name' in frontmatter`);
          continue;
        }

        // Extract markdown body (everything after frontmatter)
        const markdownBody = content.substring(frontmatterMatch[0].length);

        const metadata: AgentMetadata = {
          name: frontmatter.name,
          description: frontmatter.description || '',
          color: frontmatter.color,
          emoji: frontmatter.emoji, // If explicitly set in frontmatter
          genie: frontmatter.genie,
          collective,
          filePath: fullPath,
          fullContent: markdownBody // Store only markdown body (no YAML frontmatter)
        };

        // Use namespaced key: collective/name (prevents collisions)
        const namespacedKey = `${collective}/${frontmatter.name.toLowerCase()}`;
        this.agents.set(namespacedKey, metadata);
      } catch (error: any) {
        console.warn(`Failed to parse agent file ${fullPath}: ${error.message}`);
      }
    }
  }

  /**
   * Get agent metadata by name
   * @param name - Agent name (e.g., "install")
   * @param collective - Optional collective filter (e.g., "code", "create")
   */
  getAgent(name: string, collective?: 'code' | 'create'): AgentMetadata | undefined {
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
  getAllAgents(): AgentMetadata[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get agent emoji (with fallback to default mapping)
   */
  getAgentEmoji(agentName: string): string {
    const normalized = agentName.toLowerCase().trim();

    // Try to get from registered agents first
    const agent = this.agents.get(normalized);
    if (agent?.emoji) {
      return agent.emoji;
    }

    // Fallback to default emoji mapping
    // This ensures backward compatibility while agent files are being updated
    const defaultEmojis: Record<string, string> = {
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
  hasAgent(name: string): boolean {
    return this.agents.has(name.toLowerCase());
  }

  /**
   * Get count of registered agents
   */
  count(): number {
    return this.agents.size;
  }

  /**
   * Get supported executors from Forge profiles (dynamic, not hardcoded)
   * Fallback to common executors if Forge is unavailable
   */
  static async getSupportedExecutors(forgeClient?: any): Promise<string[]> {
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
      } catch (error: any) {
        console.warn(`⚠️  Failed to fetch executors from Forge, using fallback: ${error.message}`);
      }
    }

    // Fallback to common executors if Forge unavailable
    return ['CLAUDE_CODE', 'CODEX', 'GEMINI', 'CURSOR', 'QWEN_CODE', 'AMP', 'OPENCODE', 'COPILOT'];
  }

  /**
   * Generate Forge profiles for all agents across all executors
   * Creates a variant for each agent on each executor, inheriting required fields from DEFAULT
   * Note: Collective AGENTS.md context is NOT prepended (available via CLAUDE.md instead)
   * This reduces payload size by ~60% (from 9.5MB to ~3MB)
   * @param forgeClient - Optional ForgeClient to fetch executors dynamically
   */
  async generateForgeProfiles(forgeClient?: any): Promise<any> {
    const executors = await AgentRegistry.getSupportedExecutors(forgeClient);
    const profiles: any = { executors: {} };

    // Get current profiles to extract DEFAULT variants (for inheriting required fields)
    let defaultVariants: Record<string, any> = {};
    if (forgeClient) {
      try {
        const currentProfiles = await forgeClient.getExecutorProfiles();
        const current = typeof currentProfiles.content === 'string'
          ? JSON.parse(currentProfiles.content)
          : currentProfiles;

        // Extract DEFAULT variant config for each executor
        for (const [executor, variants] of Object.entries(current.executors || {})) {
          if ((variants as any).DEFAULT && (variants as any).DEFAULT[executor]) {
            defaultVariants[executor] = (variants as any).DEFAULT[executor];
          }
        }
      } catch (error) {
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
        if (!agent.fullContent) continue;

        // Use namespaced variant name: CODE_INSTALL, CREATE_INSTALL (explicit collective)
        const variantName = `${agent.collective.toUpperCase()}_${agent.name.toUpperCase()}`;

        // Build variant config with executor-specific fields
        const variantConfig: any = {
          // Inherit all fields from DEFAULT variant
          ...baseConfig,
          // Use agent content directly (no collective context prepended)
          append_prompt: agent.fullContent
        };

        // Add executor-specific permission flags from frontmatter
        if (executor === 'CLAUDE_CODE' && agent.genie?.dangerously_skip_permissions !== undefined) {
          variantConfig.dangerously_skip_permissions = agent.genie.dangerously_skip_permissions;
        }
        if (executor === 'CODEX' && agent.genie?.sandbox !== undefined) {
          variantConfig.sandbox = agent.genie.sandbox;
        }
        if (executor === 'AMP' && agent.genie?.dangerously_allow_all !== undefined) {
          variantConfig.dangerously_allow_all = agent.genie.dangerously_allow_all;
        }

        // Add executor-specific additional fields
        if (executor === 'CODEX' && agent.genie?.model_reasoning_effort !== undefined) {
          variantConfig.model_reasoning_effort = agent.genie.model_reasoning_effort;
        }

        // Add model if specified in frontmatter
        if (agent.genie?.model !== undefined) {
          variantConfig.model = agent.genie.model;
        }

        // Add background setting if specified
        if (agent.genie?.background !== undefined) {
          variantConfig.background = agent.genie.background;
        }

        profiles.executors[executor][variantName] = {
          [executor]: variantConfig
        };
      }
    }

    return profiles;
  }
}

/**
 * Global singleton instance
 */
let globalRegistry: AgentRegistry | null = null;

/**
 * Get or create global agent registry
 */
export async function getAgentRegistry(workspaceRoot?: string): Promise<AgentRegistry> {
  if (!globalRegistry || (workspaceRoot && globalRegistry['workspaceRoot'] !== workspaceRoot)) {
    globalRegistry = new AgentRegistry(workspaceRoot);
    await globalRegistry.scan();
  }
  return globalRegistry;
}

/**
 * Force rescan of agents (useful for testing or dynamic updates)
 */
export async function rescanAgents(workspaceRoot?: string): Promise<AgentRegistry> {
  if (!globalRegistry) {
    globalRegistry = new AgentRegistry(workspaceRoot);
  }
  await globalRegistry.scan();
  return globalRegistry;
}
