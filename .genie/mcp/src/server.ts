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
import { transformDisplayPath } from './lib/display-transform';

const execFileAsync = promisify(execFile);

const PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT) : 8080;
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

// Helper: List available agents from .genie/agents directory
function listAgents(): Array<{ id: string; displayId: string; name: string; description?: string; folder?: string }> {
  const baseDir = '.genie/agents';
  const agents: Array<{ id: string; displayId: string; name: string; description?: string; folder?: string }> = [];

  if (!fs.existsSync(baseDir)) {
    return agents;
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

  visit(baseDir, null);
  return agents;
}

// Helper: List recent sessions
function listSessions(): Array<{ name: string; agent: string; status: string; created: string; lastUsed: string }> {
  const sessionsFile = '.genie/state/agents/sessions.json';

  if (!fs.existsSync(sessionsFile)) {
    return [];
  }

  try {
    const content = fs.readFileSync(sessionsFile, 'utf8');
    const store = JSON.parse(content);

    // v3: Sessions keyed by name, entry.name should match key
    const sessions = Object.entries(store.sessions || {}).map(([key, entry]: [string, any]) => ({
      name: entry.name || key,  // In v3, key IS the name
      agent: entry.agent || key,
      status: entry.status || 'unknown',
      created: entry.created || 'unknown',
      lastUsed: entry.lastUsed || entry.created || 'unknown'
    }));

    // Filter: Show running sessions + recent completed (last 10)
    const running = sessions.filter(s => s.status === 'running' || s.status === 'starting');
    const completed = sessions
      .filter(s => s.status === 'completed')
      .sort((a, b) => {
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
    return [];
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
      return getVersionHeader() + 'No agents found in .genie/agents directory.';
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
    const sessions = listSessions();

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

// Prompt: plan - Strategic planning and analysis
server.addPrompt({
  name: 'plan',
  description: 'Strategic planning for features, bugs, refactors, and product decisions',
  arguments: [
    {
      name: 'idea',
      description: 'What you want to accomplish (feature, bug fix, refactor, architecture decision)',
      required: true
    },
    {
      name: 'context',
      description: 'Relevant context about your project or specific area',
      required: false
    }
  ],
  load: async (args) => {
    const contextPart = args.context ? `\nContext: ${args.context}` : '';

    return `run plan "[Discovery] Analyze: ${args.idea}${contextPart}

Load context: @.genie/product/mission.md @.genie/product/roadmap.md @.genie/standards/best-practices.md
Review: existing architecture, integration points, dependencies
Document: assumptions (ASM-#), decisions (DEC-#), risks, open questions (Q-#)

[Implementation] Propose high-level approach with phases

[Verification] Define success criteria, validation steps, evidence requirements"

💡 Prompting Tips:
• Use for: features, bugs, refactors, migrations, roadmap items, product decisions
• Reference files with @: auto-loads mission/roadmap/standards context
• Capture: ASM-# (assumptions), DEC-# (decisions), Q-# (questions), RISK-#
• Discovery→Implementation→Verification pattern structures thinking`;
  }
});

// Prompt: wish - Convert ideas into roadmap-aligned wishes
server.addPrompt({
  name: 'wish',
  description: 'Convert planning brief into a wish document with spec contract',
  arguments: [
    {
      name: 'feature',
      description: 'Feature or capability to build',
      required: true
    },
    {
      name: 'planning_context',
      description: 'Planning brief or context from /plan',
      required: false
    }
  ],
  load: async (args) => {
    const contextPart = args.planning_context ? `\nPlanning context: ${args.planning_context}` : '';

    return `run wish "[Discovery] Analyze requirements for: ${args.feature}${contextPart}

1. Current state vs target state
2. Scope boundaries (in/out)
3. Assumptions, decisions, risks
4. Success metrics

[Implementation] Create wish with execution groups, deliverables, evidence paths

[Verification] Ensure @ references, success criteria, evidence checklist complete"

💡 Prompting Tips:
• Use @ to reference docs: @.genie/product/roadmap.md auto-loads
• Structure with <task_breakdown>: Discovery, Implementation, Verification
• Define clear evidence paths: .genie/wishes/<slug>/evidence/`;
  }
});

// Prompt: forge - Break wishes into execution groups
server.addPrompt({
  name: 'forge',
  description: 'Break approved wish into execution groups with validation hooks',
  arguments: [
    {
      name: 'wish_slug',
      description: 'Wish slug (e.g., "auth-feature" from auth-feature-wish.md)',
      required: true
    },
    {
      name: 'focus',
      description: 'Optional focus area (e.g., "evidence checklist only")',
      required: false
    }
  ],
  load: async (args) => {
    const focusPart = args.focus ? `\nFocus: ${args.focus}` : '';

    return `run forge "[Discovery] Review @.genie/wishes/${args.wish_slug}-wish.md
Analyze scope, dependencies, complexity${focusPart}

[Implementation] Break into groups (≤3):
- Group A: Core functionality
- Group B: Testing & validation
Each: surfaces, deliverables, evidence, validation

[Verification] Ensure dependencies sequenced, validation hooks defined, ready for implementation"

💡 Prompting Tips:
• @ auto-loads files: @.genie/wishes/${args.wish_slug}-wish.md (no manual paste)
• Show concrete commands: \`pnpm test\` not "ensure proper validation"
• Specify exact paths: .genie/wishes/<slug>/evidence/screenshots/`;
  }
});

// Prompt: review - Validate completed work
server.addPrompt({
  name: 'review',
  description: 'Validate completed work against standards and requirements',
  arguments: [
    {
      name: 'scope',
      description: 'What to review (e.g., "wish completion", "PR changes", "auth module")',
      required: true
    }
  ],
  load: async (args) => {
    return `run review "[Discovery] Analyze ${args.scope}: code changes, tests, docs, security

[Implementation] Evaluate against:
1. @.genie/standards/*
2. Security vulnerabilities
3. Performance
4. Test coverage

[Verification] Deliver severity-tagged issues (CRITICAL/HIGH/MEDIUM/LOW), file:line refs, improvements"

💡 Prompting Tips:
• Use [SUCCESS CRITERIA] ✅ and [NEVER DO] ❌ for clear boundaries
• Show concrete examples: \`try/catch\` code not "ensure error handling"
• Tag severity: CRITICAL/HIGH/MEDIUM/LOW for prioritization`;
  }
});

// Prompt: genie - Pressure-test decisions with multiple modes
server.addPrompt({
  name: 'genie',
  description: 'Get second opinions, pressure-test plans, or deep-dive analysis using 17+ specialized modes',
  arguments: [
    {
      name: 'situation',
      description: 'What you want to analyze or pressure-test',
      required: true
    },
    {
      name: 'goal',
      description: 'What you want to achieve (e.g., "find risks", "validate approach", "debug issue")',
      required: true
    },
    {
      name: 'mode_hint',
      description: 'Preferred Genie mode (planning, consensus, debug, deep-dive, etc.) - optional',
      required: false
    }
  ],
  load: async (args) => {
    // Infer mode from goal if not provided
    let inferredMode = args.mode_hint || 'planning';
    const goalLower = (args.goal || '').toLowerCase();

    if (goalLower.includes('risk')) inferredMode = 'risk-audit';
    else if (goalLower.includes('debug') || goalLower.includes('investigate')) inferredMode = 'debug';
    else if (goalLower.includes('decision') || goalLower.includes('evaluate')) inferredMode = 'consensus';
    else if (goalLower.includes('deep') || goalLower.includes('analyze')) inferredMode = 'deep-dive';
    else if (goalLower.includes('test') || goalLower.includes('validate')) inferredMode = 'tests';

    return `Genie Modes: planning, consensus, deep-dive, debug, analyze, thinkdeep, design-review, risk-audit, socratic, debate, compliance, retrospective + more

Recommended for "${args.goal}": ${inferredMode}

run genie "Mode: ${inferredMode}. Objective: ${args.goal}

Situation: ${args.situation}

Deliver: [mode-specific outputs]
Finish with: Genie Verdict + confidence (low/med/high)"

💡 Prompting Tips:
• State objective clearly, specify numbered deliverables (3 risks, 3 validations)
• Request verdict format: Genie Verdict + confidence level
• Gives agent clear completion boundaries`;
  }
});

// Prompt: consensus - Decision evaluation and counterpoints
server.addPrompt({
  name: 'consensus',
  description: 'Build consensus and evaluate technical decisions with evidence-based analysis',
  arguments: [
    {
      name: 'decision',
      description: 'The decision or approach to evaluate',
      required: true
    },
    {
      name: 'rationale',
      description: 'Why you\'re considering this decision',
      required: false
    }
  ],
  load: async (args) => {
    const rationalePart = args.rationale ? `\nRationale: ${args.rationale}` : '';

    return `run consensus "[Discovery] Evaluate: ${args.decision}${rationalePart}

[Implementation] Analyze: technical feasibility, long-term implications, alternatives, best practices
Provide: 3 counterpoints + evidence, supporting evidence, recommendation

[Verification] Verdict: Go/No-Go/Modify + confidence"

💡 Prompting Tips:
• Use ✅ Counterpoints evidence-based ❌ Opinions without evidence
• Show concrete concerns: "10M req/day bottleneck?" not "evaluate scalability"
• Require alternatives exploration`;
  }
});

// Prompt: debug - Root cause investigation workflow
server.addPrompt({
  name: 'debug',
  description: 'Systematic root cause investigation with hypotheses and experiments',
  arguments: [
    {
      name: 'problem',
      description: 'The issue you\'re debugging',
      required: true
    },
    {
      name: 'symptoms',
      description: 'Observable symptoms (errors, unexpected behavior)',
      required: false
    }
  ],
  load: async (args) => {
    const symptomsPart = args.symptoms ? `\nSymptoms: ${args.symptoms}` : '';

    return `run debug "[Discovery] Symptoms: ${args.problem}${symptomsPart}
Gather errors, stack traces, recent changes, repro steps

[Implementation] Generate 3-5 hypotheses ranked by likelihood
For top hypothesis: minimal experiment, expected outcomes

[Verification] Root cause, minimal fix, regression test"

💡 Prompting Tips:
• Use <task_breakdown> to structure investigation phases
• Show exact commands: \`grep "ERROR" /var/log/app.log\` not "check logs"
• Rank hypotheses by likelihood`;
  }
});

// Prompt: thinkdeep - Extended reasoning with timebox
server.addPrompt({
  name: 'thinkdeep',
  description: 'Extended reasoning on complex topics with timeboxed exploration',
  arguments: [
    {
      name: 'focus',
      description: 'What to think deeply about',
      required: true
    },
    {
      name: 'timebox_minutes',
      description: 'How long to spend (5=quick, 10=standard, 15=complex)',
      required: false
    }
  ],
  load: async (args) => {
    const timebox = args.timebox_minutes || 10;

    return `run thinkdeep "[Discovery] Outline 3-5 reasoning steps for: ${args.focus}
Timebox: ${timebox}min

[Implementation] Explore each: insights, evidence, implications, questions

[Verification] Top 3 insights + confidence, uncertainties, next actions"

💡 Prompting Tips:
• Show concrete output: "10K req/s bottleneck: PostgreSQL (50K max connections)"
• Timebox: 5min=quick, 10min=standard, 15min=complex
• Prevents meandering, forces prioritization`;
  }
});

// Prompt: analyze - System architecture analysis
server.addPrompt({
  name: 'analyze',
  description: 'Deep analysis of system architecture, dependencies, and design',
  arguments: [
    {
      name: 'component',
      description: 'Component, module, or system to analyze',
      required: true
    },
    {
      name: 'focus_area',
      description: 'Specific focus (dependencies, performance, security) - optional',
      required: false
    }
  ],
  load: async (args) => {
    const focusPart = args.focus_area ? `\nFocus: ${args.focus_area}` : '';

    return `run analyze "[Discovery] Map @${args.component}: structure, dependencies, data flow, interfaces${focusPart}

[Implementation] Find: coupling hotspots, complexity clusters, bottlenecks, security surface

[Verification] Top 3 refactor opportunities + impact, dependency map, simplifications"

💡 Prompting Tips:
• @ auto-loads: @src/auth/ (directory), @src/payment.ts (file)
• Show concrete coupling: "UserService → 4 deps. Extract EmailNotifier interface"
• Define success: ✅ Map complete ✅ Hotspots identified ✅ Impact estimated`;
  }
});

// Prompt: prompt - Meta-prompting helper
server.addPrompt({
  name: 'prompt',
  description: 'Improve prompts using Genie prompting framework (@ references, task breakdown, success criteria)',
  arguments: [
    {
      name: 'task_description',
      description: 'What you want to accomplish',
      required: true
    },
    {
      name: 'current_prompt',
      description: 'Current prompt to improve (optional)',
      required: false
    }
  ],
  load: async (args) => {
    const improvePart = args.current_prompt ? `\n\nImprove:\n${args.current_prompt}` : '';

    return `run prompt "Task: ${args.task_description}${improvePart}

Create structured prompt using:"

## Genie Prompting Framework (@.genie/agents/core/prompt.md)

**1. Task Breakdown:**
<task_breakdown>
1. [Discovery] What to investigate
2. [Implementation] What to change
3. [Verification] What to validate
</task_breakdown>

**2. Auto-Context with @:**
@src/auth/middleware.ts auto-loads files (no manual "read X then Y")

**3. Success/Failure Boundaries:**
[SUCCESS CRITERIA] ✅ Tests pass ✅ No hardcoded paths
[NEVER DO] ❌ Skip coverage ❌ Commit secrets

**4. Concrete Examples:**
Show code: \`try/catch\` not "ensure error handling"

**5. Checklist:**
✅ Discovery→Implementation→Verification
✅ @ references for context
✅ Success criteria defined
✅ Concrete examples

**Example:**
[Discovery] Review @src/auth/middleware.ts, identify gaps
[Implementation] Add JWT refresh endpoint, update middleware
[Verification] Run npm run security-check, test flow
[SUCCESS CRITERIA] ✅ Tokens work ✅ Audit passes
[NEVER DO] ❌ Store in localStorage ❌ Log tokens

💡 This framework = maximum clarity + effectiveness`;
  }
});

// Start server with configured transport
console.error('Starting Genie MCP Server...');
console.error(`Version: ${getGenieVersion()}`);
console.error(`Transport: ${TRANSPORT}`);
console.error('Protocol: MCP (Model Context Protocol)');
console.error('Implementation: FastMCP v3.18.0');
console.error('Tools: 6 (list_agents, list_sessions, run, resume, view, stop)');

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
