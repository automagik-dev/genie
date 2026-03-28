/** Shared types for the Genie TUI */

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

export interface TuiData {
  orgs: Org[];
  projects: Project[];
  boards: Board[];
  tasks: Task[];
  agentProjects: AgentProject[];
}

export type ClaudeState = 'idle' | 'working' | 'permission' | 'error' | 'unknown';
