/**
 * Activity detection — match tmux windows to tasks, detect Claude Code state.
 * Group 6 of genie-tui-v1.
 */

import { execSync } from 'node:child_process';

export type ClaudeState = 'idle' | 'working' | 'permission' | 'error' | 'offline';

export interface ActiveWork {
  name: string;
  panes: number;
  window: string;
  session: string;
}

/** List active (non-default) tmux windows for a session. */
export function getActiveWork(session: string): ActiveWork[] {
  try {
    const out = execSync(`tmux list-windows -t ${session} -F '#{window_index}|#{window_name}|#{window_panes}'`, {
      encoding: 'utf8',
      timeout: 2000,
    });
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [idx, name, panes] = l.split('|');
        return { name: name ?? '', panes: +(panes ?? 1), window: `${session}:${idx}`, session };
      })
      .filter((w) => {
        // Skip system windows — only show actual work
        const skip = new Set([session, 'bash', 'tui', 'main', 'board-genie-research']);
        if (skip.has(w.name)) return false;
        if (w.name.includes('-iyl6')) return false;
        if (w.window === `${session}:0`) return false; // leader default window
        return true;
      });
  } catch {
    return [];
  }
}

/** Detect Claude Code state by capturing pane content. */
export function detectClaudeState(paneId: string): ClaudeState {
  try {
    const content = execSync(`tmux capture-pane -t '${paneId}' -p -S -6`, {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();

    if (!content) return 'idle';

    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping requires control chars
    const text = content.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI
    const lines = text.split('\n').filter((l) => l.trim());
    const last = lines.slice(-5).join('\n');

    // Claude Code prompt: ❯ (\u276F)
    if (last.includes('\u276F') || last.includes('❯')) return 'idle';
    // Permission request
    if (last.includes('Allow') || last.includes('(y/n)') || last.includes('approve')) return 'permission';
    // Error
    if (last.includes('Error:') || last.includes('FATAL') || last.includes('panic')) return 'error';
    // Working (generating output, no prompt visible)
    return 'working';
  } catch {
    return 'offline';
  }
}

/** Get aggregate state for a tmux session (any working = working). */
export function getSessionState(session: string): ClaudeState {
  try {
    const out = execSync(`tmux list-panes -s -t ${session} -F '#{pane_id}|#{pane_current_command}'`, {
      encoding: 'utf8',
      timeout: 2000,
    });
    const claudePanes = out
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((l) => l.split('|')[1] === 'claude')
      .map((l) => l.split('|')[0] ?? '');

    if (claudePanes.length === 0) return 'offline';

    let hasWorking = false;
    let hasPermission = false;

    for (const paneId of claudePanes) {
      const state = detectClaudeState(paneId);
      if (state === 'working') hasWorking = true;
      if (state === 'permission') hasPermission = true;
    }

    if (hasPermission) return 'permission';
    if (hasWorking) return 'working';
    return 'idle';
  } catch {
    return 'offline';
  }
}

/** Match tmux window names to task slugs. Returns set of matched task title prefixes. */
export function matchWorkToTasks(
  activeWork: ActiveWork[],
  tasks: Array<{ title: string; seq: number }>,
): Map<number, ActiveWork> {
  const matches = new Map<number, ActiveWork>();
  for (const work of activeWork) {
    for (const task of tasks) {
      // Match by slug: "fix-cli-polish — desc" → "fix-cli-polish"
      const slug = task.title.split(' — ')[0]?.split(' ')[0] ?? '';
      if (slug && work.name === slug) {
        matches.set(task.seq, work);
      }
    }
  }
  return matches;
}
