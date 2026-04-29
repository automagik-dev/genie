/**
 * Provider Adapters — Fixed launch builders for Claude and Codex.
 *
 * Each adapter translates Genie worker-spawn options into the
 * provider-specific CLI invocation that tmux will execute.
 *
 * - Claude adapter: `claude --agent <role> [flags]`
 * - Codex adapter:  `codex --instructions <skill-instructions> [flags]`
 *
 * Genie owns all orchestration semantics (mailbox, protocol, worker
 * state, task coupling). The provider merely launches the process.
 */

import { z } from 'zod';
import { buildDispatchCommand } from '../hooks/inject.js';
import { resolveBuiltinAgentPath } from './builtin-agents.js';
import { sanitizeModelForProvider } from './provider-models.js';
import {
  TRACE_ENV_VAR,
  TRACE_ID_ENV_VAR,
  getAmbient as getTraceContext,
  injectPromptPreamble,
  mintToken as mintTraceToken,
} from './trace-context.js';

// ============================================================================
// Types
// ============================================================================

export type ProviderName = 'claude' | 'codex' | 'app-pty' | 'claude-sdk';

/** Colors available for Claude Code native teammate UI. */
export type ClaudeTeamColor = 'blue' | 'green' | 'yellow' | 'red' | 'cyan' | 'orange' | 'purple' | 'pink';

/** Rotating palette for auto-assigning teammate colors (matches CC internal DG order). */
export const CLAUDE_TEAM_COLORS: ClaudeTeamColor[] = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
];

/** Parameters for Claude Code native teammate integration. */
export interface NativeTeamParams {
  /** Enable native teammate flags (--agent-id, --team-name, etc.). */
  enabled: boolean;
  /** Parent session UUID (team lead's session ID). */
  parentSessionId?: string;
  /** UI color for the teammate pane border. */
  color?: ClaudeTeamColor;
  /** Agent type string (e.g., "general-purpose"). */
  agentType?: string;
  /** Start the teammate in plan mode. */
  planModeRequired?: boolean;
  /** Permission mode (e.g., "acceptEdits", "bypassPermissions"). */
  permissionMode?: string;
  /** Display name for the agent. */
  agentName?: string;
}

/** Common spawn parameters accepted by both providers. */
export interface SpawnParams {
  provider: ProviderName;
  team: string;
  role?: string;
  /**
   * Resolved agent template name (the `<name>` positional arg that
   * resolves via `directory.resolve` to a built-in or user-registered
   * agent definition). Used as Claude's `--agent <template>` flag —
   * Claude looks up the agent definition by this name.
   *
   * Distinct from `role`, which is the IDENTITY override (operator's
   * `--role <custom>` flag). When operator passes `--role custom-id`
   * with a template `engineer`, the spawn must build:
   *   --agent 'engineer'         (template — for definition lookup)
   *   --agent-name 'custom-id'   (identity — for inbox/registry)
   *
   * Group 21 fix: previously `--agent` was sourced from `role`, which
   * cascaded the custom identity into Claude's template lookup,
   * producing phantom rows and 14M `resume.missing_session` events.
   */
  agentTemplate?: string;
  skill?: string;
  /** Agent ID this executor belongs to. Used by executor model (Groups 3+). */
  agentId?: string;
  /** Pre-generated executor ID. Used by executor model (Groups 3+). */
  executorId?: string;
  /** Extra CLI flags forwarded verbatim to the provider binary. */
  extraArgs?: string[];
  /** Claude Code native teammate integration. */
  nativeTeam?: NativeTeamParams;
  /** Session UUID for new sessions (emits --session-id). */
  sessionId?: string;
  /** Session ID to resume (emits --resume). Mutually exclusive with sessionId. */
  resume?: string;
  /** Path to a system prompt file (AGENTS.md). Emits --system-prompt-file or --append-system-prompt-file. */
  systemPromptFile?: string;
  /** Inline system prompt text (for built-ins without an AGENTS.md file). Written to temp file, emits --append-system-prompt-file or --system-prompt-file. */
  systemPrompt?: string;
  /** How to inject the system prompt file: 'system' replaces CC default, 'append' adds to it. */
  promptMode?: 'system' | 'append';
  /** Model override (e.g., 'sonnet', 'opus'). Emits --model flag. */
  model?: string;
  /** Initial prompt to send as the first user message (Claude Code positional [prompt] arg). */
  initialPrompt?: string;
  /** Display name for the CC session (emits --name). Used in /resume and terminal title. */
  name?: string;
  /** Claude Code permissions (allow/deny lists with Bash() patterns). Merged into --settings. */
  permissions?: { allow?: string[]; deny?: string[] };
  /** Tools the agent is NOT allowed to use (emits --disallowedTools). */
  disallowedTools?: string[];
  /** OTel receiver port to inject as OTEL_EXPORTER_OTLP_ENDPOINT. Undefined = skip injection. */
  otelPort?: number;
  /** Whether to log user prompts via OTel (default: true). */
  otelLogPrompts?: boolean;
  /** Wish slug for OTEL_RESOURCE_ATTRIBUTES correlation. */
  otelWishSlug?: string;
  /** Create a new tmux window instead of splitting into an existing one. */
  newWindow?: boolean;
  /** Tmux window target to split into (e.g., "genie:3"). */
  windowTarget?: string;
  /** Skip genie hook dispatch injection (e.g., omni-originated sessions that shouldn't trigger orchestration hooks). */
  skipHooks?: boolean;
}

/** Result of a successful launch-command build. */
interface LaunchCommand {
  /** The full shell command string. */
  command: string;
  /** The provider that was used. */
  provider: ProviderName;
  /** Environment variables to prepend to the command. */
  env?: Record<string, string>;
  /** Metadata recorded in the worker registry. */
  meta: {
    role?: string;
    skill?: string;
  };
}

// ============================================================================
// Validation schemas (Group A contract validation)
// ============================================================================

const spawnParamsSchema = z.object({
  provider: z.enum(['claude', 'codex', 'claude-sdk', 'app-pty']),
  team: z.string().min(1, 'Team name is required'),
  role: z.string().optional(),
  agentTemplate: z.string().optional(),
  skill: z.string().optional(),
  agentId: z.string().optional(),
  executorId: z.string().uuid().optional(),
  extraArgs: z.array(z.string()).optional(),
  nativeTeam: z
    .object({
      enabled: z.boolean(),
      parentSessionId: z.string().optional(),
      color: z.string().optional(),
      agentType: z.string().optional(),
      planModeRequired: z.boolean().optional(),
      permissionMode: z.string().optional(),
      agentName: z.string().optional(),
    })
    .optional(),
  sessionId: z.string().uuid().optional(),
  resume: z.string().optional(),
  systemPromptFile: z.string().optional(),
  systemPrompt: z.string().optional(),
  promptMode: z.enum(['system', 'append']).optional(),
  model: z.string().optional(),
  initialPrompt: z.string().optional(),
  name: z.string().optional(),
  permissions: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  disallowedTools: z.array(z.string()).optional(),
  otelPort: z.number().optional(),
  otelLogPrompts: z.boolean().optional(),
  otelWishSlug: z.string().optional(),
  newWindow: z.boolean().optional(),
  windowTarget: z.string().optional(),
});

/**
 * Validate spawn parameters and return actionable errors.
 * Throws ZodError on invalid input.
 */
export function validateSpawnParams(params: SpawnParams): SpawnParams {
  const parsed = spawnParamsSchema.parse(params);

  return parsed as SpawnParams;
}

// ============================================================================
// Shell Helpers
// ============================================================================

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ============================================================================
// Preflight Checks
// ============================================================================

/**
 * Check if a binary exists on PATH.
 * Returns true if found, false otherwise.
 */
function hasBinary(name: string): boolean {
  try {
    const BunExt = Bun as unknown as { which?: (name: string) => string | null };
    if (typeof BunExt.which === 'function') {
      return Boolean(BunExt.which(name));
    }
    const { execSync } = require('node:child_process');
    execSync(`which ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolveShellBinary(name: string): string | null {
  try {
    const { execFileSync } = require('node:child_process');
    const shell = process.env.SHELL || '/bin/sh';
    const resolved = execFileSync(shell, ['-lc', `command -v ${name}`], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/**
 * Run preflight checks for a provider.
 * Throws with an actionable error if the binary is not found.
 */
function preflightCheck(provider: ProviderName): void {
  if (!hasBinary(provider)) {
    throw new Error(
      `Provider binary "${provider}" not found on PATH. ` + `Install ${provider} or check your environment.`,
    );
  }
}

// ============================================================================
// Claude Adapter
// ============================================================================

/**
 * Build the launch command for a Claude worker.
 *
 * When nativeTeam is enabled, emits Claude Code's internal teammate
 * flags (--agent-id, --team-name, etc.) and env vars so the worker
 * auto-polls its inbox and participates in the native IPC protocol.
 *
 * When nativeTeam is NOT enabled, uses `claude --agent <role>` only.
 */
function appendNativeTeamFlags(
  parts: string[],
  env: Record<string, string>,
  nt: NonNullable<SpawnParams['nativeTeam']>,
  params: SpawnParams,
): void {
  env.CLAUDECODE = '1';
  env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';

  const agentName = nt.agentName ?? params.role ?? 'worker';
  env.GENIE_AGENT_NAME = agentName;
  parts.push('--agent-id', escapeShellArg(`${agentName}@${params.team}`));
  parts.push('--agent-name', escapeShellArg(agentName));
  parts.push('--team-name', escapeShellArg(params.team));

  if (nt.color) parts.push('--agent-color', escapeShellArg(nt.color));
  if (nt.parentSessionId) parts.push('--parent-session-id', escapeShellArg(nt.parentSessionId));
  if (nt.agentType) parts.push('--agent-type', escapeShellArg(nt.agentType));
  if (nt.planModeRequired) parts.push('--plan-mode-required');
  // Always set permission mode for native team workers. `auto` gives tool-by-tool
  // judgment; keeps team-leads unblocked while refusing genuinely destructive ops.
  // `bypassPermissions` remains a valid opt-in via agent frontmatter.
  const effectivePermMode = nt.permissionMode ?? 'auto';
  parts.push('--permission-mode', escapeShellArg(effectivePermMode));
}

/**
 * Resolve system prompt flags for the Claude command.
 *
 * When both an inline systemPrompt and a systemPromptFile exist, merges
 * them into a single temp file. Also merges any --append-system-prompt-file
 * found in extraArgs (consuming it so it isn't duplicated later).
 */
function appendSystemPromptFlags(parts: string[], params: SpawnParams): void {
  if (params.systemPrompt) {
    const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const dir = '/tmp/genie-prompts';
    mkdirSync(dir, { recursive: true });
    const ts = Date.now().toString(36);
    const promptFile = join(dir, `${params.role || 'agent'}-${ts}.md`);

    let content = params.systemPrompt;
    if (params.systemPromptFile) {
      content = `${readFileSync(params.systemPromptFile, 'utf-8')}\n\n${content}`;
    }
    if (params.extraArgs) {
      const fileIdx = params.extraArgs.indexOf('--append-system-prompt-file');
      if (fileIdx !== -1 && params.extraArgs[fileIdx + 1]) {
        content = `${content}\n\n${readFileSync(params.extraArgs[fileIdx + 1], 'utf-8')}`;
        params.extraArgs.splice(fileIdx, 2);
      }
    }

    writeFileSync(promptFile, content);
    const flag = params.promptMode === 'system' ? '--system-prompt-file' : '--append-system-prompt-file';
    parts.push(flag, escapeShellArg(promptFile));
  } else if (params.systemPromptFile) {
    const flag = params.promptMode === 'system' ? '--system-prompt-file' : '--append-system-prompt-file';
    parts.push(flag, escapeShellArg(params.systemPromptFile));
  }
}

/**
 * Inject OTel env vars into the env map when otelPort is configured.
 * Skips injection if OTEL_EXPORTER_OTLP_ENDPOINT is already set (user overrides win).
 */
function appendOtelEnv(env: Record<string, string>, params: SpawnParams): void {
  if (!params.otelPort || process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;

  env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
  env.OTEL_LOGS_EXPORTER = 'otlp';
  env.OTEL_METRICS_EXPORTER = 'otlp';
  env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
  env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${params.otelPort}`;
  env.OTEL_LOG_TOOL_DETAILS = '1';
  if (params.otelLogPrompts !== false) {
    env.OTEL_LOG_USER_PROMPTS = '1';
  }

  const resourceParts: string[] = [];
  if (params.role) resourceParts.push(`agent.name=${params.role}`);
  if (params.team) resourceParts.push(`team.name=${params.team}`);
  if (params.otelWishSlug) resourceParts.push(`wish.slug=${params.otelWishSlug}`);
  if (params.role) resourceParts.push(`agent.role=${params.role}`);
  if (resourceParts.length > 0) {
    env.OTEL_RESOURCE_ATTRIBUTES = resourceParts.join(',');
  }
}

function appendTraceContext(parts: string[], env: Record<string, string>, params: SpawnParams): void {
  const ctx = getTraceContext();
  if (params.initialPrompt) {
    const prompt = ctx ? injectPromptPreamble(params.initialPrompt, ctx) : params.initialPrompt;
    parts.push(escapeShellArg(prompt));
  }
  if (ctx) {
    env[TRACE_ENV_VAR] = mintTraceToken(ctx);
    env[TRACE_ID_ENV_VAR] = ctx.trace_id;
  }
}

function buildClaudeGenieEnv(params: SpawnParams): Record<string, string> {
  const env: Record<string, string> = {};
  // Mark as worker so SessionStart hooks (smart-install, first-run-check,
  // session-context) fast-exit — workers inherit parent's deps and config.
  env.GENIE_WORKER = '1';
  if (params.role) env.GENIE_AGENT_NAME = params.role;
  if (params.team) env.GENIE_TEAM = params.team;
  if (params.executorId) env.GENIE_EXECUTOR_ID = params.executorId;
  if (params.agentId) env.GENIE_AGENT_ID = params.agentId;
  return env;
}

function appendSessionFlags(parts: string[], params: SpawnParams): void {
  if (params.resume) {
    parts.push('--resume', escapeShellArg(params.resume));
  } else if (params.sessionId) {
    parts.push('--session-id', escapeShellArg(params.sessionId));
  }
  // Group 21 fix: --agent flag uses the resolved template (agentTemplate),
  // NOT the identity override (role). Falls back to role only when no
  // template field is set (legacy callers / built-in spawn paths that
  // bypass buildSpawnParams). When role is custom AND no template is
  // resolved, we still emit --agent <role> to preserve prior behavior;
  // the agents.ts:buildSpawnParams call site is now responsible for
  // setting agentTemplate to the verified template name so the right
  // value reaches Claude's template lookup.
  const claudeAgentFlag = params.agentTemplate ?? params.role;
  if (claudeAgentFlag) parts.push('--agent', escapeShellArg(claudeAgentFlag));
  if (params.model) parts.push('--model', escapeShellArg(params.model));
  if (params.name) parts.push('--name', escapeShellArg(params.name));
}

// Inject hook dispatch + permissions via --settings (deep-merges with existing settings).
// Skip hooks for omni-originated sessions to prevent orchestration side-effects
// (e.g., auto-spawning qa/configure agents from seller sessions).
function buildSettingsObject(params: SpawnParams): Record<string, unknown> {
  const settingsObj: Record<string, unknown> = {};
  if (!params.skipHooks) {
    const dispatchCmd = buildDispatchCommand();
    const hookEntry = { type: 'command', command: dispatchCmd, timeout: 15 };
    // Mac-CPU fix D, **completion** — Fix D #1479 narrowed the team-level
    // settings.json matchers via DISPATCHED_EVENT_MATCHERS in `inject.ts`.
    // This inline `--settings` codepath (passed directly to the claude CLI
    // command at spawn time) was a SECOND injection layer that was missed
    // and still hardcoded the wide matchers. dog-fooder-da66 verdict
    // 2026-04-29 surfaced the discrepancy in
    // state/phaseb-413-20260429T143731Z/. Source the matcher map so both
    // layers stay aligned.
    const { DISPATCHED_EVENT_MATCHERS } = require('../hooks/types.js') as typeof import('../hooks/types.js');
    const hooks: Record<string, Array<{ matcher?: string; hooks: (typeof hookEntry)[] }>> = {};
    for (const [event, matcher] of Object.entries(DISPATCHED_EVENT_MATCHERS)) {
      hooks[event] = [{ matcher, hooks: [hookEntry] }];
    }
    settingsObj.hooks = hooks;
  }
  if (params.permissions) {
    const perms: Record<string, string[]> = {};
    if (params.permissions.allow?.length) perms.allow = params.permissions.allow;
    if (params.permissions.deny?.length) perms.deny = params.permissions.deny;
    if (Object.keys(perms).length > 0) settingsObj.permissions = perms;
  }
  return settingsObj;
}

function warnIfAllowRulesAreBypassed(params: SpawnParams): void {
  if (!params.permissions?.allow?.length) return;
  if (params.nativeTeam?.permissionMode !== 'bypassPermissions') return;

  const agentName = params.nativeTeam.agentName ?? params.role ?? params.name ?? 'unknown';
  process.stderr.write(
    `Warning: agent ${agentName} declares permissions.allow but permissionMode is bypassPermissions — allow rules are advisory under bypass (deny still enforced).\n`,
  );
}

function appendDisallowedAndExtraArgs(parts: string[], params: SpawnParams): void {
  if (params.disallowedTools?.length) {
    for (const tool of params.disallowedTools) {
      parts.push('--disallowedTools', escapeShellArg(tool));
    }
  }
  if (params.extraArgs) {
    for (const arg of params.extraArgs) parts.push(escapeShellArg(arg));
  }
}

function assertClaudeBuiltinHasIdentity(params: SpawnParams): void {
  const templateName = params.agentTemplate ?? params.role;
  if (!templateName) return;
  // Resumes attach to an existing Claude conversation whose identity was set
  // at session creation; ResumeContext does not carry prompt fields.
  if (params.resume) return;
  if (!resolveBuiltinAgentPath(templateName)) return;
  if (params.systemPromptFile || params.systemPrompt) return;

  throw new Error(
    `Refusing to launch built-in agent "${templateName}" without AGENTS.md identity. Resolve systemPromptFile or systemPrompt before building the Claude command.`,
  );
}

export function buildClaudeCommand(params: SpawnParams): LaunchCommand {
  assertClaudeBuiltinHasIdentity(params);
  preflightCheck('claude');

  const claudeBinary = resolveShellBinary('claude') ?? 'claude';
  const parts: string[] = [claudeBinary, '--permission-mode', escapeShellArg('auto')];
  const env = buildClaudeGenieEnv(params);

  appendOtelEnv(env, params);

  if (params.nativeTeam?.enabled) {
    appendNativeTeamFlags(parts, env, params.nativeTeam, params);
  }

  appendSessionFlags(parts, params);
  appendSystemPromptFlags(parts, params);

  warnIfAllowRulesAreBypassed(params);

  const settingsObj = buildSettingsObject(params);
  if (Object.keys(settingsObj).length > 0) {
    parts.push('--settings', escapeShellArg(JSON.stringify(settingsObj)));
  }

  appendDisallowedAndExtraArgs(parts, params);
  appendTraceContext(parts, env, params);

  return {
    command: parts.join(' '),
    provider: 'claude',
    env: Object.keys(env).length > 0 ? env : undefined,
    meta: { role: params.role, skill: params.skill },
  };
}

// ============================================================================
// Codex Adapter
// ============================================================================

/**
 * Build the launch command for a Codex worker.
 *
 * Uses `codex` with a positional prompt. Role is advisory metadata
 * only (DEC-4).
 */
/** Build the auto-generated codex prompt when no prompt-bearing fields are supplied. */
function buildCodexAutoPrompt(params: SpawnParams): string {
  const promptParts = [`Genie worker. Team: ${params.team}.`];
  if (params.role) promptParts.push(`Role: ${params.role}.`);
  if (params.skill) promptParts.push(`Execute the ${params.skill} skill instructions.`);
  return promptParts.join(' ');
}

const CODEX_PROMPT_DIR = '/tmp/genie-codex-prompts';
const CODEX_PROMPT_FILE_FLAGS = new Set(['--append-system-prompt-file', '--system-prompt-file']);

function sanitizeCodexPromptFileStem(stem: string): string {
  const safe = stem.replace(/[^a-zA-Z0-9._-]/g, '-');
  return safe || Date.now().toString(36);
}

function splitCodexExtraArgs(extraArgs: string[] | undefined): { forwarded: string[]; promptFiles: string[] } {
  const forwarded: string[] = [];
  const promptFiles: string[] = [];
  const args = extraArgs ?? [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const equalsFlag = [...CODEX_PROMPT_FILE_FLAGS].find((flag) => arg.startsWith(`${flag}=`));

    if (equalsFlag) {
      const path = arg.slice(equalsFlag.length + 1);
      if (!path) throw new Error(`Missing path for ${equalsFlag}`);
      promptFiles.push(path);
      continue;
    }

    if (CODEX_PROMPT_FILE_FLAGS.has(arg)) {
      const path = args[i + 1];
      if (!path) throw new Error(`Missing path after ${arg}`);
      promptFiles.push(path);
      i++;
      continue;
    }

    forwarded.push(arg);
  }

  return { forwarded, promptFiles };
}

function buildCodexMergedPrompt(params: SpawnParams, extraPromptFiles: string[]): string | null {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const sections: string[] = [];

  if (params.systemPromptFile !== undefined) {
    sections.push(readFileSync(params.systemPromptFile, 'utf-8'));
  }
  if (params.systemPrompt !== undefined) {
    sections.push(params.systemPrompt);
  }
  for (const promptFile of extraPromptFiles) {
    sections.push(readFileSync(promptFile, 'utf-8'));
  }
  if (params.initialPrompt !== undefined) {
    sections.push(params.initialPrompt);
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

function writeCodexPromptFile(params: SpawnParams, content: string): string {
  const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  mkdirSync(CODEX_PROMPT_DIR, { recursive: true });
  const stem = sanitizeCodexPromptFileStem(params.executorId ?? Date.now().toString(36));
  const promptFile = join(CODEX_PROMPT_DIR, `${stem}.txt`);
  writeFileSync(promptFile, content, 'utf-8');
  return promptFile;
}

export function buildCodexCommand(params: SpawnParams): LaunchCommand {
  preflightCheck('codex');

  const parts: string[] = ['codex'];
  const env: Record<string, string> = {};
  if (params.executorId) env.GENIE_EXECUTOR_ID = params.executorId;
  if (params.agentId) env.GENIE_AGENT_ID = params.agentId;
  if (params.role) env.GENIE_AGENT_NAME = params.role;
  else if (params.name) env.GENIE_AGENT_NAME = params.name;
  if (params.team) env.GENIE_TEAM = params.team;
  const { forwarded: extraArgs, promptFiles: extraPromptFiles } = splitCodexExtraArgs(params.extraArgs);

  // Full autonomous execution — no permission prompts
  parts.push('--yolo');

  // Inline mode for tmux compatibility (no alternate screen)
  parts.push('--no-alt-screen');

  // Sanitize model for codex — drops Claude-family names that may have flowed
  // in from a directory entry registered against a different provider, falling
  // back to the codex default (gpt-5.5). See provider-models.ts. Closes the
  // 2026-04-28 council incident root cause: dir entry `model: opus` flowed
  // into codex spawn as `--model opus` and killed the agent on startup.
  const codexModel = sanitizeModelForProvider('codex', params.model);
  if (codexModel) parts.push('--model', escapeShellArg(codexModel));

  // Forward extra args before the positional prompt
  for (const arg of extraArgs) {
    parts.push(escapeShellArg(arg));
  }

  // Group 11 (codex-provider-parity): honor params.initialPrompt as the
  // codex worker's first user message. Pre-fix, codex spawn ignored
  // --prompt entirely — operators were stuck either editing --extra-args
  // by hand or sending a follow-up via genie send (which until Group 3
  // landed today, silently failed the native bridge for codex agents).
  //
  // Prompt-bearing fields are merged into a temp file and supplied through
  // command substitution so AGENTS.md, inline system prompts, and first-turn
  // prompts survive shell/tmux quoting. When none are supplied, keep the
  // auto-generated "Genie worker. Team: X. Role: Y." fallback unchanged.
  //
  // Decision: prompt-bearing Codex spawns write the merged prompt file
  // synchronously before returning this command. The file is named by
  // executorId when available, otherwise by timestamp, and is left in /tmp
  // for OS cleanup so tmux's later shell exec can `cat` it without a
  // deletion race.
  const mergedPrompt = buildCodexMergedPrompt(params, extraPromptFiles);
  if (mergedPrompt !== null) {
    const promptFile = writeCodexPromptFile(params, mergedPrompt);
    parts.push(`"$(cat ${escapeShellArg(promptFile)})"`);
  } else {
    parts.push(escapeShellArg(buildCodexAutoPrompt(params)));
  }

  return {
    command: parts.join(' '),
    provider: 'codex',
    env: Object.keys(env).length > 0 ? env : undefined,
    meta: {
      role: params.role,
      skill: params.skill,
    },
  };
}

// ============================================================================
// Dispatch
// ============================================================================

/**
 * Build a launch command for the given provider.
 *
 * This is the main entry point. It validates params, runs preflight
 * checks, and delegates to the appropriate adapter.
 */
export function buildLaunchCommand(params: SpawnParams): LaunchCommand {
  const validated = validateSpawnParams(params);

  switch (validated.provider) {
    case 'claude':
      return buildClaudeCommand(validated);
    case 'codex':
      return buildCodexCommand(validated);
    case 'claude-sdk':
      // SDK provider runs in-process — return metadata-only launch command
      return {
        command: 'claude-sdk-in-process',
        provider: 'claude-sdk',
        meta: { role: validated.role, skill: validated.skill },
      };
    default:
      throw new Error(
        `Unknown provider "${(validated as unknown as { provider: string }).provider}". Valid providers: claude, codex, claude-sdk`,
      );
  }
}
