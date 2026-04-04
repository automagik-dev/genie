/**
 * SDK Directory Types — Claude Agent SDK configuration persisted in the agent directory.
 *
 * These types mirror a curated subset of the Claude Agent SDK `Options` type,
 * excluding runtime-only fields (resume, sessionId, cwd, env, stderr, etc.).
 * Persisted as JSONB in the PG agents.metadata column under the `sdk` key.
 */

/** Claude Agent SDK configuration persisted in the agent directory. */
export interface SdkDirectoryConfig {
  /** Permission mode for the session. */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
  /** Allow bypassing all permission checks. Required when permissionMode is 'bypassPermissions'. */
  allowDangerouslySkipPermissions?: boolean;
  /** Base set of available built-in tools, or a preset. */
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  /** Tools auto-allowed without prompting. */
  allowedTools?: string[];
  /** Tools removed from model context entirely. */
  disallowedTools?: string[];
  /** Max conversation turns before stopping. */
  maxTurns?: number;
  /** Max budget in USD. */
  maxBudgetUsd?: number;
  /** Effort level: 'low' | 'medium' | 'high' | 'max'. */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Thinking/reasoning configuration. */
  thinking?: { type: 'enabled'; budgetTokens: number } | { type: 'adaptive' } | { type: 'disabled' };
  /** Named main agent to use. */
  agent?: string;
  /** Subagent definitions keyed by name. */
  agents?: Record<string, SdkAgentDefinition>;
  /** MCP server configurations keyed by name. */
  mcpServers?: Record<string, SdkMcpServerConfig>;
  /** Plugin configurations. */
  plugins?: SdkPluginConfig[];
  /** Persist conversation across restarts. */
  persistSession?: boolean;
  /** Enable file-based checkpointing. */
  enableFileCheckpointing?: boolean;
  /** Output format for structured responses. */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  /** Include partial messages in stream. */
  includePartialMessages?: boolean;
  /** Include hook events in stream. */
  includeHookEvents?: boolean;
  /** Enable prompt suggestions after each turn. */
  promptSuggestions?: boolean;
  /** Enable AI-generated progress summaries for subagents. */
  agentProgressSummaries?: boolean;
  /** Sandbox settings for command execution isolation. */
  sandbox?: SdkSandboxSettings;
  /** Beta features to enable. */
  betas?: string[];
  /** Which filesystem settings to load: 'user', 'project', 'local'. */
  settingSources?: Array<'user' | 'project' | 'local'>;
  /** Additional settings (inline object or path to JSON file). */
  settings?: string | Record<string, unknown>;
  /** Hook callbacks keyed by event name. */
  hooks?: Record<string, SdkHookMatcher[]>;
  /** System prompt: plain string or preset with optional append. */
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  /** Custom tool definitions. */
  customTools?: SdkCustomToolDefinition[];
  /** Model override. */
  model?: string;
  /** Fallback model. */
  fallbackModel?: string;
  /** API-side task budget in tokens. */
  taskBudget?: { total: number };
  /** MCP tool name for permission prompts. */
  permissionPromptToolName?: string;
}

export interface SdkAgentDefinition {
  description: string;
  prompt?: string;
  tools?: string[];
  model?: string;
}

export interface SdkMcpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface SdkPluginConfig {
  type: 'local';
  path: string;
}

export interface SdkSandboxSettings {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  network?: {
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[];
  };
}

export interface SdkHookMatcher {
  matcher: string;
  hooks: Array<{ type: 'command'; command: string }>;
}

export interface SdkCustomToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
