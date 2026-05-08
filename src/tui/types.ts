/** Shared types for the Genie TUI */

import type { ExecutorState, TransportType } from '../lib/executor-types.js';
import type { ProviderName } from '../lib/provider-adapters.js';

export type TreeNodeType = 'session' | 'window' | 'pane' | 'agent';

export type AgentState = 'running' | 'stopped' | 'error' | 'spawning';

/**
 * Distinguishes top-level workspace agents (`canonical`) from scoped
 * sub-agents (`subagent`, e.g. `felipe/scout`, `genie/devrel`). The kind
 * is set explicitly when the tree is built so renderers and consumers
 * never have to re-derive it from the agent name.
 *
 * Sub-agents are guaranteed to render only as nested children of their
 * parent canonical (depth 1). The current `scanSubAgents`
 * (`src/lib/workspace.ts`) only walks one level — if hierarchy ever
 * extends, this enum and `appendSubAgentNodes` will need revisit.
 */
export type AgentKind = 'canonical' | 'subagent';

/**
 * Work-state derived from `shouldResume()` (invincible-genie / Group 2).
 *
 * This is what the wish actually needs the user to see — process state
 * (`running`/`stopped`/`error`/`spawning`) describes the tmux pane;
 * work state describes the agent's relationship to its task. The two
 * coexist: a `paused` agent can still have a live tmux pane, and a
 * `done` agent can still be `stopped`.
 *
 * Mapping (`ShouldResumeReason` → `WorkState`):
 *   - `ok`                    → `in_flight`        (resume-ready)
 *   - `auto_resume_disabled`  → `paused`
 *   - `assignment_closed`     → `done`
 *   - `no_session_id`         → `stuck`
 *   - `unknown_agent`         → undefined (not a real row)
 */
export type WorkState = 'in_flight' | 'paused' | 'done' | 'stuck';

export interface TreeNode {
  id: string;
  type: TreeNodeType;
  label: string;
  depth: number;
  expanded: boolean;
  children: TreeNode[];
  data: Record<string, unknown>;
  /** Number of active tmux panes for this node */
  activePanes: number;
  /** Agent state if applicable */
  agentState?: 'idle' | 'working' | 'permission' | 'error';
  /** Workspace agent lifecycle state */
  wsAgentState?: AgentState;
  /**
   * Distinguishes canonical workspace agents (top-level) from scoped
   * sub-agents (nested under a canonical parent). Only set on `type:
   * 'agent'` nodes; absent on session/window/pane rows.
   */
  kind?: AgentKind;
  /**
   * Work state derived from `shouldResume()` (invincible-genie / Group 2).
   * Distinct from `wsAgentState` — see {@link WorkState}.
   */
  workState?: WorkState;
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

/** Context menu item for agent actions. */
export interface MenuItem {
  label: string;
  /** Display-only shortcut hint (e.g., 'S', 'K') */
  shortcut: string;
  /** Action identifier dispatched on selection */
  action: string;
  /** Visual separator above this item */
  separator?: boolean;
  /** Item requires text input (e.g., send message) */
  needsInput?: boolean;
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
