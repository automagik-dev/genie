/**
 * SDK Directory Types — Full TypeScript types for SDK Options configuration
 * persisted as part of a DirectoryEntry.
 *
 * These types mirror the Claude Agent SDK Options interface but are
 * self-contained so the directory module does not depend on the SDK at runtime.
 * Only serializable (JSON-safe) fields are included; callbacks, AbortControllers,
 * and other non-serializable values are intentionally excluded.
 */

// ============================================================================
// Permission & Effort
// ============================================================================

/** Permission mode controlling how tool executions are handled. */
export type SdkPermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'
  | 'remoteApproval';

/** Reasoning effort level. Named level or an integer 0-100. */
export type SdkEffortLevel = ('low' | 'medium' | 'high' | 'max') | number;

// ============================================================================
// Thinking
// ============================================================================

/** Controls Claude's thinking/reasoning behavior. */
export type SdkThinkingConfig =
  | { /** Claude decides when and how much to think (Opus 4.6+). */ type: 'adaptive' }
  | {
      /** Fixed thinking token budget (older models). */ type: 'enabled' /** Maximum tokens for the thinking step. */;
      budgetTokens?: number;
    }
  | { /** No extended thinking. */ type: 'disabled' };

// ============================================================================
// MCP Servers
// ============================================================================

/** MCP server configuration — stdio, SSE, or HTTP transport. */
export type SdkMcpServerConfig = SdkMcpStdioServerConfig | SdkMcpSSEServerConfig | SdkMcpHttpServerConfig;

/** MCP server using stdio transport (command + args). */
interface SdkMcpStdioServerConfig {
  /** Transport type. Defaults to 'stdio' when omitted. */
  type?: 'stdio';
  /** Command to launch the MCP server process. */
  command: string;
  /** Arguments passed to the command. */
  args?: string[];
  /** Environment variables for the server process. */
  env?: Record<string, string>;
}

/** MCP server using Server-Sent Events transport. */
interface SdkMcpSSEServerConfig {
  /** Transport type — must be 'sse'. */
  type: 'sse';
  /** URL of the SSE endpoint. */
  url: string;
  /** Optional HTTP headers for the SSE connection. */
  headers?: Record<string, string>;
}

/** MCP server using HTTP Streamable transport. */
interface SdkMcpHttpServerConfig {
  /** Transport type — must be 'http'. */
  type: 'http';
  /** URL of the HTTP endpoint. */
  url: string;
  /** Optional HTTP headers for the HTTP connection. */
  headers?: Record<string, string>;
}

// ============================================================================
// Subagents
// ============================================================================

/** Configuration for a custom subagent that can be invoked via the Agent tool. */
export interface SdkSubagentConfig {
  /** Natural language description of when to use this agent. */
  description: string;
  /** The agent's system prompt. */
  prompt: string;
  /** Array of allowed tool names. If omitted, inherits all tools from parent. */
  tools?: string[];
  /** Array of tool names to explicitly disallow for this agent. */
  disallowedTools?: string[];
  /** Model alias (e.g. 'sonnet', 'opus') or full model ID. */
  model?: string;
  /** MCP server specs — either a server name or an inline config record. */
  mcpServers?: (string | Record<string, SdkMcpStdioServerConfig>)[];
  /** Array of skill names to preload into the agent context. */
  skills?: string[];
  /** Maximum number of agentic turns (API round-trips) before stopping. */
  maxTurns?: number;
  /** Run this agent as a background task (non-blocking, fire-and-forget). */
  background?: boolean;
  /** Scope for auto-loading agent memory files: 'user', 'project', or 'local'. */
  memory?: 'user' | 'project' | 'local';
  /** Reasoning effort level for this agent. */
  effort?: SdkEffortLevel;
  /** Permission mode controlling how tool executions are handled. */
  permissionMode?: SdkPermissionMode;
}

// ============================================================================
// Custom Tools
// ============================================================================

/** Configuration for a custom MCP tool registered at the directory level. */
export interface SdkCustomToolConfig {
  /** Unique tool name. */
  name: string;
  /** Human-readable description of what the tool does. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** Handler identifier or inline handler path (runtime-resolved). */
  handler?: string;
}

// ============================================================================
// Output Format
// ============================================================================

/** Output format configuration for structured responses. */
export type SdkOutputFormat = {
  /** Format type — currently only 'json_schema'. */
  type: 'json_schema';
  /** JSON Schema the response must conform to. */
  schema: Record<string, unknown>;
};

// ============================================================================
// Plugins
// ============================================================================

/** Plugin configuration — currently only local plugins. */
export interface SdkPluginConfig {
  /** Plugin type. Currently only 'local' is supported. */
  type: 'local';
  /** Absolute or relative path to the plugin directory. */
  path: string;
}

// ============================================================================
// Sandbox
// ============================================================================

/** Sandbox settings for command execution isolation. */
export interface SdkSandboxConfig {
  /** Whether sandboxing is enabled. */
  enabled?: boolean;
  /** Auto-allow all Bash commands when sandboxed. */
  autoAllowBashIfSandboxed?: boolean;
  /** Fail if sandbox dependencies are unavailable. */
  failIfUnavailable?: boolean;
  /** Network sandbox options. */
  network?: {
    /** Allow binding to local ports inside the sandbox. */
    allowLocalBinding?: boolean;
    /** Unix sockets to allow access to. */
    allowUnixSockets?: string[];
  };
}

// ============================================================================
// Hooks
// ============================================================================

/** SDK hook event names. */
export type SdkHookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'StopFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'Setup'
  | 'TeammateIdle'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Elicitation'
  | 'ElicitationResult'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'InstructionsLoaded'
  | 'CwdChanged'
  | 'FileChanged';

/** Serializable hook matcher — stores the matcher config but not the callback. */
export interface SdkHookMatcherConfig {
  /** Optional tool name matcher (glob or exact). */
  toolName?: string;
  /** Optional agent name matcher. */
  agentName?: string;
}

// ============================================================================
// Betas
// ============================================================================

/** Beta feature flags. */
export type SdkBeta = 'context-1m-2025-08-07';

// ============================================================================
// Settings Source
// ============================================================================

/** Control which filesystem settings to load. */
export type SdkSettingSource = 'user' | 'project' | 'local';

// ============================================================================
// System Prompt
// ============================================================================

/** System prompt configuration — either a raw string or a preset with optional append. */
export type SdkSystemPrompt =
  | string
  | {
      /** Preset type. */
      type: 'preset';
      /** Preset name. */
      preset: 'claude_code';
      /** Additional instructions appended to the default prompt. */
      append?: string;
    };

// ============================================================================
// Main Config
// ============================================================================

/**
 * Full SDK configuration that can be stored in a DirectoryEntry.
 *
 * Maps to the serializable subset of the Claude Agent SDK `Options` type.
 * Non-serializable fields (callbacks, AbortController, spawn functions)
 * are intentionally excluded as they cannot be persisted to PG JSONB.
 */
export interface SdkDirectoryConfig {
  /** Permission mode for the session. */
  permissionMode?: SdkPermissionMode;

  /** Base set of available built-in tools — array of names or a preset. */
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };

  /** Tool names that are auto-allowed without prompting. */
  allowedTools?: string[];

  /** Tool names that are disallowed (removed from context). */
  disallowedTools?: string[];

  /** Maximum number of conversation turns before the query stops. */
  maxTurns?: number;

  /** Maximum budget in USD for the query. */
  maxBudgetUsd?: number;

  /** Reasoning effort level. */
  effort?: SdkEffortLevel;

  /** Thinking/reasoning configuration. */
  thinking?: SdkThinkingConfig;

  /** Main-thread agent name (must be defined in `agents`). */
  agent?: string;

  /** Subagent definitions keyed by agent name. */
  agents?: Record<string, SdkSubagentConfig>;

  /** MCP server configurations keyed by server name. */
  mcpServers?: Record<string, SdkMcpServerConfig>;

  /** Plugin configurations. */
  plugins?: SdkPluginConfig[];

  /** Custom tool definitions registered at directory level. */
  customTools?: SdkCustomToolConfig[];

  /** Whether to persist sessions to disk. @default true */
  persistSession?: boolean;

  /** Enable file checkpointing to track file changes. */
  enableFileCheckpointing?: boolean;

  /** Output format for structured responses. */
  outputFormat?: SdkOutputFormat;

  /** Include partial/streaming message events in the output. */
  includePartialMessages?: boolean;

  /** Include hook lifecycle events in the output stream. */
  includeHookEvents?: boolean;

  /** Enable prompt suggestions after each turn. */
  promptSuggestions?: boolean;

  /** Enable periodic AI-generated progress summaries for subagents. */
  agentProgressSummaries?: boolean;

  /** System prompt configuration. */
  systemPrompt?: SdkSystemPrompt;

  /** Sandbox settings for command execution isolation. */
  sandbox?: SdkSandboxConfig;

  /** Beta feature flags. */
  betas?: SdkBeta[];

  /** Control which filesystem settings to load. */
  settingSources?: SdkSettingSource[];

  /** Additional settings — path to a settings JSON file or inline object. */
  settings?: string | Record<string, unknown>;

  /** Hook matcher configurations keyed by event name (serializable subset). */
  hooks?: Partial<Record<SdkHookEvent, SdkHookMatcherConfig[]>>;
}
