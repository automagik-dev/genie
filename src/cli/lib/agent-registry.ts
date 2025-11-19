/**
 * Agent Registry - Dynamic agent metadata scanner
 *
 * Scans .genie/code/agents/ and .genie/create/agents/ directories
 * to build a registry of all available agents with their metadata.
 *
 * NOTE: Forge sync logic removed - Forge discovers .genie folders natively.
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYAML } from 'yaml';

export interface AgentMetadata {
  name: string;
  description: string;
  type?: 'agent' | 'neuron';
  color?: string;
  emoji?: string;
  forge_profile_name?: string;

  // Genie orchestration settings (NOT synced to Forge)
  genie?: {
    executor?: string;       // Which executor to invoke (CLAUDE_CODE, CODEX, etc.)
    variant?: string;        // Which Forge profile variant to use (default: derived from collective+name)
    background?: boolean;    // Run in isolated worktree (default: false)
  };

  // Forge executor config (passed to Forge as-is, not validated by Genie)
  forge?: Record<string, any>;

  collective?: 'code' | 'create';
  filePath: string;
  fullContent?: string;
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

    // Scan base agents (universal agents, no collective assignment)
    await this.scanBaseAgents();

    // Scan code collective agents
    await this.scanDirectory(path.join(this.workspaceRoot, '.genie/code/agents'), 'code', 'agent');

    // Scan create collective agents
    await this.scanDirectory(path.join(this.workspaceRoot, '.genie/create/agents'), 'create', 'agent');

    // Scan global neurons
    await this.scanNeurons();
  }

  /**
   * Scan base agents directory (universal agents, no collective)
   */
  private async scanBaseAgents(): Promise<void> {
    const baseAgentsDir = path.join(this.workspaceRoot, '.genie/agents');
    if (!fs.existsSync(baseAgentsDir)) {
      return;
    }

    const files = fs.readdirSync(baseAgentsDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(baseAgentsDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');

        // Parse frontmatter
        const frontmatterMatch = content.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n/);
        if (!frontmatterMatch) {
          if (process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1') {
            console.warn(`Base agent file ${filePath} missing frontmatter`);
          }
          continue;
        }

        const frontmatter = parseYAML(frontmatterMatch[1]);

        if (!frontmatter.name) {
          if (process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1') {
            console.warn(`Base agent file ${filePath} missing 'name' in frontmatter`);
          }
          continue;
        }

        // Extract markdown body
        const markdownBody = content.substring(frontmatterMatch[0].length);

        const metadata: AgentMetadata = {
          name: frontmatter.name,
          description: frontmatter.description || '',
          type: 'agent',
          color: frontmatter.color,
          emoji: frontmatter.emoji,
          forge_profile_name: frontmatter.forge_profile_name,
          genie: frontmatter.genie,
          // No collective for base agents (universal)
          collective: undefined,
          filePath: filePath,
          fullContent: markdownBody
        };

        // Use base/ prefix for namespacing
        const namespacedKey = `base/${frontmatter.name.toLowerCase()}`;
        this.agents.set(namespacedKey, metadata);
      } catch (error: any) {
        console.warn(`Failed to parse base agent file ${filePath}: ${error.message}`);
      }
    }
  }

  /**
   * Scan neurons directory
   */
  private async scanNeurons(): Promise<void> {
    const neuronDir = path.join(this.workspaceRoot, '.genie/neurons');
    if (!fs.existsSync(neuronDir)) {
      return;
    }

    const files = fs.readdirSync(neuronDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const filePath = path.join(neuronDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');

        // Parse frontmatter
        const frontmatterMatch = content.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n/);
        if (!frontmatterMatch) {
          if (process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1') {
            console.warn(`Neuron file ${filePath} missing frontmatter`);
          }
          continue;
        }

        const frontmatter = parseYAML(frontmatterMatch[1]);

        if (!frontmatter.name) {
          if (process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1') {
            console.warn(`Neuron file ${filePath} missing 'name' in frontmatter`);
          }
          continue;
        }

        // Extract markdown body
        const markdownBody = content.substring(frontmatterMatch[0].length);

        const metadata: AgentMetadata = {
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
      } catch (error: any) {
        console.warn(`Failed to parse neuron file ${filePath}: ${error.message}`);
      }
    }
  }

  /**
   * Scan a directory for agent markdown files (recursive)
   * Pattern: If <folder>/<folder>.md exists at root level, skip scanning <folder>/*.md subfiles
   * This allows agents to have helper workflows in subfolders without registering them
   */
  private async scanDirectory(dir: string, collective: 'code' | 'create', type: 'agent' | 'neuron' = 'agent'): Promise<void> {
    if (!fs.existsSync(dir)) {
      return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Recurse into subdirectories
      if (entry.isDirectory()) {
        // Check if root-level agent exists: <parent>/<folder>.md
        const rootAgentPath = path.join(dir, `${entry.name}.md`);

        // If root agent exists, skip scanning subfolder (contains helper workflows only)
        if (fs.existsSync(rootAgentPath)) {
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
        const content = fs.readFileSync(fullPath, 'utf-8');

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

        const frontmatter = parseYAML(frontmatterMatch[1]);

        if (!frontmatter.name) {
          // Only warn in debug mode
          if (process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1') {
            console.warn(`Agent file ${fullPath} missing 'name' in frontmatter`);
          }
          continue;
        }

        // Extract markdown body (everything after frontmatter)
        const markdownBody = content.substring(frontmatterMatch[0].length);

        const metadata: AgentMetadata = {
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

    // Priority order when no collective specified:
    // 1. Base agents (universal, no collective)
    const baseAgent = this.agents.get(`base/${lowerName}`);
    if (baseAgent) {
      return baseAgent;
    }

    // 2. Search across all collectives (backward compatibility)
    for (const [key, agent] of this.agents.entries()) {
      if (key.endsWith(`/${lowerName}`) && !key.startsWith('base/')) {
        return agent;
      }
    }

    // 3. Fallback: try non-namespaced key (legacy support)
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
   * NOTE: Forge sync methods removed (loadCollectiveContexts, getSupportedExecutors, generateForgeProfiles)
   * Forge now discovers .genie folders natively - no sync needed from Genie.
   */
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
