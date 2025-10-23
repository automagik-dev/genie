#!/usr/bin/env node
/**
 * Genie MCP Server - MVP Implementation
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

import { FastMCP } from 'fastmcp';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { execFile, ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import { transformDisplayPath } from './lib/display-transform.js';

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

  // Auto-discover all collectives by scanning .genie/ directory
  const searchDirs: string[] = [];
  const genieDir = path.join(WORKSPACE_ROOT, '.genie');

  if (fs.existsSync(genieDir)) {
    const entries = fs.readdirSync(genieDir, { withFileTypes: true });
    entries.forEach(entry => {
      if (entry.isDirectory()) {
        const agentsPath = path.join(genieDir, entry.name, 'agents');
        if (fs.existsSync(agentsPath)) {
          searchDirs.push(agentsPath);
        }
      }
    });
  }

  // Fallback: Include root agents directory if it exists
  const rootAgentsPath = path.join(WORKSPACE_ROOT, '.genie/agents');
  if (fs.existsSync(rootAgentsPath) && !searchDirs.includes(rootAgentsPath)) {
    searchDirs.push(rootAgentsPath);
  }

  const visit = (dirPath: string, relativePath: string | null) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    entries.forEach((entry) => {
      const entryPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
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
    const running = sessions.filter((s: any) => s.status === 'running' || s.status === 'starting');
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

      const running = sessions.filter(s => s.status === 'running' || s.status === 'starting');
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

// Initialize FastMCP server
const server = new FastMCP({
  name: 'genie',
  version: getGenieVersion() as `${number}.${number}.${number}`,
  instructions: `Genie is an agent orchestration system for managing AI agents that help with software development tasks.

**Core Capabilities:**
- Run specialized agents (plan, forge, implementor, review, etc.) with custom prompts
- Resume ongoing agent conversations with follow-up questions
- List available agents and active sessions
- View agent transcripts and stop running agents

**Typical Workflow:**
1. Use 'list_agents' to discover available agents and their capabilities
2. Use 'run' to start an agent with a specific task
3. Use 'list_sessions' to see active/recent sessions
4. Use 'view' to inspect agent output
5. Use 'resume' to continue conversations with follow-up questions
6. Use 'stop' to terminate long-running agents

**Agent Types:**
- **Workflow Agents**: plan, wish, forge, review (structured development process)
- **Tactical Agents**: implementor, tests, polish (feature delivery)
- **Strategic Agents**: genie, analyze, debug (deep analysis)
- **Utility Agents**: commit, refactor (code quality)

Use agents for planning features, implementing code, reviewing changes, debugging issues, and managing development workflows.`
});

// Tool: list_agents - Discover available agents
server.addTool({
  name: 'list_agents',
  description: 'List all available Genie agents with their capabilities and descriptions. Use this first to discover which agents can help with your task.',
  parameters: z.object({}),
  execute: async () => {
    const agents = listAgents();

    if (agents.length === 0) {
      return getVersionHeader() + 'No agents found in .genie/code/agents or .genie/create/agents directories.';
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

    return response;
  }
});

// Tool: list_sessions - View active and recent sessions
server.addTool({
  name: 'list_sessions',
  description: 'List active and recent Genie agent sessions. Shows session names, agents, status, and timing. Use this to find sessions to resume or view.',
  parameters: z.object({}),
  execute: async () => {
    const sessions = await listSessions();

    if (sessions.length === 0) {
      return getVersionHeader() + 'No sessions found. Start a new session with the "run" tool.';
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

    return response;
  }
});

// Tool: run - Start a new agent session
server.addTool({
  name: 'run',
  description: 'Start a new Genie agent session. Choose an agent (use list_agents first) and provide a detailed prompt describing the task. The agent will analyze, plan, or implement based on its specialization.',
  parameters: z.object({
    agent: z.string().describe('Agent ID to run (e.g., "plan", "implementor", "debug"). Get available agents from list_agents tool.'),
    prompt: z.string().describe('Detailed task description for the agent. Be specific about goals, context, and expected outcomes. Agents work best with clear, actionable prompts.'),
    name: z.string().optional().describe('Friendly session name for easy identification (e.g., "bug-102-fix", "auth-feature"). If omitted, auto-generates: "{agent}-{timestamp}".')
  }),
  execute: async (args) => {
    try {
      // Early validation: Check if agent exists BEFORE trying to run
      const availableAgents = listAgents();
      const agentExists = availableAgents.some(a => a.id === args.agent || a.displayId === args.agent);

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

        return getVersionHeader() + errorMsg;
      }

      const cliArgs = ['run', args.agent];
      if (args.name?.length) {
        cliArgs.push('--name', args.name);
      }
      if (args.prompt?.length) {
        cliArgs.push(args.prompt);
      }
      const { stdout, stderr } = await runCliCommand(cliArgs, 120000);
      const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');

      const { displayId } = transformDisplayPath(args.agent);
      return getVersionHeader() + `Started agent session:\nAgent: ${displayId}\n\n${output}\n\nUse list_sessions to see the session ID, then use view/resume/stop as needed.`;
    } catch (error: any) {
      return getVersionHeader() + formatCliFailure('start agent session', error);
    }
  }
});

// Tool: resume - Continue an existing session
server.addTool({
  name: 'resume',
  description: 'Resume an existing agent session with a follow-up prompt. Use this to continue conversations, provide additional context, or ask follow-up questions to an agent.',
  parameters: z.object({
    sessionId: z.string().describe('Session name to resume (get from list_sessions tool). Example: "146-session-name-architecture"'),
    prompt: z.string().describe('Follow-up message or question for the agent. Build on the previous conversation context.')
  }),
  execute: async (args) => {
    try {
      const cliArgs = ['resume', args.sessionId];
      if (args.prompt?.length) {
        cliArgs.push(args.prompt);
      }
      const { stdout, stderr } = await runCliCommand(cliArgs, 120000);
      const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');

      return getVersionHeader() + `Resumed session ${args.sessionId}:\n\n${output}`;
    } catch (error: any) {
      return getVersionHeader() + formatCliFailure('resume session', error);
    }
  }
});

// Tool: view - View session transcript
server.addTool({
  name: 'view',
  description: 'View the transcript of an agent session. Shows the conversation history, agent outputs, and any artifacts generated. Use full=true for complete transcript or false for recent messages only.',
  parameters: z.object({
    sessionId: z.string().describe('Session name to view (get from list_sessions tool). Example: "146-session-name-architecture"'),
    full: z.boolean().optional().default(false).describe('Show full transcript (true) or recent messages only (false). Default: false.')
  }),
  execute: async (args) => {
    try {
      const cliArgs = ['view', args.sessionId];
      if (args.full) {
        cliArgs.push('--full');
      }
      const { stdout, stderr } = await runCliCommand(cliArgs, 30000);
      const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');

      return getVersionHeader() + `Session ${args.sessionId} transcript:\n\n${output}`;
    } catch (error: any) {
      return getVersionHeader() + formatCliFailure('view session', error);
    }
  }
});

// Tool: stop - Terminate a running session
server.addTool({
  name: 'stop',
  description: 'Stop a running agent session. Use this to terminate long-running agents or cancel sessions that are no longer needed. The session state is preserved for later viewing.',
  parameters: z.object({
    sessionId: z.string().describe('Session name to stop (get from list_sessions tool). Example: "146-session-name-architecture"')
  }),
  execute: async (args) => {
    try {
      const { stdout, stderr } = await runCliCommand(['stop', args.sessionId], 30000);
      const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');

      return getVersionHeader() + `Stopped session ${args.sessionId}:\n\n${output}`;
    } catch (error: any) {
      return getVersionHeader() + formatCliFailure('stop session', error);
    }
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
server.addTool({
  name: 'list_spells',
  description: 'List all available Genie spells (reusable knowledge patterns). Returns spells from .genie/spells/ (global), .genie/code/spells/ (code-specific), and .genie/create/spells/ (create-specific).',
  parameters: z.object({
    scope: z.enum(['all', 'global', 'code', 'create']).optional().describe('Filter spells by scope. Default: all')
  }),
  execute: async (args) => {
    const scope = args.scope || 'all';
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

    return output;
  }
});

// Tool: read_spell - Read specific spell content
server.addTool({
  name: 'read_spell',
  description: 'Read the full content of a specific spell. Returns the spell content after the frontmatter (---). Use list_spells first to see available spells.',
  parameters: z.object({
    spell_path: z.string().describe('Relative path to the spell file from .genie/ directory (e.g., "spells/learn.md" or "code/spells/forge-code-blueprints.md")')
  }),
  execute: async (args) => {
    const fullPath = path.join(WORKSPACE_ROOT, '.genie', args.spell_path);

    try {
      const content = readSpellContent(fullPath);
      return getVersionHeader() + `# Spell: ${args.spell_path}\n\n${content}`;
    } catch (error: any) {
      return getVersionHeader() + `Error reading spell: ${error.message}`;
    }
  }
});

// Prompt: wish - Create wish document
server.addPrompt({
  name: 'wish',
  description: 'Create a wish document for planned work',
  arguments: [
    {
      name: 'feature',
      description: 'What you want to build',
      required: true
    }
  ],
  load: async (args) => {
    return `run wish "${args.feature}"`;
  }
});

// Prompt: forge - Break wish into execution groups
server.addPrompt({
  name: 'forge',
  description: 'Break approved wish into execution groups',
  arguments: [
    {
      name: 'wish_path',
      description: 'Path to wish file (e.g., ".genie/wishes/auth-feature/auth-feature-wish.md")',
      required: true
    }
  ],
  load: async (args) => {
    return `run forge "@${args.wish_path}"`;
  }
});

// Prompt: review - Validate completed work
server.addPrompt({
  name: 'review',
  description: 'Review completed work against standards',
  arguments: [
    {
      name: 'scope',
      description: 'What to review (e.g., "auth-feature wish", "PR #123")',
      required: true
    }
  ],
  load: async (args) => {
    return `run review "${args.scope}"`;
  }
});

// Prompt: prompt - Meta-prompting helper
server.addPrompt({
  name: 'prompt',
  description: 'Get help writing effective prompts using Genie patterns',
  arguments: [
    {
      name: 'task',
      description: 'What you want to accomplish',
      required: true
    }
  ],
  load: async (args) => {
    return `run prompt "Help me write a prompt for: ${args.task}

Load: @.genie/spells/prompt.md
Show: concrete example using @ references, <task_breakdown>, [SUCCESS CRITERIA]"`;
  }
});

// Start server with configured transport
console.error('Starting Genie MCP Server...');
console.error(`Version: ${getGenieVersion()}`);
console.error(`Transport: ${TRANSPORT}`);
console.error('Tools: 8 (list_agents, list_sessions, run, resume, view, stop, list_spells, read_spell)');
console.error('Prompts: 4 (wish, forge, review, prompt)');

if (TRANSPORT === 'stdio') {
  server.start({
    transportType: 'stdio'
  });
  console.error('✅ Server started successfully (stdio)');
  console.error('Ready for Claude Desktop or MCP Inspector connections');
} else if (TRANSPORT === 'httpStream' || TRANSPORT === 'http') {
  server.start({
    transportType: 'httpStream',
    httpStream: {
      port: PORT
    }
  });
  console.error(`✅ Server started successfully (HTTP Stream)`);
  console.error(`HTTP Stream: http://localhost:${PORT}/mcp`);
  console.error(`SSE: http://localhost:${PORT}/sse`);
} else {
  console.error(`❌ Unknown transport type: ${TRANSPORT}`);
  console.error('Valid options: stdio (default), httpStream, http');
  process.exit(1);
}
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
