/** Shared types for the Genie TUI */

import type { ExecutorState, TransportType } from '../lib/executor-types.js';
import type { ProviderName } from '../lib/provider-adapters.js';

export interface Org {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  leaderAgent: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  orgId: string | null;
  leaderAgent: string | null;
  tmuxSession: string | null;
  repoPath: string | null;
}

export interface Board {
  id: string;
  name: string;
  projectId: string | null;
  description: string | null;
  columns: BoardColumn[];
}

export interface BoardColumn {
  id: string;
  name: string;
  label: string;
  color: string;
  position: number;
}

export interface Task {
  id: string;
  seq: number;
  title: string;
  status: string;
  stage: string;
  priority: string;
  projectId: string | null;
  boardId: string | null;
  columnId: string | null;
  description: string | null;
}

export interface AgentProject {
  agentName: string;
  projectId: string;
  role: string;
}

export type TreeNodeType = 'org' | 'project' | 'board' | 'column' | 'task';

export interface TreeNode {
  id: string;
  type: TreeNodeType;
  label: string;
  depth: number;
  expanded: boolean;
  children: TreeNode[];
  data: Org | Project | Board | BoardColumn | Task;
  /** Number of active tmux panes for this node */
  activePanes: number;
  /** Agent state if applicable */
  agentState?: 'idle' | 'working' | 'permission' | 'error';
}

export interface FlatNode {
  node: TreeNode;
  depth: number;
  visible: boolean;
}

/** Executor runtime as seen by the TUI — joined with agent identity. */
export interface TuiExecutor {
  id: string;
  agentId: string;
  agentName: string | null;
  provider: ProviderName;
  transport: TransportType;
  pid: number | null;
  tmuxSession: string | null;
  tmuxPaneId: string | null;
  state: ExecutorState;
  metadata: Record<string, unknown>;
  startedAt: string;
  role: string | null;
  team: string | null;
}

/** Active assignment linking an executor to a task. */
export interface TuiAssignment {
  id: string;
  executorId: string;
  taskId: string | null;
  taskTitle: string | null;
  wishSlug: string | null;
  groupNumber: number | null;
  startedAt: string;
}

export interface TuiData {
  orgs: Org[];
  projects: Project[];
  boards: Board[];
  tasks: Task[];
  agentProjects: AgentProject[];
}
