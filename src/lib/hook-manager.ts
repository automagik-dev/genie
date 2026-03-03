import { executeTmux } from './tmux.js';

export interface TmuxHook {
  event: string;
  command: string;
}

/**
 * Set a tmux hook for a specific event
 */
export async function setHook(event: string, command: string): Promise<void> {
  await executeTmux(`set-hook -g ${event} '${command.replace(/'/g, "'\\''")}'`);
}

/**
 * Remove a tmux hook
 */
export async function removeHook(event: string): Promise<void> {
  await executeTmux(`set-hook -gu ${event}`);
}

/**
 * List all tmux hooks
 * Note: tmux doesn't have a direct way to list hooks, so we query common hooks
 */
export async function listHooks(): Promise<TmuxHook[]> {
  // Common tmux hooks
  const commonHooks = [
    'after-bind-key',
    'after-capture-pane',
    'after-copy-mode',
    'after-display-message',
    'after-display-panes',
    'after-kill-pane',
    'after-list-buffers',
    'after-list-clients',
    'after-list-keys',
    'after-list-panes',
    'after-list-sessions',
    'after-list-windows',
    'after-load-buffer',
    'after-lock-server',
    'after-new-session',
    'after-new-window',
    'after-paste-buffer',
    'after-pipe-pane',
    'after-queue',
    'after-refresh-client',
    'after-rename-session',
    'after-rename-window',
    'after-resize-pane',
    'after-resize-window',
    'after-save-buffer',
    'after-select-layout',
    'after-select-pane',
    'after-select-window',
    'after-send-keys',
    'after-set-buffer',
    'after-set-environment',
    'after-set-option',
    'after-show-environment',
    'after-show-messages',
    'after-show-options',
    'after-split-window',
    'after-unbind-key',
    'alert-activity',
    'alert-bell',
    'alert-silence',
    'client-attached',
    'client-detached',
    'client-resized',
    'client-session-changed',
    'pane-died',
    'pane-exited',
    'pane-focus-in',
    'pane-focus-out',
    'pane-mode-changed',
    'pane-set-clipboard',
    'session-closed',
    'session-created',
    'session-renamed',
    'session-window-changed',
    'window-linked',
    'window-pane-changed',
    'window-renamed',
    'window-unlinked',
  ];

  const hooks: TmuxHook[] = [];

  // Query each hook to see if it's set
  for (const event of commonHooks) {
    try {
      const command = await executeTmux(`show-hooks -g ${event}`);
      if (command.trim()) {
        // Parse the output (format: "event command")
        const parts = command.trim().split(' ');
        if (parts.length >= 2) {
          hooks.push({
            event: parts[0],
            command: parts.slice(1).join(' '),
          });
        }
      }
    } catch (_error) {}
  }

  return hooks;
}

/**
 * Get a specific hook's command
 */
export async function getHook(event: string): Promise<string | null> {
  try {
    const command = await executeTmux(`show-hooks -g ${event}`);
    if (command.trim()) {
      const parts = command.trim().split(' ');
      if (parts.length >= 2) {
        return parts.slice(1).join(' ');
      }
    }
    return null;
  } catch (_error) {
    return null;
  }
}
