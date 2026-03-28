/** Active work detection + Claude Code state from tmux panes — framework-agnostic */

import { listSessionWindows } from './tmux.js';
import type { ClaudeState, Task } from './types.js';

/** Detect Claude Code state from pane content */
export function detectClaudeState(paneContent: string): ClaudeState {
  if (!paneContent.trim()) return 'unknown';

  const lines = paneContent.split('\n').filter((l) => l.trim());
  const lastLines = lines.slice(-5).join('\n').toLowerCase();

  // Permission prompt detection
  if (lastLines.includes('allow') || lastLines.includes('deny') || lastLines.includes('(y/n)')) {
    return 'permission';
  }

  // Error detection
  if (lastLines.includes('error:') || lastLines.includes('fatal:') || lastLines.includes('panic:')) {
    return 'error';
  }

  // Idle detection: shows prompt or waiting for input
  if (lastLines.includes('> ') || lastLines.includes('claude') || lastLines.includes('$') || lastLines.includes('%%')) {
    return 'idle';
  }

  // Default: if pane has content and no prompt, agent is working
  return 'working';
}

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
    // Try to match task by title slug or seq
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

/** Aggregate agent states for a project: any working = working */
export function aggregateState(states: Array<ClaudeState | undefined>): ClaudeState {
  if (states.some((s) => s === 'permission')) return 'permission';
  if (states.some((s) => s === 'working')) return 'working';
  if (states.some((s) => s === 'error')) return 'error';
  if (states.some((s) => s === 'idle')) return 'idle';
  return 'unknown';
}
