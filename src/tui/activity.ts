/** Active work detection — executor state from DB, tmux window matching as fallback */

import type { ExecutorState } from '../lib/executor-types.js';
import { listSessionWindows } from './tmux.js';
import type { Task, TuiAssignment, TuiExecutor } from './types.js';

type AgentState = 'idle' | 'working' | 'permission' | 'error';

/** Map executor state to a TUI-visible agent state. */
function toAgentState(state: ExecutorState): AgentState | undefined {
  switch (state) {
    case 'idle':
    case 'running':
      return 'idle';
    case 'working':
    case 'spawning':
      return 'working';
    case 'permission':
    case 'question':
      return 'permission';
    case 'error':
      return 'error';
    default:
      return undefined;
  }
}

function statePriority(state: AgentState): number {
  switch (state) {
    case 'working':
      return 3;
    case 'permission':
      return 2;
    case 'error':
      return 1;
    case 'idle':
      return 0;
  }
}

/** Group assignments by task ID, resolving each to its executor. */
function groupByTask(executors: TuiExecutor[], assignments: TuiAssignment[]): Map<string, TuiExecutor[]> {
  const executorById = new Map(executors.map((e) => [e.id, e]));
  const result = new Map<string, TuiExecutor[]>();
  for (const a of assignments) {
    if (!a.taskId) continue;
    const exec = executorById.get(a.executorId);
    if (!exec) continue;
    const list = result.get(a.taskId) || [];
    list.push(exec);
    result.set(a.taskId, list);
  }
  return result;
}

/** Pick the highest-priority agent state from a list of executors. */
function bestExecutorState(execs: TuiExecutor[]): AgentState | undefined {
  let best: AgentState | undefined;
  for (const exec of execs) {
    const state = toAgentState(exec.state);
    if (state && (!best || statePriority(state) > statePriority(best))) best = state;
  }
  return best;
}

/**
 * Build activity map from executors + assignments (DB-driven).
 * Maps task IDs to their executor count and aggregate state.
 */
export function getExecutorActivity(
  executors: TuiExecutor[],
  assignments: TuiAssignment[],
): Map<string, { panes: number; state?: AgentState }> {
  const result = new Map<string, { panes: number; state?: AgentState }>();
  for (const [taskId, execs] of groupByTask(executors, assignments)) {
    result.set(taskId, { panes: execs.length, state: bestExecutorState(execs) });
  }
  return result;
}

/** Get active work from tmux windows (fallback for tasks without DB assignments). */
export function getActiveWork(session: string): Array<{ windowName: string; index: number; active: boolean }> {
  return listSessionWindows(session)
    .filter((w) => w.name !== 'bash' && w.name !== 'zsh')
    .map((w) => ({ windowName: w.name, index: w.index, active: w.active }));
}

/** Match tmux window names to tasks by slug-based matching (fallback). */
export function matchWorkToTasks(
  windows: Array<{ windowName: string; index: number }>,
  tasks: Task[],
): Map<string, { panes: number; state?: AgentState }> {
  const result = new Map<string, { panes: number; state?: AgentState }>();

  for (const win of windows) {
    const slug = win.windowName.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const matched = tasks.find((t) => {
      const taskSlug = t.title.toLowerCase().replace(/[^a-z0-9-]/g, '');
      return taskSlug.includes(slug) || slug.includes(taskSlug) || slug.includes(`${t.seq}`);
    });
    if (matched) {
      const existing = result.get(matched.id) || { panes: 0 };
      result.set(matched.id, { panes: existing.panes + 1, state: existing.state });
    }
  }

  return result;
}
