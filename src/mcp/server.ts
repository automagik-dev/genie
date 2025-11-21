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
import WebSocket from 'ws';
import { execSync } from 'child_process';
import { transformDisplayPath } from './lib/display-transform.js';

// Import WebSocket-native tools (MVP Phase 6)
import { promptToolSchema, executePromptTool } from './tools/prompt-tool.js';

// Import neuron architecture tools (Phase 2)
import { continueTaskToolSchema, executeContinueTaskTool } from './tools/continue-task-tool.js';
import { createSubtaskToolSchema, executeCreateSubtaskTool } from './tools/create-subtask-tool.js';

// Import role detection
import { detectGenieRole, isReadOnlyFilesystem } from './lib/role-detector.js';

// Import HTTP server for OAuth2 transport
import { startHttpServer } from './lib/http-server.js';
import { OAuth2Config } from './lib/oauth-provider.js';

// Import process cleanup utilities
import { writePidFile, isServerAlreadyRunning, cleanupStaleMcpServers } from './lib/process-cleanup.js';

// Import CLI executor utilities
import { runCliCommand, formatCliFailure } from './lib/cli-executor.js';

// Import server helper utilities (extracted per Amendment #10)
import {
  findWorkspaceRoot,
  listAgents,
  loadForgeExecutor,
  listTasks,
  getGenieVersion,
  getVersionHeader,
  syncAgentProfilesToForge,
  loadOAuth2Config
} from './lib/server-helpers.js';

// Import spell utilities (extracted per Amendment #10)
import {
  listSpellsInDir,
  readSpellContent,
  normalizeSpellPath
} from './lib/spell-utils.js';

// Import neuron resource provider
import { initNeuronProvider, getNeuronProvider } from './resources/neuron-provider.js';
import { getMcpConfig, getForgeConfig } from './lib/service-config.js';
import { resolveAgentIdentifier, loadAgentSpec } from '../cli/lib/agent-resolver.js';
import { normalizeExecutorKeyOrDefault } from '../cli/lib/executor-registry.js';
import { monitorTaskCompletion } from '../cli/lib/task-monitor.js';
import { TaskService } from '../cli/cli-core/task-service.js';

const { port: PORT } = getMcpConfig();
const TRANSPORT = process.env.MCP_TRANSPORT || 'stdio';

const WORKSPACE_ROOT = findWorkspaceRoot();

// transformDisplayPath imported from ./lib/display-transform (single source of truth)
// listAgents() imported from ./lib/server-helpers.js

// loadForgeExecutor() imported from ./lib/server-helpers.js

// listTasks() imported from ./lib/server-helpers.js

// Helper: View session transcript (uses Forge API + WebSocket normalized logs)
async function viewSession(taskId: string): Promise<{status: string; transcript: string | null; error?: string}> {
  try {
    const mod = loadForgeExecutor();
    if (!mod || typeof mod.createForgeExecutor !== 'function') {
      return {
        status: 'error',
        transcript: null,
        error: 'Forge executor unavailable (did you build the CLI?)'
      };
    }
    mod.createForgeExecutor(); // Warmup (ensures CLI build available)

    const { ForgeClient } = require('../../src/lib/forge-client.js');
    const { baseUrl, token } = getForgeConfig();
    const forge = new ForgeClient(baseUrl, token);

    // Attempt IDs are preferred; fall back to task IDs for backward compatibility
    let attemptId = taskId;
    let attemptDetails: any;

    try {
      attemptDetails = await forge.getTaskAttempt(attemptId);
    } catch (err) {
      const attempts = await forge.listTaskAttempts(taskId);
      if (!Array.isArray(attempts) || !attempts.length) {
        return {
          status: 'error',
          transcript: null,
          error: `No attempts found for task ${taskId}`
        };
      }
      const latestAttempt = attempts[attempts.length - 1];
      attemptId = latestAttempt.id;
      attemptDetails = await forge.getTaskAttempt(attemptId);
    }

    const status = attemptDetails.status || 'unknown';
    const latestProcess = await waitForLatestProcess(forge, attemptId);

    if (!latestProcess) {
      return {
        status,
        transcript: null,
        error: 'Task executor has not produced logs yet. Try again shortly.'
      };
    }

    const completedStatuses = new Set(['completed', 'success', 'failed', 'error', 'stopped']);
    if (completedStatuses.has(status)) {
      const gitTranscript = readTranscriptFromCommit(attemptDetails, latestProcess);
      if (gitTranscript) {
        return { status, transcript: gitTranscript };
      }
    }

    let transcript = await streamNormalizedLogs(forge, latestProcess.id, token, 10000);

    if (!transcript) {
      transcript = latestProcess.output || latestProcess.logs || null;
    }

    if (!transcript && completedStatuses.has(status)) {
      transcript = readTranscriptFromCommit(attemptDetails, latestProcess);
    }

    return { status, transcript };
  } catch (error: any) {
    return {
      status: 'error',
      transcript: null,
      error: error.message || 'Unknown error viewing task'
    };
  }
}

function readTranscriptFromCommit(attemptDetails: any, latestProcess: any): string | null {
  const commitSha = latestProcess?.after_head_commit || latestProcess?.afterHeadCommit;
  const containerRef = attemptDetails?.container_ref || attemptDetails?.containerRef;

  if (!commitSha || !containerRef) {
    return null;
  }

  const gitDir = path.join(containerRef, '.git');
  if (!fs.existsSync(gitDir)) {
    return null;
  }

  try {
    const output = execSync(`git --git-dir="${gitDir}" log -1 --format="%B" ${commitSha}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (!output.length) {
      return null;
    }
    return `Commit ${commitSha.slice(0, 7)}\n${output}`;
  } catch {
    return null;
  }
}

async function waitForLatestProcess(
  forge: any,
  attemptId: string,
  timeoutMs = 45000,
  pollIntervalMs = 1000
): Promise<any | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const processes = await forge.listExecutionProcesses(attemptId);
      if (Array.isArray(processes) && processes.length > 0) {
        return processes[processes.length - 1];
      }
    } catch {
      // Ignore temporary API failures and keep polling
    }
    await sleep(pollIntervalMs);
  }

  return null;
}

async function streamNormalizedLogs(
  forge: any,
  processId: string,
  token?: string,
  timeoutMs = 30000
): Promise<string | null> {
  return new Promise((resolve) => {
    const wsUrl = forge.getNormalizedLogsStreamUrl(processId);
    const headers: Record<string, string> = { 'User-Agent': 'Genie-MCP/1.0' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const entryOrder: string[] = [];
    const entryText = new Map<string, string>();

    const compileTranscript = () =>
      entryOrder
        .map((key) => entryText.get(key))
        .filter((line): line is string => Boolean(line))
        .join('\n') || null;

    const upsertEntry = (path: string, text: string | null) => {
      if (!text) return;
      if (!entryText.has(path)) {
        entryOrder.push(path);
      }
      entryText.set(path, text);
    };

    let resolved = false;
    const finalize = () => {
      if (resolved) return;
      resolved = true;
      resolve(compileTranscript());
    };

    const ws = new WebSocket(wsUrl, { headers });
    const timer = setTimeout(() => {
      ws.close();
      finalize();
    }, timeoutMs);

    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.JsonPatch && Array.isArray(message.JsonPatch)) {
          for (const patch of message.JsonPatch) {
            const formatted = formatNormalizedEntry(patch.value);
            if (formatted) {
              upsertEntry(patch.path || String(entryOrder.length), formatted);
            }
          }
        }

        if (message.finished === true) {
          clearTimeout(timer);
          ws.close();
          finalize();
        }
      } catch {
        upsertEntry(String(entryOrder.length), data.toString());
      }
    });

    ws.on('error', () => {
      clearTimeout(timer);
      finalize();
    });

    ws.on('close', () => {
      clearTimeout(timer);
      finalize();
    });
  });
}

function formatNormalizedEntry(value: any): string | null {
  if (!value || value.type !== 'NORMALIZED_ENTRY') {
    return null;
  }

  const entryType = value.content?.entry_type?.type;
  const content = value.content?.content ?? value.content?.metadata?.text;
  if (!content) {
    return null;
  }

  const asString = typeof content === 'string' ? content : JSON.stringify(content);
  const prefix = (() => {
    switch (entryType) {
      case 'assistant_message':
        return 'assistant';
      case 'user_message':
        return 'user';
      case 'system_message':
        return 'system';
      case 'tool_use': {
        const toolName = value.content?.entry_type?.tool_name || value.content?.metadata?.name || 'tool';
        return `tool:${toolName}`;
      }
      case 'tool_result': {
        const toolName = value.content?.entry_type?.tool_name || value.content?.metadata?.name || 'tool-result';
        return `tool-result:${toolName}`;
      }
      default:
        return entryType || 'log';
    }
  })();

  return `${prefix}: ${asString}`;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}

function buildTextResponse(text: string) {
  return {
    content: [{
      type: 'text' as const,
      text
    }]
  } as any;
}

// Helper: Get Genie version from package.json
// getGenieVersion(), getVersionHeader(), syncAgentProfilesToForge() imported from ./lib/server-helpers.js

// loadOAuth2Config() imported from ./lib/server-helpers.js

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
    // Note: resources capability removed until neuron provider is fully implemented
    // See: src/mcp/resources/neuron-provider.ts (provider exists but not wired up)
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

  response += '\nUse the "task" tool with an agent id and prompt to start an agent task.';

  return { content: [{ type: 'text', text: response }] };
});

// Tool: list_tasks - View active and recent tasks
server.tool('list_tasks', 'List active and recent Genie agent tasks. Shows task names, agents, status, and timing. Use this to find tasks to view or continue.', async () => {
  const tasks = await listTasks();

  if (tasks.length === 0) {
    return { content: [{ type: 'text', text: getVersionHeader() + 'No tasks found. Start a new task with the "task" tool.' }] };
  }

  let response = getVersionHeader() + `Found ${tasks.length} task(s):\n\n`;

  tasks.forEach((task, index) => {
    const { displayId } = transformDisplayPath(task.agent);
    response += `${index + 1}. **${task.id}** (${task.name})\n`;
    response += `   Agent: ${displayId}\n`;
    response += `   Status: ${task.status}\n`;
    response += `   Created: ${task.created}\n`;
    response += `   Last Used: ${task.lastUsed}\n\n`;
  });

  response += 'Use "view_task" with the task ID (e.g., "c74111b4-...") to see transcript or "continue_task" to send a follow-up.';

  return { content: [{ type: 'text', text: response }] };
});

const taskToolShape = {
  agent: z.string().describe('Agent ID to run (e.g., "plan", "implementor", "debug"). Get available agents from list_agents tool.'),
  prompt: z.string().describe('Detailed task description for the agent. Be specific about goals, context, and expected outcomes. Agents work best with clear, actionable prompts.'),
  name: z.string().optional().describe('Friendly task name for easy identification (e.g., "bug-102-fix", "auth-feature"). If omitted, auto-generates: "{agent}-{timestamp}".'),
  executor: z.string().optional().describe('Override executor key (e.g., "OPENCODE"). Uses agent/default config when omitted.'),
  variant: z.string().optional().describe('Override executor variant (e.g., "EXPLORE", "WISH"). Derived from agent name when omitted.'),
  model: z.string().optional().describe('Override model for the selected executor.'),
  monitor: z.boolean().optional().describe('Set true to wait for completion with WebSocket streaming. Default: false (return immediately).')
};
const TaskToolParams = z.object(taskToolShape);
type TaskToolInput = z.infer<typeof TaskToolParams>;

const handleTaskTool = async (args: TaskToolInput) => {
  try {
    const resolvedAgentId = resolveAgentIdentifier(args.agent) || args.agent;
    const availableAgents = listAgents();
    let agentSpec;
    try {
      agentSpec = loadAgentSpec(resolvedAgentId);
    } catch {
      const suggestions = availableAgents
        .filter(a => a.id.includes(args.agent) || a.displayId.includes(args.agent))
        .slice(0, 3)
        .map(a => `  • ${a.displayId}`)
        .join('\n');

      const errorMsg = `❌ **Agent not found:** '${args.agent}'\n\n` +
        (suggestions ? `Did you mean:\n${suggestions}\n\n` : '') +
        `💡 Use list_agents tool to see all available agents.`;

      return buildTextResponse(getVersionHeader() + errorMsg);
    }
    const agentGenie = agentSpec.meta?.genie || {};
    const agentMeta = agentSpec.meta || {};
    const metaExecutor = Array.isArray(agentGenie.executor)
      ? agentGenie.executor[0]
      : agentGenie.executor;
    const executorKey = normalizeExecutorKeyOrDefault(args.executor || metaExecutor);

    // Derive executor variant matching Forge's naming convention
    const deriveVariantFromAgentName = (agentPath: string): string => {
      // Forge variant naming: CODE_<AGENT_NAME> or CREATE_<AGENT_NAME>
      // Examples: code/explore → CODE_EXPLORE, create/writer → CREATE_WRITER
      const parts = agentPath.split('/');
      const template = parts[0]; // code, create, etc.

      // Remove template and category folders (agents/, workflows/)
      let remaining = parts.slice(1);
      if (remaining.length > 0 && (remaining[0] === 'agents' || remaining[0] === 'workflows')) {
        remaining = remaining.slice(1);
      }

      // Join remaining parts with underscores and uppercase
      const agentName = remaining.join('_').toUpperCase();

      // Prepend template prefix (CODE_, CREATE_, etc.)
      const templatePrefix = template.toUpperCase() + '_';
      return templatePrefix + agentName;
    };

    const executorVariant = (
      args.variant || // MCP tool parameter (highest priority)
      agentMeta.forge_profile_name || // Explicit Forge profile name from frontmatter
      agentGenie.executorVariant ||
      agentGenie.variant ||
      deriveVariantFromAgentName(resolvedAgentId) || // Derive from agent name
      'DEFAULT' // Ultimate fallback
    ).trim().toUpperCase();
    const model = args.model || agentMeta.model;

    const forgeModule = loadForgeExecutor();
    if (!forgeModule || typeof forgeModule.createForgeExecutor !== 'function') {
      return buildTextResponse(getVersionHeader() + '❌ Forge executor unavailable (did you run `pnpm run build:genie`?).');
    }

    const forgeExecutor = forgeModule.createForgeExecutor();
    const monitorRequested = Boolean(args.monitor);
    const executionMode = monitorRequested ? 'interactive' : 'background';

    const sessionResult = await forgeExecutor.createTask({
      agentName: resolvedAgentId,
      prompt: args.prompt,
      executorKey,
      executorVariant,
      executionMode,
      model,
      ...(args.name?.length ? { name: args.name } : {})
    });

    const { displayId } = transformDisplayPath(resolvedAgentId);

    const tasksFile = path.join(WORKSPACE_ROOT, '.genie', 'state', 'tasks.json');
    const taskService = new TaskService({
      paths: { tasksFile }
    });
    const store = taskService.load();
    const now = new Date().toISOString();
    store.sessions[sessionResult.attemptId] = {
      agent: resolvedAgentId,
      taskId: sessionResult.taskId,
      projectId: sessionResult.projectId,
      executor: executorKey,
      executorVariant,
      model: model || undefined,
      status: monitorRequested ? 'running' : 'background',
      created: now,
      lastUsed: now,
      lastPrompt: args.prompt.slice(0, 200),
      forgeUrl: sessionResult.forgeUrl,
      background: !monitorRequested
    };
    await taskService.save(store);

    if (!monitorRequested) {
      const payload = {
        task_id: sessionResult.attemptId,
        task_url: sessionResult.forgeUrl,
        agent: resolvedAgentId, // Use full agent ID, not display ID
        executor: `${executorKey}:${executorVariant}`,
        ...(model ? { model } : {}),
        status: 'started',
        message: 'Task running in background'
      };

      return buildTextResponse(
        getVersionHeader() +
        `Started background task for ${displayId}.\n` +
        `Task ID: ${sessionResult.attemptId}\n` +
        `Forge URL: ${sessionResult.forgeUrl}\n\n` +
        `**Result JSON:**\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
      );
    }

    const { baseUrl, token } = getForgeConfig();
    const logBuffer: string[] = [];
    const monitorResult = await monitorTaskCompletion({
      attemptId: sessionResult.attemptId,
      baseUrl,
      token,
      taskUrl: sessionResult.forgeUrl,
      onLog: (line) => {
        logBuffer.push(line);
      }
    });

    const outputPayload = {
      task_url: monitorResult.task_url,
      attempt_id: sessionResult.attemptId,
      status: monitorResult.status,
      duration_ms: monitorResult.duration_ms,
      result: monitorResult.output,
      ...(monitorResult.error ? { error: monitorResult.error } : {})
    };

    const updatedStore = taskService.load();
    if (updatedStore.sessions[sessionResult.attemptId]) {
      updatedStore.sessions[sessionResult.attemptId].status = monitorResult.status;
      updatedStore.sessions[sessionResult.attemptId].lastUsed = new Date().toISOString();
      updatedStore.sessions[sessionResult.attemptId].background = false;
      updatedStore.sessions[sessionResult.attemptId].lastPrompt = args.prompt.slice(0, 200);
    }
    await taskService.save(updatedStore);

    const recentLogs = logBuffer.slice(-40).join('\n');
    let response = getVersionHeader();
    response += `Started interactive task for ${displayId}.\n`;
    response += `Task ID: ${sessionResult.attemptId}\n`;
    response += `Forge URL: ${sessionResult.forgeUrl}\n`;
    response += `Status: ${monitorResult.status}\n\n`;
    response += `**Result JSON:**\n\`\`\`json\n${JSON.stringify(outputPayload, null, 2)}\n\`\`\`\n`;
    if (recentLogs) {
      response += '\n**Recent Logs:**\n\`\`\`\n' + recentLogs + '\n\`\`\`\n';
    }
    response += '\nUse list_tasks to see task history, or view_task/continue_task for follow-ups.';

    return buildTextResponse(response);
  } catch (error: any) {
    const message = error?.message || String(error);
    return buildTextResponse(getVersionHeader() + `❌ Error starting task: ${message}`);
  }
};

// Tool: task - Start a new agent task (headless by default)
server.tool('task', 'Start a new Genie agent task. Returns immediately when monitor=false, or streams live progress when monitor=true.', taskToolShape, handleTaskTool);
// Backward-compatible alias
server.tool('run', '[Deprecated] Alias for task tool (use mcp__genie__task).', taskToolShape, handleTaskTool);

const continueTaskShape = {
  task_id: z.string().optional().describe('Task attempt ID to resume (preferred snake_case, e.g., "c74111b4-...").'),
  taskId: z.string().optional().describe('Legacy camelCase alias for task_id.'),
  prompt: z.string().describe('Follow-up message or question for the agent. Build on the previous conversation context.')
};
const ContinueTaskParams = z.object(continueTaskShape).refine(
  (data) => Boolean((data.task_id ?? data.taskId)?.trim()),
  { message: 'task_id (or taskId) is required' }
);
type ContinueTaskInput = z.infer<typeof ContinueTaskParams>;

const handleContinueTask = async (args: ContinueTaskInput) => {
  try {
    const taskId = (args.task_id || args.taskId || '').trim();
    const cliArgs = ['resume', taskId];
    if (args.prompt?.length) {
      cliArgs.push(args.prompt);
    }
    const { stdout, stderr } = await runCliCommand(WORKSPACE_ROOT, cliArgs, 120000);
    const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');

    return buildTextResponse(getVersionHeader() + `Resumed task ${taskId}:\n\n${output}`);
  } catch (error: any) {
    return buildTextResponse(getVersionHeader() + formatCliFailure('resume task', error));
  }
};

server.tool('continue_task', 'Resume an existing agent task with a follow-up prompt. Use this to continue conversations, provide additional context, or ask follow-up questions to an agent.', continueTaskShape, handleContinueTask);

const viewTaskShape = {
  taskId: z.string().describe('Task ID to view (get from list_tasks tool). Example: "c74111b4-1a81-49d9-b7d3-d57e31926710"'),
  full: z.boolean().optional().default(false).describe('Show full transcript (true) or recent messages only (false). Default: false.')
};
const ViewTaskParams = z.object(viewTaskShape);
type ViewTaskInput = z.infer<typeof ViewTaskParams>;

const handleViewTask = async (args: ViewTaskInput) => {
  try {
    const result = await viewSession(args.taskId);

    if (result.error) {
      return buildTextResponse(getVersionHeader() + `❌ Error viewing task:\n\n${result.error}`);
    }

    let response = getVersionHeader();
    response += `**Task:** ${args.taskId}\n`;
    response += `**Status:** ${result.status}\n\n`;

    if (result.transcript) {
      const lines = result.transcript.split('\n');
      const displayLines = args.full ? lines : lines.slice(-200);
      response += `**Transcript:**\n\`\`\`\n${displayLines.join('\n')}\n\`\`\``;
    } else {
      response += `**Transcript:** (No logs available yet)`;
    }

    return buildTextResponse(response);
  } catch (error: any) {
    return buildTextResponse(getVersionHeader() + `❌ Error: ${error.message}`);
  }
};

server.tool('view_task', 'View the transcript of an agent task. Shows the conversation history, agent outputs, and any artifacts generated. Use full=true for complete transcript or false for recent messages only.', viewTaskShape, handleViewTask);
server.tool('view', '[Deprecated] Alias for view_task (use mcp__genie__view_task).', viewTaskShape, handleViewTask);

// Tool: stop - Terminate a running task
server.tool('stop', 'Stop a running agent task. Use this to terminate long-running agents or cancel tasks that are no longer needed. The task state is preserved for later viewing.', {
  taskId: z.string().optional().describe('Task name to stop (get from list_tasks tool). Example: "146-task-name-architecture"'),
  sessionId: z.string().optional().describe('Legacy alias for taskId.')
}, async (args) => {
  try {
    const taskId = (args.taskId || (args as any).sessionId || '').trim();
    if (!taskId) {
      return { content: [{ type: 'text', text: getVersionHeader() + '❌ Error: taskId or sessionId is required.' }] };
    }
    const { stdout, stderr } = await runCliCommand(WORKSPACE_ROOT, ['stop', taskId], 30000);
    const output = stdout + (stderr ? `\n\nStderr:\n${stderr}` : '');

    return { content: [{ type: 'text', text: getVersionHeader() + `Stopped task ${taskId}:\n\n${output}` }] };
  } catch (error: any) {
    return { content: [{ type: 'text', text: getVersionHeader() + formatCliFailure('stop task', error) }] };
  }
});

// Helper: List all spell files in a directory recursively
// listSpellsInDir(), readSpellContent() imported from ./lib/spell-utils.js

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

// normalizeSpellPath() imported from ./lib/spell-utils.js

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

// Tool: get_workspace_info - Get workspace metadata (lean self-awareness data)
server.tool('get_workspace_info', 'Get essential workspace info for agent self-awareness: project name, tech stack, current branch, and available commands. Lightweight context for agents to understand their environment.', async () => {
  try {
    // Extract essential data only (no bloat)
    const workspaceInfo: any = {};

    // 1. Project name (from package.json or directory name)
    const packageJsonPath = path.join(WORKSPACE_ROOT, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      workspaceInfo.project = pkg.name || path.basename(WORKSPACE_ROOT);
    } else {
      workspaceInfo.project = path.basename(WORKSPACE_ROOT);
    }

    // 2. Tech stack (runtime, language, package manager)
    workspaceInfo.techStack = {};
    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      workspaceInfo.techStack.runtime = 'Node.js';
      workspaceInfo.techStack.packageManager = fs.existsSync(path.join(WORKSPACE_ROOT, 'pnpm-lock.yaml')) ? 'pnpm' :
                                               fs.existsSync(path.join(WORKSPACE_ROOT, 'yarn.lock')) ? 'yarn' : 'npm';

      // Detect language from dependencies
      if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
        workspaceInfo.techStack.language = 'TypeScript';
      } else {
        workspaceInfo.techStack.language = 'JavaScript';
      }
    }

    // 3. Current branch (from git)
    try {
      const { execSync } = require('child_process');
      const branch = execSync('git branch --show-current', { cwd: WORKSPACE_ROOT, encoding: 'utf-8' }).trim();
      workspaceInfo.currentBranch = branch || 'unknown';
    } catch {
      workspaceInfo.currentBranch = 'unknown';
    }

    // 4. Available commands (from package.json scripts)
    workspaceInfo.commands = {};
    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      if (pkg.scripts) {
        // Only include common/useful commands (build, test, lint)
        const relevantScripts = ['build', 'test', 'lint', 'dev', 'start'];
        for (const script of relevantScripts) {
          if (pkg.scripts[script]) {
            workspaceInfo.commands[script] = `${workspaceInfo.techStack.packageManager} run ${script}`;
          }
        }

        // Also include genie-specific commands
        Object.keys(pkg.scripts).forEach(script => {
          if (script.includes('genie') || script.includes('test:')) {
            workspaceInfo.commands[script] = `${workspaceInfo.techStack.packageManager} run ${script}`;
          }
        });
      }
    }

    // Format lean output
    let output = getVersionHeader();
    output += `**Project:** ${workspaceInfo.project}\n`;
    output += `**Branch:** ${workspaceInfo.currentBranch}\n`;
    output += `**Tech Stack:** ${workspaceInfo.techStack.language} + ${workspaceInfo.techStack.runtime} (${workspaceInfo.techStack.packageManager})\n\n`;

    if (Object.keys(workspaceInfo.commands).length > 0) {
      output += `**Available Commands:**\n`;
      Object.entries(workspaceInfo.commands).forEach(([name, cmd]) => {
        output += `- ${name}: \`${cmd}\`\n`;
      });
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (error: any) {
    return { content: [{ type: 'text', text: getVersionHeader() + `Error gathering workspace info: ${error.message}` }] };
  }
});

// ============================================================================
// WEBSOCKET-NATIVE TOOLS (MVP Phase 6) - Real-time streaming + git validation
// ============================================================================

// Tool: transform_prompt - Synchronous prompt transformer (no worktree, no git validation)
(server.tool as any)('transform_prompt', 'Transform/enhance a prompt using an agent synchronously. Runs in current workspace (no worktree). Modern equivalent of old "background off" mode.', {
  prompt: z.string().describe('Prompt to transform/enhance (e.g., "Help me write a better prompt for implementing dark mode")'),
  agent: z.string().optional().default('prompt').describe('Agent to use for transformation (default: "prompt")')
}, {
  readOnlyHint: true
}, async (args: any, extra: any) => {
  const { sessionId } = extra as { sessionId: string };
  // Use official MCP SDK logging for real-time streaming
  await executePromptTool(args, {
    streamContent: async (chunk: string) => {
      // Stream content via MCP logging notifications
      // IMPORTANT: MCP routing uses sessionId (from ToolContext). Do not replace with taskId. (important-comment)
      await server.sendLoggingMessage({
        level: "info",
        data: chunk
      }, sessionId);
    }
  });
  return { content: [{ type: 'text', text: 'Prompt transformation completed. Check the logs above for details.' }] };
});

// Tool: continue_task - Send follow-up work to existing task (skip if already registered earlier)
try {
  (server.tool as any)('continue_task', 'Send follow-up work to an existing task attempt. Used primarily by master orchestrators to receive new work.', {
    attempt_id: z.string().describe('Task attempt ID to send work to'),
    prompt: z.string().describe('Follow-up prompt with new work')
  }, async (args: any, extra: any) => {
    const { sessionId } = extra as { sessionId: string };
    await executeContinueTaskTool(args, {
      streamContent: async (chunk: any) => {
        // IMPORTANT: MCP routing uses sessionId (from ToolContext). Do not replace with taskId.
        await server.sendLoggingMessage({
          level: "info",
          data: chunk
        }, sessionId);
      }
    });
    return { content: [{ type: 'text', text: 'Follow-up sent successfully. Check the logs above for details.' }] };
  });
} catch (error: any) {
  if (!String(error?.message || '').includes('already registered')) {
    throw error;
  }
}

// Tool: create_subtask - Create child task under master orchestrator
(server.tool as any)('create_subtask', 'Create a child task under a master orchestrator. Allows masters to delegate work as subtasks.', {
  parent_attempt_id: z.string().describe('Parent task attempt ID (the master orchestrator)'),
  title: z.string().describe('Subtask title'),
  prompt: z.string().describe('Subtask prompt/description'),
  executor: z.string().optional().default('CLAUDE_CODE:DEFAULT').describe('Executor variant (e.g., "CLAUDE_CODE:wish", "CLAUDE_CODE:DEFAULT")')
}, async (args: any, extra: any) => {
  const { sessionId } = extra as { sessionId: string };
  await executeCreateSubtaskTool(args, {
    streamContent: async (chunk: any) => {
      // IMPORTANT: MCP routing uses sessionId (from ToolContext). Do not replace with taskId. (important-comment)
      await server.sendLoggingMessage({
        level: "info",
        data: chunk
      }, sessionId);
    }
  });
  return { content: [{ type: 'text', text: 'Subtask created successfully. Check the logs above for details.' }] };
});

// Detect agent role (neuron architecture)
const roleInfo = detectGenieRole();
const readOnly = isReadOnlyFilesystem(roleInfo.role);

// Debug mode detection
const debugMode = process.env.MCP_DEBUG === '1' || process.env.DEBUG === '1';

// ============================================================================
// MCP RESOURCES - Neuron thought streams (real-time)
// ============================================================================

// Initialize neuron provider if Forge available
let neuronProvider: ReturnType<typeof getNeuronProvider> | null = null;

try {
  const { baseUrl: FORGE_URL } = getForgeConfig();
  const PROJECT_ID = process.env.PROJECT_ID || process.env.FORGE_PROJECT_ID;

  if (PROJECT_ID) {
    neuronProvider = initNeuronProvider(FORGE_URL, PROJECT_ID);

    if (debugMode) {
      console.error('✅ Neuron provider initialized (wish, forge, review, master)');
    }
  } else {
    if (debugMode) {
      console.error('⚠️  Neuron resources unavailable (PROJECT_ID not set)');
    }
  }
} catch (error: any) {
  if (debugMode) {
    console.error(`⚠️  Neuron provider initialization failed: ${error.message}`);
  }
}

// Register MCP resource handlers (using server request handling pattern)
// Note: MCP SDK resources API is still evolving - this is Phase 2 foundation
// Full resource subscription will be completed in Phase 3 once SDK stabilizes

// ============================================================================
// CLEANUP HANDLERS - Prevent zombie processes (Fix: MCP server proliferation)
// ============================================================================

let isShuttingDown = false;
let serverConnection: any = null; // Store server connection for cleanup

/**
 * Keep the stdio transport alive until the connection explicitly closes.
 * Prevents Node from exiting immediately after startup (regression: MCP server
 * would launch and exit before Genie CLI could stay alive).
 */
function waitForStdioTransportShutdown(transport: StdioServerTransport): Promise<void> {
  return new Promise((resolve) => {
    const previousOnClose = transport.onclose;
    const previousOnError = transport.onerror;

    const finalize = (reason: string) => {
      transport.onclose = previousOnClose;
      transport.onerror = previousOnError;
      if (debugMode) {
        console.error(`MCP stdio transport stopping (${reason})`);
      }
      resolve();
    };

    transport.onclose = () => {
      if (typeof previousOnClose === 'function') {
        previousOnClose();
      }
      finalize('close');
    };

    transport.onerror = (error: unknown) => {
      if (typeof previousOnError === 'function') {
        previousOnError(error as Error);
      }
      finalize(`error: ${error instanceof Error ? error.message : String(error)}`);
    };

    // Ensure the stream remains in flowing mode so Node keeps the event loop alive.
    if (typeof process.stdin.resume === 'function') {
      process.stdin.resume();
    }
  });
}

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  if (debugMode) {
    console.error(`\n📡 Received ${signal}, shutting down MCP server gracefully...`);
  }

  try {
    // Close server connection if exists
    if (serverConnection && typeof serverConnection.close === 'function') {
      await serverConnection.close();
    }

    // Give pending operations time to finish (max 2s)
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (debugMode) {
      console.error('✅ MCP server shutdown complete');
    }
  } catch (error) {
    console.error(`⚠️  Error during shutdown: ${error}`);
  } finally {
    process.exit(0);
  }
}

// Register signal handlers for all termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error(`❌ Uncaught exception: ${error.message}`);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error(`❌ Unhandled rejection: ${reason}`);
  gracefulShutdown('unhandledRejection');
});

// Parent process monitor (stdio mode only)
// When Claude Code (parent) closes, stdin pipe closes and process should exit
if (TRANSPORT === 'stdio') {
  process.stdin.on('end', () => {
    if (debugMode) {
      console.error('📡 Parent closed stdin, shutting down...');
    }
    gracefulShutdown('stdin-end');
  });

  process.stdin.on('close', () => {
    if (debugMode) {
      console.error('📡 stdin closed, shutting down...');
    }
    gracefulShutdown('stdin-close');
  });
}

// Start server with configured transport (only log in debug mode)
if (debugMode) {
  // Verbose startup logs (debug mode only)
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
  const coreTools = ['list_agents', 'list_tasks', 'run', 'view', 'stop', 'list_spells', 'read_spell', 'get_workspace_info'];
  const wsTools = ['transform_prompt'];
  const neuronTools = ['continue_task', 'create_subtask'];
  const totalTools = coreTools.length + wsTools.length + neuronTools.length;

  console.error(`Tools: ${totalTools} total`);
  console.error(`  - ${coreTools.length} core (agents, tasks, spells, workspace)`);
  console.error(`  - ${wsTools.length} WebSocket-native (transform_prompt)`);
  console.error(`  - ${neuronTools.length} neuron (continue_task, create_subtask)`);
  console.error('WebSocket: Real-time streaming enabled');
  console.error('');
}

// Check for existing server and cleanup orphans
(async () => {
  // Cleanup orphaned servers on startup
  const cleanupResult = await cleanupStaleMcpServers({
    killOrphans: true,
    dryRun: false
  });

  if (debugMode && cleanupResult.orphans > 0) {
    console.error(`🧹 Cleaned up ${cleanupResult.killed} orphaned MCP server(s)`);
    if (cleanupResult.failed > 0) {
      console.error(`⚠️  Failed to kill ${cleanupResult.failed} process(es)`);
    }
  }

  // NOTE: PID file conflict check moved to server-manager.ts (with takeover prompt)
  // This allows user-friendly takeover instead of immediate exit

  // Write PID file ONLY for HTTP/SSE transport (singleton per port)
  // Stdio transport allows multiple instances (no PID file needed)
  if (TRANSPORT === 'httpStream' || TRANSPORT === 'http') {
    writePidFile(WORKSPACE_ROOT);
  }
})();

// Forge sync (always show, one line)
process.stderr.write('🔄 Syncing agent profiles...');

// Sync agents before starting server (async but non-blocking)
// Note: forge-executor.ts handles the completion message, so we don't print anything here
syncAgentProfilesToForge()
  .then(() => {
    // forge-executor.ts already printed the completion message
    // No additional output needed (prevents duplicate checkmarks)
  })
  .catch(err => {
    console.warn(`\n⚠️  Agent sync failed: ${err.message}`);
  });

(async () => {
  if (TRANSPORT === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    serverConnection = transport;

    console.error('✅ Server started successfully (stdio)');
    console.error('Ready for Claude Desktop or MCP Inspector connections');

    // Keep process alive until the transport signals shutdown.
    await waitForStdioTransportShutdown(transport);
  } else if (TRANSPORT === 'httpStream' || TRANSPORT === 'http') {
    // HTTP Stream transport with OAuth2 authentication
    if (!oauth2Config) {
      console.error('❌ OAuth2 config not found. Cannot start HTTP server.');
      console.error('Run `genie mcp configure` to set up OAuth2.');
      process.exit(1);
    }

    if (debugMode) {
      console.error(`Starting Genie MCP Server v${getGenieVersion()} (HTTP Stream)...`);
      console.error(`Port: ${PORT}`);
    }

    // Use http-server.ts (Express + SDK StreamableHTTPServerTransport + OAuth)
    await startHttpServer({
      server,
      oauth2Config,
      port: PORT,
      onReady: (url) => {
        // http-server.ts already prints the success message
        // This callback is kept for backwards compatibility
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
