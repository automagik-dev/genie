/** Active work detection + Claude Code state from tmux panes — framework-agnostic */

import { listSessionWindows } from './tmux.js';
import type { Task } from './types.js';

/** Get active work: map tmux windows to tasks */
export function getActiveWork(session: string): Array<{ windowName: string; index: number; active: boolean }> {
  return listSessionWindows(session)
    .filter((w) => w.name !== 'bash' && w.name !== 'zsh')
    .map((w) => ({ windowName: w.name, index: w.index, active: w.active }));
}

/** Match tmux window names to tasks by slug-based matching */
type AgentState = 'idle' | 'working' | 'permission' | 'error';

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
