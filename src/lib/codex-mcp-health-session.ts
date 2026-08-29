/** Legacy proof-shape types retained while runtime integration evidence migrates to the A7 retired state. */

export const REQUIRED_GENIE_MCP_TOOLS = [
  'genie_board',
  'genie_wish_status',
  'genie_worktree_context',
  'genie_task',
  'genie_active',
] as const;

export interface BoundedCodexMcpSessionOptions {
  launcherPath: string;
  cwd: string;
  nodePath?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  requiredTools?: readonly string[];
}

export interface McpSessionResult {
  ok: boolean;
  detail: string;
  tools?: readonly string[];
  wishStatusReadOnly?: boolean;
}
