#!/usr/bin/env node
/**
 * Genie MCP Server - Official SDK Implementation
 *
 * Provides Model Context Protocol access to Genie agent orchestration.
 * Tools integrate with CLI via subprocess execution (shell-out pattern).
 *
 * TECHNICAL DEBT: Handler integration blocked by type signature mismatch:
 * - CLI handlers return Promise<void> (side-effect based via emitView)
 * - MCP tools need Promise<data> (pure functions returning structured data)
 *
 * Future improvement (v0.2.0): Refactor CLI handlers to return data directly,
 * enabling zero-duplication integration. Current implementation ensures 100%
 * behavioral equivalence with CLI while maintaining functional MCP server.
 *
 * Build status: ✅ CLI compiles (0 errors), ✅ MCP compiles (0 errors)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { execFile, ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import { transformDisplayPath } from './lib/display-transform.js';

// Import WebSocket-native tools (MVP Phase 6)
import { wishToolSchema, executeWishTool } from './tools/wish-tool.js';
import { forgeToolSchema, executeForgeTool } from './tools/forge-tool.js';
import { reviewToolSchema, executeReviewTool } from './tools/review-tool.js';
import { promptToolSchema, executePromptTool } from './tools/prompt-tool.js';

// Import neuron architecture tools (Phase 2)
import { continueTaskToolSchema, executeContinueTaskTool } from './tools/continue-task-tool.js';
import { createSubtaskToolSchema, executeCreateSubtaskTool } from './tools/create-subtask-tool.js';

// Import role detection
import { detectGenieRole, isReadOnlyFilesystem } from './lib/role-detector.js';

// Import HTTP server for OAuth2 transport
import { startHttpServer } from './lib/http-server.js';
import { OAuth2Config } from './lib/oauth-provider.js';

const execFileAsync = promisify(execFile);

const PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 8885;
const TRANSPORT = process.env.MCP_TRANSPORT || 'stdio';

// Find actual workspace root by searching upward for .genie/ directory
function findWorkspaceRoot(): string {
  let dir = process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.genie'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fallback to process.cwd() if .genie not found
  return process.cwd();
}

const WORKSPACE_ROOT = findWorkspaceRoot();

interface CliInvocation {
  command: string;
  args: string[];
}

interface CliResult {
  stdout: string;
  stderr: string;
  commandLine: string;
}

// transformDisplayPath imported from ./lib/display-transform (single source of truth)

// Helper: List available agents from all collectives
function listAgents(): Array<{ id: string; displayId: string; name: string; description?: string; folder?: string }> {
  const agents: Array<{ id: string; displayId: string; name: string; description?: string; folder?: string }> = [];

  // ONLY scan specific agents/ directories (not workflows/ or spells/)
  const searchDirs: string[] = [
    path.join(WORKSPACE_ROOT, '.genie/code/agents'),
    path.join(WORKSPACE_ROOT, '.genie/create/agents')
  ];

  const visit = (dirPath: string, relativePath: string | null) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    entries.forEach((entry) => {
      const entryPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Recurse into subdirectories (for sub-agents like git/workflows/, wish/)
        visit(entryPath, relativePath ? path.join(relativePath, entry.name) : entry.name);
        return;
      }

      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md') {
        return;
      }

      const rawId = relativePath ? path.join(relativePath, entry.name) : entry.name;
      const normalizedId = rawId.replace(/\.md$/i, '').split(path.sep).join('/');

      // Extract frontmatter to get name and description
      const content = fs.readFileSync(entryPath, 'utf8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      let name = normalizedId;
      let description: string | undefined;

      if (frontmatterMatch) {
        const frontmatter = frontmatterMatch[1];
        const nameMatch = frontmatter.match(/name:\s*(.+)/);
        const descMatch = frontmatter.match(/description:\s*(.+)/);
        if (nameMatch) name = nameMatch[1].trim();
        if (descMatch) description = descMatch[1].trim();
      }

      // Transform display path (strip template/category folders)
      const { displayId, displayFolder } = transformDisplayPath(normalizedId);

      agents.push({ id: normalizedId, displayId, name, description, folder: displayFolder || undefined });
    });
  };

  // Visit all search directories
  searchDirs.forEach(baseDir => {
    if (fs.existsSync(baseDir)) {
      visit(baseDir, null);
    }
  });

  return agents;
}

// Helper: Safely load Forge executor from dist (package) or src (repo)
function loadForgeExecutor(): { createForgeExecutor: () => any } | null {
  // Prefer compiled dist (works in published package)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../cli/dist/lib/forge-executor');
  } catch (_distErr) {
    // Fallback to TypeScript sources for local dev (within repo)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('../../cli/src/lib/forge-executor');
    } catch (_srcErr) {
      return null;
    }
  }
}

// Helper: List recent sessions (uses Forge API)
async function listSessions(): Promise<Array<{ name: string; agent: string; status: string; created: string; lastUsed: string }>> {
  try {
    // ALWAYS use Forge API for session listing (complete executor replacement)
    const mod = loadForgeExecutor();
    if (!mod || typeof mod.createForgeExecutor !== 'function') {
      throw new Error('Forge executor unavailable (did you build the CLI?)');
    }
    const forgeExecutor = mod.createForgeExecutor();

    const forgeSessions = await forgeExecutor.listSessions();

    const sessions = forgeSessions.map((entry: any) => ({
      name: entry.name || entry.sessionId || 'unknown',
      agent: entry.agent || 'unknown',
      status: entry.status || 'unknown',
      created: entry.created || 'unknown',
      lastUsed: entry.lastUsed || entry.created || 'unknown'
    }));

    // Filter: Show running sessions + recent completed (last 10)
    // Fix Bug #5: Filter out stale sessions (>24 hours old with no recent activity)
    const now = Date.now();
    const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

    const running = sessions.filter((s: any) => {
      const status = s.status === 'running' || s.status === 'starting';
      if (!status) return false;

      // Check if session is stale (created >24h ago, no recent activity)
      if (s.lastUsed !== 'unknown') {
        const lastUsedTime = new Date(s.lastUsed).getTime();
        const age = now - lastUsedTime;
        if (age > STALE_THRESHOLD_MS) {
          // Mark as stale but keep for manual cleanup
          return false;
        }
      }
      return true;
    });

    const completed = sessions
      .filter((s: any) => s.status === 'completed')
      .sort((a: any, b: any) => {
        if (a.lastUsed === 'unknown') return 1;
        if (b.lastUsed === 'unknown') return -1;
        return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
      })
      .slice(0, 10);

    // Combine and sort by lastUsed descending
    return [...running, ...completed].sort((a, b) => {
      if (a.lastUsed === 'unknown') return 1;
      if (b.lastUsed === 'unknown') return -1;
      return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
    });
  } catch (error) {
    // Fallback to local sessions.json if Forge API fails
    console.warn('Failed to fetch Forge sessions, falling back to local store');
    const sessionsFile = path.join(WORKSPACE_ROOT, '.genie/state/agents/sessions.json');

    if (!fs.existsSync(sessionsFile)) {
      return [];
    }

    try {
      const content = fs.readFileSync(sessionsFile, 'utf8');
      const store = JSON.parse(content);

      const sessions = Object.entries(store.sessions || {}).map(([key, entry]: [string, any]) => ({
        name: entry.name || key,
        agent: entry.agent || key,
        status: entry.status || 'unknown',
        created: entry.created || 'unknown',
        lastUsed: entry.lastUsed || entry.created || 'unknown'
      }));

      // Apply same stale filter as Forge path (Fix Bug #5)
      const now = Date.now();
      const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

      const running = sessions.filter(s => {
        const status = s.status === 'running' || s.status === 'starting';
        if (!status) return false;

        // Filter out stale sessions
        if (s.lastUsed !== 'unknown') {
          const lastUsedTime = new Date(s.lastUsed).getTime();
          const age = now - lastUsedTime;
          if (age > STALE_THRESHOLD_MS) {
            return false;
          }
        }
        return true;
      });

      const completed = sessions
        .filter(s => s.status === 'completed')
        .sort((a, b) => {
          if (a.lastUsed === 'unknown') return 1;
          if (b.lastUsed === 'unknown') return -1;
          return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
        })
        .slice(0, 10);

      return [...running, ...completed].sort((a, b) => {
        if (a.lastUsed === 'unknown') return 1;
        if (b.lastUsed === 'unknown') return -1;
        return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime();
      });
    } catch (error) {
      return [];
    }
  }
}

// Helper: Get Genie version from package.json
function getGenieVersion(): string {
  try {
    const packageJsonPath = path.join(__dirname, '..', '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version || '0.0.0';
  } catch (error) {
    return '0.0.0';
  }
}

// Helper: Get version header for MCP outputs
function getVersionHeader(): string {
  return `Genie MCP v${getGenieVersion()}\n\n`;
}

// Sync agent profiles to Forge on startup
async function syncAgentProfilesToForge(): Promise<void> {
  try {
    const mod = loadForgeExecutor();
    if (!mod || typeof mod.createForgeExecutor !== 'function') {
      console.warn('⚠️  Skipping agent profile sync - Forge executor unavailable');
      return;
    }

    const forgeExecutor = mod.createForgeExecutor();
    // Pass WORKSPACE_ROOT to ensure correct scanning from MCP server context
    await forgeExecutor.syncProfiles(undefined, WORKSPACE_ROOT);
  } catch (error: any) {
    console.warn(`⚠️  Agent profile sync failed: ${error.message}`);
  }
}

// Load OAuth2 configuration (if available)
function loadOAuth2Config(): OAuth2Config | null {
  try {
    const configModPath = path.join(WORKSPACE_ROOT, '.genie', 'cli', 'dist', 'lib', 'config-manager.js');
    if (fs.existsSync(configModPath)) {
      const { loadOAuth2Config } = require(configModPath);
      return loadOAuth2Config();
    }
  } catch (error) {
    // Config not available (expected for stdio transport)
  }
  return null;
}

// Load OAuth2 config for HTTP transport
const oauth2Config = loadOAuth2Config();
const serverUrl = `http://localhost:${PORT}`;

// Initialize MCP Server using official SDK
const server = new McpServer({
  name: 'genie',
  version: getGenieVersion(),
}, {
  capabilities: {
    logging: {},
    tools: {}
  }
});

// Tool: list_agents - Discover available agents
server.tool('list_agents', 'List all available Genie agents with their capabilities and descriptions. Use this first to discover which agents can help with your task.', async () => {
  const agents = listAgents();

  if (agents.length === 0) {
    return { content: [{ type: 'text', text: getVersionHeader() + 'No agents found in .genie/code/agents or .genie/create/agents directories.' }] };
  }

  let response = getVersionHeader() + `Found ${agents.length} available agents:\n\n`;

  // Group by folder
  const grouped: Record<string, typeof agents> = {};
  agents.forEach(agent => {
    const key = agent.folder || 'core';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(agent);
  });

  Object.entries(grouped).forEach(([folder, folderAgents]) => {
    response += `**${folder}:**\n`;
    folderAgents.forEach(agent => {
      response += `  • ${agent.displayId}`;
      if (agent.name !== agent.displayId) response += ` (${agent.name})`;
      if (agent.description) response += ` - ${agent.description}`;
      response += '\n';
    });
    response += '\n';
  });

  response += '\nUse the "run" tool with an agent id and prompt to start an agent session.';

  return { content: [{ type: 'text', text: response }] };
});

// Tool: list_sessions - View active and recent sessions
server.tool('list_sessions', 'List active and recent Genie agent sessions. Shows session names, agents, status, and timing. Use this to find sessions to resume or view.', async () => {
  const sessions = await listSessions();

  if (sessions.length === 0) {
    return { content: [{ type: 'text', text: getVersionHeader() + 'No sessions found. Start a new session with the "run" tool.' }] };
  }

  let response = getVersionHeader() + `Found ${sessions.length} session(s):\n\n`;

  sessions.forEach((session, index) => {
    const { displayId } = transformDisplayPath(session.agent);
    response += `${index + 1}. **${session.name}**\n`;
    response += `   Agent: ${displayId}\n`;
    response += `   Status: ${session.status}\n`;
    response += `   Created: ${session.created}\n`;
    response += `   Last Used: ${session.lastUsed}\n\n`;
  });

  response += 'Use "view" to see session transcript or "resume" to continue a session.';

  return { content: [{ type: 'text', text: response }] };
});

// Tool: run - Start a new agent session
server.tool('run', 'Start a new Genie agent session. Choose an agent (use list_agents first) and provide a detailed prompt describing the task. The agent will analyze, plan, or implement based on its specialization.', {
  agent: z.string().describe('Agent ID to run (e.g., "plan", "implementor", "debug"). Get available agents from list_agents tool.'),
  prompt: z.string().describe('Detailed task description for the agent. Be specific about goals, context, and expected outcomes. Agents work best with clear, actionable prompts.'),
  name: z.string().optional().describe('Friendly session name for easy identification (e.g., "bug-102-fix", "auth-feature"). If omitted, auto-generates: "{agent}-{timestamp}".')
}, async (args) => {
  try {
    // Agent alias mapping (Fix Bug #1: plan → wish/blueprint)
    const AGENT_ALIASES: Record<string, string> = {
      'plan': 'wish/blueprint',
      'discover': 'wish/discovery',
      'requirements': 'wish/requirements',
      'align': 'wish/alignment'
    };

    // Resolve alias if exists
    const resolvedAgent = AGENT_ALIASES[args.agent] || args.agent;

    // Early validation: Check if agent exists BEFORE trying to run
    const availableAgents = listAgents();
    const agentExists = availableAgents.some(a => a.id === resolvedAgent || a.displayId === resolvedAgent);

    if (!agentExists) {
      // Fast fail with helpful error message
      const suggestions = availableAgents
        .filter(a => a.id.includes(args.agent) || a.displayId.includes(args.agent))
        .slice(0, 3)
        .map(a => `  • ${a.displayId}`)
        .join('\n');

      const errorMsg = `❌ **Agent not found:** '${args.agent}'\n\n` +
        (suggestions ? `Did you mean:\n${suggestions}\n\n` : '') +
        `💡 Use list_agents tool to see all available agents.`;

      return { content: [{ type: 'text', text: getVersionHeader() + errorMsg }] };
    }

    // Use resolved agent for CLI invocation
    const cliArgs = ['run', resolvedAgent];
    if (args.name?.length) {
      cliArgs.push('--name', args.name);
    }
    if (args.prompt?.length) {
      cliArgs.push(args.prompt);
    }
    const { stdout, stderr } = await runCliCommand(cliArgs, 120000);
    const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');

    const { displayId } = transformDisplayPath(resolvedAgent);
    const aliasNote = AGENT_ALIASES[args.agent] ? ` (alias: ${args.agent} → ${resolvedAgent})` : '';
    return { content: [{ type: 'text', text: getVersionHeader() + `Started agent session:\nAgent: ${displayId}${aliasNote}\n\n${output}\n\nUse list_sessions to see the session ID, then use view/resume/stop as needed.` }] };
  } catch (error: any) {
    return { content: [{ type: 'text', text: getVersionHeader() + formatCliFailure('start agent session', error) }] };
  }
});

// Tool: resume - Continue an existing session
server.tool('resume', 'Resume an existing agent session with a follow-up prompt. Use this to continue conversations, provide additional context, or ask follow-up questions to an agent.', {
  sessionId: z.string().describe('Session name to resume (get from list_sessions tool). Example: "146-session-name-architecture"'),
  prompt: z.string().describe('Follow-up message or question for the agent. Build on the previous conversation context.')
}, async (args) => {
  try {
    const cliArgs = ['resume', args.sessionId];
    if (args.prompt?.length) {
      cliArgs.push(args.prompt);
    }
    const { stdout, stderr } = await runCliCommand(cliArgs, 120000);
    const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');

    return { content: [{ type: 'text', text: getVersionHeader() + `Resumed session ${args.sessionId}:\n\n${output}` }] };
  } catch (error: any) {
    return { content: [{ type: 'text', text: getVersionHeader() + formatCliFailure('resume session', error) }] };
  }
});

// Tool: view - View session transcript
server.tool('view', 'View the transcript of an agent session. Shows the conversation history, agent outputs, and any artifacts generated. Use full=true for complete transcript or false for recent messages only.', {
  sessionId: z.string().describe('Session name to view (get from list_sessions tool). Example: "146-session-name-architecture"'),
  full: z.boolean().optional().default(false).describe('Show full transcript (true) or recent messages only (false). Default: false.')
}, async (args) => {
  try {
    const cliArgs = ['view', args.sessionId];
    if (args.full) {
      cliArgs.push('--full');
    }
    const { stdout, stderr } = await runCliCommand(cliArgs, 30000);
    const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');

    return { content: [{ type: 'text', text: getVersionHeader() + `Session ${args.sessionId} transcript:\n\n${output}` }] };
  } catch (error: any) {
    return { content: [{ type: 'text', text: getVersionHeader() + formatCliFailure('view session', error) }] };
  }
});

// Tool: stop - Terminate a running session
server.tool('stop', 'Stop a running agent session. Use this to terminate long-running agents or cancel sessions that are no longer needed. The session state is preserved for later viewing.', {
  sessionId: z.string().describe('Session name to stop (get from list_sessions tool). Example: "146-session-name-architecture"')
}, async (args) => {
  try {
    const { stdout, stderr } = await runCliCommand(['stop', args.sessionId], 30000);
    const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');

    return { content: [{ type: 'text', text: getVersionHeader() + `Stopped session ${args.sessionId}:\n\n${output}` }] };
  } catch (error: any) {
    return { content: [{ type: 'text', text: getVersionHeader() + formatCliFailure('stop session', error) }] };
  }
});

// Helper: List all spell files in a directory recursively
function listSpellsInDir(dir: string, basePath: string = ''): Array<{ path: string; name: string }> {
  const spells: Array<{ path: string; name: string }> = [];

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;

      if (entry.isDirectory()) {
        // Recurse into subdirectories
        spells.push(...listSpellsInDir(fullPath, relativePath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Extract spell name from frontmatter if possible
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const frontmatterMatch = content.match(/^---\s*\nname:\s*(.+)\s*\n/);
          const spellName = frontmatterMatch ? frontmatterMatch[1].trim() : entry.name.replace('.md', '');
          spells.push({ path: relativePath, name: spellName });
        } catch {
          spells.push({ path: relativePath, name: entry.name.replace('.md', '') });
        }
      }
    }
  } catch (error) {
    // Directory doesn't exist or can't be read
  }

  return spells;
}

// Helper: Read spell content and extract everything after frontmatter
function readSpellContent(spellPath: string): string {
  try {
    const content = fs.readFileSync(spellPath, 'utf-8');

    // Find the end of frontmatter (second ---)
    const frontmatterEnd = content.indexOf('---', 3);
    if (frontmatterEnd === -1) {
      // No frontmatter, return entire content
      return content;
    }

    // Return everything after the closing ---
    return content.substring(frontmatterEnd + 3).trim();
  } catch (error: any) {
    throw new Error(`Failed to read spell: ${error.message}`);
  }
}

// Tool: list_spells - Discover available spells
server.tool('list_spells', 'List all available Genie spells (reusable knowledge patterns). Returns spells from .genie/spells/ (global), .genie/code/spells/ (code-specific), and .genie/create/spells/ (create-specific).', async () => {
  // Note: Scope parameter removed - always returns all spells for simplicity (avoids MCP schema validation issues)
  const scope = 'all';
  const result: any = {};

  // Global spells
  if (scope === 'all' || scope === 'global') {
    const globalSpellsDir = path.join(WORKSPACE_ROOT, '.genie', 'spells');
    result.global = listSpellsInDir(globalSpellsDir);
  }

  // Code spells
  if (scope === 'all' || scope === 'code') {
    const codeSpellsDir = path.join(WORKSPACE_ROOT, '.genie', 'code', 'spells');
    result.code = listSpellsInDir(codeSpellsDir);
  }

  // Create spells
  if (scope === 'all' || scope === 'create') {
    const createSpellsDir = path.join(WORKSPACE_ROOT, '.genie', 'create', 'spells');
    result.create = listSpellsInDir(createSpellsDir);
  }

  // Format output
  let output = getVersionHeader() + '# Genie Spells\n\n';

  if (result.global) {
    output += `## Global Spells (.genie/spells/) - ${result.global.length} spells\n`;
    output += 'Universal patterns applicable to all collectives:\n\n';
    for (const spell of result.global) {
      output += `- **${spell.name}** - \`${spell.path}\`\n`;
    }
    output += '\n';
  }

  if (result.code) {
    output += `## Code Spells (.genie/code/spells/) - ${result.code.length} spells\n`;
    output += 'Code-specific patterns for technical execution:\n\n';
    for (const spell of result.code) {
      output += `- **${spell.name}** - \`${spell.path}\`\n`;
    }
    output += '\n';
  }

  if (result.create) {
    output += `## Create Spells (.genie/create/spells/) - ${result.create.length} spells\n`;
    output += 'Create-specific patterns for creative work:\n\n';
    for (const spell of result.create) {
      output += `- **${spell.name}** - \`${spell.path}\`\n`;
    }
    output += '\n';
  }

  const totalCount = (result.global?.length || 0) + (result.code?.length || 0) + (result.create?.length || 0);
  output += `\n**Total:** ${totalCount} spells\n`;

  return { content: [{ type: 'text', text: output }] };
});

// Helper: Normalize spell path (strip leading .genie/, add directory if missing, add .md if missing)
function normalizeSpellPath(userPath: string): string {
  // Strip leading .genie/ if present (prevents double prefix)
  let normalized = userPath.replace(/^\.genie[\\/]/, '');

  // If path contains no directory component and no scope prefix, search all scope directories
  if (!normalized.includes('/') && !normalized.includes('\\')) {
    // Try to find the spell in global, code, or create directories
    const searchDirs = ['spells', 'code/spells', 'create/spells'];
    for (const dir of searchDirs) {
      const testPath = path.join(WORKSPACE_ROOT, '.genie', dir, normalized.endsWith('.md') ? normalized : `${normalized}.md`);
      if (fs.existsSync(testPath)) {
        normalized = path.join(dir, normalized.endsWith('.md') ? normalized : `${normalized}.md`);
        break;
      }
    }

    // If not found in any directory, default to spells/ (will fail with clear error)
    if (!normalized.includes('/') && !normalized.includes('\\')) {
      normalized = path.join('spells', normalized);
    }
  }

  // Add .md extension if missing
  if (!normalized.endsWith('.md')) {
    normalized += '.md';
  }

  return normalized;
}

// Tool: read_spell - Read specific spell content
server.tool('read_spell', 'Read the full content of a specific spell. Returns the spell content after the frontmatter (---). Use list_spells first to see available spells. Supports multiple path formats: "spells/learn.md", ".genie/spells/learn.md", "code/spells/debug.md", or just "learn" (searches all directories).', {
  spell_path: z.string().describe('Path to spell file. Flexible formats supported: "spells/learn.md" (recommended), ".genie/spells/learn.md" (auto-strips .genie/), "code/spells/debug.md", or just "learn" (auto-searches and adds .md extension)')
}, async (args) => {
  const normalizedPath = normalizeSpellPath(args.spell_path);
  const fullPath = path.join(WORKSPACE_ROOT, '.genie', normalizedPath);

  try {
    const content = readSpellContent(fullPath);
    return { content: [{ type: 'text', text: getVersionHeader() + `# Spell: ${normalizedPath}\n\n${content}` }] };
  } catch (error: any) {
    return { content: [{ type: 'text', text: getVersionHeader() + `Error reading spell: ${error.message}` }] };
  }
});

// Workflows have been merged into spells - no separate workflow tools needed

// Tool: get_workspace_info - Get workspace metadata
server.tool('get_workspace_info', 'Get Genie workspace information including mission, tech stack, roadmap, and environment details. Aggregates data from .genie/product/ directory.', async () => {
  const productDir = path.join(WORKSPACE_ROOT, '.genie', 'product');
  let output = getVersionHeader() + '# Workspace Information\n\n';

  // Read mission
  const missionPath = path.join(productDir, 'mission.md');
  if (fs.existsSync(missionPath)) {
    const mission = fs.readFileSync(missionPath, 'utf-8');
    output += '## Mission\n\n' + mission + '\n\n';
  }

  // Read tech stack
  const techStackPath = path.join(productDir, 'tech-stack.md');
  if (fs.existsSync(techStackPath)) {
    const techStack = fs.readFileSync(techStackPath, 'utf-8');
    output += '## Tech Stack\n\n' + techStack + '\n\n';
  }

  // Read roadmap
  const roadmapPath = path.join(productDir, 'roadmap.md');
  if (fs.existsSync(roadmapPath)) {
    const roadmap = fs.readFileSync(roadmapPath, 'utf-8');
    output += '## Roadmap\n\n' + roadmap + '\n\n';
  }

  // Read environment
  const environmentPath = path.join(productDir, 'environment.md');
  if (fs.existsSync(environmentPath)) {
    const environment = fs.readFileSync(environmentPath, 'utf-8');
    output += '## Environment\n\n' + environment + '\n\n';
  }

  return { content: [{ type: 'text', text: output }] };
});

// ============================================================================
// WEBSOCKET-NATIVE TOOLS (MVP Phase 6) - Real-time streaming + git validation
// ============================================================================

// Tool: create_wish - Create wish with GitHub issue enforcement (WebSocket streaming)
(server.tool as any)('create_wish', 'Create a wish with GitHub issue enforcement (Amendment 1) and real-time progress via WebSocket. Git working tree must be clean and pushed.', {
  feature: z.string().describe('What you want to build'),
  github_issue: z.number().describe('GitHub issue number (required per Amendment 1)')
}, {
  streamingHint: true
}, async (args: any, extra: any) => {
  // Use official MCP SDK logging for real-time streaming
  await executeWishTool(args, {
    streamContent: async (chunk: string) => {
      // Stream content via MCP logging notifications
      await server.sendLoggingMessage({
        level: "info",
        data: chunk
      }, extra.sessionId);
    },
    reportProgress: async (current: number, total: number) => {
      // Report progress via MCP logging notifications
      const message = `Progress: ${current}/${total}`;
      await server.sendLoggingMessage({
        level: "info",
        data: message
      }, extra.sessionId);

      // Also send MCP progress notification if client provided progressToken
      if (extra._meta?.progressToken) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: extra._meta.progressToken,
            progress: current,
            total: total,
            message: message
          }
        });
      }
    }
  });
  return { content: [{ type: 'text', text: 'Wish creation completed. Check the logs above for details.' }] };
});

// Tool: run_forge - Run Forge task with agent and stream execution (WebSocket diff streaming)
(server.tool as any)('run_forge', 'Kick off a Forge task with specified agent and stream live code changes via WebSocket. Git working tree must be clean and pushed.', {
  prompt: z.string().describe('Task prompt (e.g., "Fix bug in login flow")'),
  agent: z.string().describe('Agent to use (e.g., "implementor", "tests", "polish")'),
  project_id: z.string().optional().describe('Project ID (defaults to current Genie project)')
}, {
  streamingHint: true
}, async (args: any, extra: any) => {
  // Use official MCP SDK logging for real-time streaming
  await executeForgeTool(args, {
    streamContent: async (chunk: string) => {
      // Stream content via MCP logging notifications
      await server.sendLoggingMessage({
        level: "info",
        data: chunk
      }, extra.sessionId);
    },
    reportProgress: async (current: number, total: number) => {
      // Report progress via MCP logging notifications
      const message = `Progress: ${current}/${total}`;
      await server.sendLoggingMessage({
        level: "info",
        data: message
      }, extra.sessionId);

      // Also send MCP progress notification if client provided progressToken
      if (extra._meta?.progressToken) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: extra._meta.progressToken,
            progress: current,
            total: total,
            message: message
          }
        });
      }
    }
  });
  return { content: [{ type: 'text', text: 'Forge task completed. Check the logs above for details.' }] };
});

// Tool: run_review - Review wish with agent and stream feedback (WebSocket log streaming)
(server.tool as any)('run_review', 'Review a wish document with an agent and stream live feedback via WebSocket. Git working tree must be clean and pushed.', {
  wish_name: z.string().describe('Wish name (e.g., "genie-mcp-mvp")'),
  agent: z.string().optional().default('review').describe('Agent to use (default: "review")'),
  project_id: z.string().optional().describe('Project ID (defaults to current Genie project)')
}, {
  streamingHint: true
}, async (args: any, extra: any) => {
  // Use official MCP SDK logging for real-time streaming
  await executeReviewTool(args, {
    streamContent: async (chunk: string) => {
      // Stream content via MCP logging notifications
      await server.sendLoggingMessage({
        level: "info",
        data: chunk
      }, extra.sessionId);
    },
    reportProgress: async (current: number, total: number) => {
      // Report progress via MCP logging notifications
      const message = `Progress: ${current}/${total}`;
      await server.sendLoggingMessage({
        level: "info",
        data: message
      }, extra.sessionId);

      // Also send MCP progress notification if client provided progressToken
      if (extra._meta?.progressToken) {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: extra._meta.progressToken,
            progress: current,
            total: total,
            message: message
          }
        });
      }
    }
  });
  return { content: [{ type: 'text', text: 'Review completed. Check the logs above for details.' }] };
});

// Tool: transform_prompt - Synchronous prompt transformer (no worktree, no git validation)
(server.tool as any)('transform_prompt', 'Transform/enhance a prompt using an agent synchronously. Runs in current workspace (no worktree). Modern equivalent of old "background off" mode.', {
  prompt: z.string().describe('Prompt to transform/enhance (e.g., "Help me write a better prompt for implementing dark mode")'),
  agent: z.string().optional().default('prompt').describe('Agent to use for transformation (default: "prompt")')
}, {
  readOnlyHint: true
}, async (args: any, extra: any) => {
  // Use official MCP SDK logging for real-time streaming
  await executePromptTool(args, {
    streamContent: async (chunk: string) => {
      // Stream content via MCP logging notifications
      await server.sendLoggingMessage({
        level: "info",
        data: chunk
      }, extra.sessionId);
    }
  });
  return { content: [{ type: 'text', text: 'Prompt transformation completed. Check the logs above for details.' }] };
});

// Tool: continue_task - Send follow-up work to existing task
(server.tool as any)('continue_task', 'Send follow-up work to an existing task attempt. Used primarily by master orchestrators to receive new work.', {
  attempt_id: z.string().describe('Task attempt ID to send work to'),
  prompt: z.string().describe('Follow-up prompt with new work')
}, async (args: any, extra: any) => {
  await executeContinueTaskTool(args, {
    streamContent: async (chunk: any) => {
      await server.sendLoggingMessage({
        level: "info",
        data: chunk
      }, extra.sessionId);
    }
  });
  return { content: [{ type: 'text', text: 'Follow-up sent successfully. Check the logs above for details.' }] };
});

// Tool: create_subtask - Create child task under master orchestrator
(server.tool as any)('create_subtask', 'Create a child task under a master orchestrator. Allows masters to delegate work as subtasks.', {
  parent_attempt_id: z.string().describe('Parent task attempt ID (the master orchestrator)'),
  title: z.string().describe('Subtask title'),
  prompt: z.string().describe('Subtask prompt/description'),
  executor: z.string().optional().default('CLAUDE_CODE:DEFAULT').describe('Executor variant (e.g., "CLAUDE_CODE:wish", "CLAUDE_CODE:DEFAULT")')
}, async (args: any, extra: any) => {
  await executeCreateSubtaskTool(args, {
    streamContent: async (chunk: any) => {
      await server.sendLoggingMessage({
        level: "info",
        data: chunk
      }, extra.sessionId);
    }
  });
  return { content: [{ type: 'text', text: 'Subtask created successfully. Check the logs above for details.' }] };
});

// ============================================================================
// DEPRECATED PROMPTS - Removed per Amendment: No Backwards Compatibility
// ============================================================================
// These prompts were removed because Genie does not maintain backwards compatibility.
// Users should use the new WebSocket-native tools instead:
//   - create_wish (replaces 'wish' prompt)
//   - run_forge (replaces 'forge' prompt)
//   - run_review (replaces 'review' prompt)
//   - transform_prompt (replaces 'prompt' prompt)

// Detect agent role (neuron architecture)
const roleInfo = detectGenieRole();
const readOnly = isReadOnlyFilesystem(roleInfo.role);

// Start server with configured transport
console.error('Starting Genie MCP Server (MVP)...');
console.error(`Version: ${getGenieVersion()}`);
console.error(`Transport: ${TRANSPORT}`);
console.error(`Role: ${roleInfo.role} (${roleInfo.confidence} confidence, method: ${roleInfo.method})`);
if (readOnly) {
  console.error('🔒 Filesystem: READ-ONLY (master orchestrator)');
}
if (roleInfo.branch) {
  console.error(`Branch: ${roleInfo.branch}`);
}
if (roleInfo.worktree) {
  console.error(`Worktree: ${roleInfo.worktree}`);
}

// Dynamically count tools instead of hardcoding
const coreTools = ['list_agents', 'list_sessions', 'run', 'resume', 'view', 'stop', 'list_spells', 'read_spell', 'get_workspace_info'];
const wsTools = ['create_wish', 'run_forge', 'run_review', 'transform_prompt'];
const neuronTools = ['continue_task', 'create_subtask'];
const totalTools = coreTools.length + wsTools.length + neuronTools.length;

console.error(`Tools: ${totalTools} total`);
console.error(`  - ${coreTools.length} core (agents, sessions, spells, workspace)`);
console.error(`  - ${wsTools.length} WebSocket-native (create_wish, run_forge, run_review, transform_prompt)`);
console.error(`  - ${neuronTools.length} neuron (continue_task, create_subtask)`);
console.error('WebSocket: Real-time streaming enabled');
console.error('');
console.error('🔄 Syncing agent profiles to Forge...');

// Sync agents before starting server (async but non-blocking)
syncAgentProfilesToForge().catch(err => {
  console.warn(`⚠️  Background agent sync failed: ${err.message}`);
});

(async () => {
  if (TRANSPORT === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('✅ Server started successfully (stdio)');
    console.error('Ready for Claude Desktop or MCP Inspector connections');
  } else if (TRANSPORT === 'httpStream' || TRANSPORT === 'http') {
    // HTTP Stream transport with OAuth2 authentication
    if (!oauth2Config) {
      console.error('❌ OAuth2 config not found. Cannot start HTTP server.');
      console.error('Run `genie mcp configure` to set up OAuth2.');
      process.exit(1);
    }

    console.error(`Starting Genie MCP Server v${getGenieVersion()} (HTTP Stream)...`);
    console.error(`Port: ${PORT}`);

    // Use http-server.ts (Express + SDK StreamableHTTPServerTransport + OAuth)
    await startHttpServer({
      server,
      oauth2Config,
      port: PORT,
      onReady: (url) => {
        console.error('✅ Server started successfully (HTTP Stream)');
        console.error(`   HTTP Stream: ${url}/mcp`);
        console.error(`   SSE Stream:  ${url}/mcp (GET)`);
        console.error(`   Health:      ${url}/health`);
        console.error(`   OAuth Token: ${url}/oauth/token`);
        console.error(`   OAuth Meta:  ${url}/.well-known/oauth-protected-resource`);
        console.error('');
        console.error('🔐 Authentication: OAuth2.1 Client Credentials');
        console.error(`   ├─ Client ID:     ${oauth2Config.clientId}`);
        console.error(`   ├─ Token Expiry:  ${oauth2Config.tokenExpiry}s`);
        console.error(`   └─ Issuer:        ${oauth2Config.issuer}`);
        console.error('');
        console.error('📡 Transport: Streamable HTTP (MCP SDK official)');
        console.error('   ├─ POST /mcp → JSON-RPC over HTTP');
        console.error('   └─ GET  /mcp → Server-Sent Events (SSE) for streaming');
      }
    });
  } else {
    console.error(`❌ Unknown transport type: ${TRANSPORT}`);
    console.error('Set MCP_TRANSPORT to "stdio" or "httpStream"');
    process.exit(1);
  }
})().catch((error) => {
  console.error('❌ Server startup failed:', error);
  process.exit(1);
});
function resolveCliInvocation(): CliInvocation {
  const distEntry = path.join(WORKSPACE_ROOT, '.genie/cli/dist/genie-cli.js');
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry] };
  }

  const localScript = path.join(WORKSPACE_ROOT, 'genie');
  if (fs.existsSync(localScript)) {
    return { command: localScript, args: [] };
  }

  return { command: 'npx', args: ['automagik-genie'] };
}

function quoteArg(value: string): string {
  if (!value.length) return '""';
  if (/^[A-Za-z0-9._\-\/]+$/.test(value)) return value;
  return '"' + value.replace(/"/g, '\\"') + '"';
}

function normalizeOutput(data: string | Buffer | undefined): string {
  if (data === undefined || data === null) return '';
  return typeof data === 'string' ? data : data.toString('utf8');
}

async function runCliCommand(subArgs: string[], timeoutMs = 120000): Promise<CliResult> {
  const invocation = resolveCliInvocation();
  const execArgs = [...invocation.args, ...subArgs];
  const commandLine = [invocation.command, ...execArgs.map(quoteArg)].join(' ');
  const options: ExecFileOptions = {
    cwd: WORKSPACE_ROOT,
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs
  };

  try {
    const { stdout, stderr } = await execFileAsync(invocation.command, execArgs, options);
    return {
      stdout: normalizeOutput(stdout),
      stderr: normalizeOutput(stderr),
      commandLine
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string | Buffer; stderr?: string | Buffer };
    const wrapped = new Error(err.message || 'CLI execution failed');
    (wrapped as any).stdout = normalizeOutput(err.stdout);
    (wrapped as any).stderr = normalizeOutput(err.stderr);
    (wrapped as any).commandLine = commandLine;
    throw wrapped;
  }
}

function formatCliFailure(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const stdout = error && typeof error === 'object' ? (error as any).stdout : '';
  const stderr = error && typeof error === 'object' ? (error as any).stderr : '';
  const commandLine = error && typeof error === 'object' ? (error as any).commandLine : '';

  const sections: string[] = [`Failed to ${action}:`, message];
  if (stdout) {
    sections.push(`Stdout:\n${stdout}`);
  }
  if (stderr) {
    sections.push(`Stderr:\n${stderr}`);
  }
  if (commandLine) {
    sections.push(`Command: ${commandLine}`);
  }
  return sections.join('\n\n');
}
