/**
 * Shared types for genie-app views.
 *
 * Mirrors core CLI types for use in the khal-os app package.
 * These are kept in sync with the CLI source at src/lib/.
 */

// ============================================================================
// Agent Types (from src/lib/agent-registry.ts)
// ============================================================================

export type AgentState = 'spawning' | 'working' | 'idle' | 'permission' | 'question' | 'done' | 'error' | 'suspended';

export interface Agent {
  id: string;
  paneId: string;
  session: string;
  worktree: string | null;
  taskId?: string;
  taskTitle?: string;
  wishSlug?: string;
  groupNumber?: number;
  startedAt: string;
  state: AgentState;
  lastStateChange: string;
  repoPath: string;
  claudeSessionId?: string;
  windowName?: string;
  role?: string;
  customName?: string;
  team?: string;
  currentExecutorId?: string | null;
  reportsTo?: string | null;
  title?: string | null;
}

// ============================================================================
// Executor Types (from src/lib/executor-types.ts)
// ============================================================================

export type ExecutorState =
  | 'spawning'
  | 'running'
  | 'idle'
  | 'working'
  | 'permission'
  | 'question'
  | 'done'
  | 'error'
  | 'terminated';

export interface AgentIdentity {
  id: string;
  startedAt: string;
  role?: string;
  customName?: string;
  team?: string;
  currentExecutorId: string | null;
  reportsTo?: string | null;
  title?: string | null;
}

export interface Executor {
  id: string;
  agentId: string;
  provider: string;
  transport: string;
  pid: number | null;
  tmuxSession: string | null;
  tmuxPaneId: string | null;
  state: ExecutorState;
  worktree: string | null;
  repoPath: string | null;
  startedAt: string;
  endedAt: string | null;
}

// ============================================================================
// Runtime Event Types (from src/lib/runtime-events.ts)
// ============================================================================

export type RuntimeEventKind =
  | 'user'
  | 'assistant'
  | 'message'
  | 'state'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'qa';

export type RuntimeEventSource = 'provider' | 'mailbox' | 'chat' | 'registry' | 'hook';

export interface RuntimeEvent {
  id: number;
  repoPath: string;
  timestamp: string;
  kind: RuntimeEventKind;
  agent: string;
  team?: string;
  text: string;
  data?: Record<string, unknown>;
  source: RuntimeEventSource;
}

// ============================================================================
// Team Types (from src/lib/team-manager.ts)
// ============================================================================

export type TeamStatus = 'in_progress' | 'done' | 'blocked';

export interface TeamConfig {
  name: string;
  repo: string;
  baseBranch: string;
  worktreePath: string;
  leader?: string;
  members: string[];
  status: TeamStatus;
  createdAt: string;
  wishSlug?: string;
}

// ============================================================================
// Task Types (from src/lib/task-service.ts)
// ============================================================================

export interface TaskRow {
  id: string;
  seq: number;
  parentId: string | null;
  repoPath: string;
  projectId: string | null;
  title: string;
  description: string | null;
  typeId: string;
  stage: string;
  status: string;
  priority: string;
  boardId: string | null;
  columnId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TaskFilters {
  repoPath?: string;
  projectName?: string;
  stage?: string;
  status?: string;
  priority?: string;
  typeId?: string;
  parentId?: string | null;
}

// ============================================================================
// View Props
// ============================================================================

export interface AppComponentProps {
  windowId: string;
  meta?: Record<string, unknown>;
}

export interface AgentsViewProps extends AppComponentProps {}

export interface TasksViewProps extends AppComponentProps {}

export interface TerminalViewProps extends AppComponentProps {}

export interface DashboardViewProps extends AppComponentProps {}

export interface ActivityViewProps extends AppComponentProps {}
