/**
 * Shared types for the Genie TUI.
 */

export interface TuiOrg {
  id: string;
  name: string;
  slug: string;
}

export interface TuiProject {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  repoPath: string | null;
  tmuxSession: string | null;
}

export interface TuiBoard {
  id: string;
  projectId: string;
  name: string;
  slug: string;
}

export interface TuiColumn {
  id: string;
  boardId: string;
  name: string;
  position: number;
}

export interface TuiTask {
  id: string;
  columnId: string;
  boardId: string;
  title: string;
  slug: string;
  status: string;
  seq: number;
  assignee: string | null;
}

export interface TuiTeam {
  id: string;
  projectId: string;
  name: string;
}

export interface TuiData {
  orgs: TuiOrg[];
  projects: TuiProject[];
  boards: TuiBoard[];
  columns: TuiColumn[];
  tasks: TuiTask[];
  teams: TuiTeam[];
}

/** Discriminated union for TreeNode data — no Record<string, unknown> casts needed */
export type TreeNodeData =
  | ({ kind: 'org' } & TuiOrg)
  | ({ kind: 'project' } & TuiProject & { isLive: boolean; taskCount: number })
  | ({ kind: 'board' } & TuiBoard & { taskCount: number })
  | ({ kind: 'column' } & TuiColumn & { taskCount: number })
  | ({ kind: 'task' } & TuiTask & { active?: boolean; panes?: number });

export interface TuiOptions {
  dev?: boolean;
}
