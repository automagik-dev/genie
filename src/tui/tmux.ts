/**
 * TUI tmux integration — session/pane/window management.
 *
 * Creates a genie-tui outer session with:
 *   - Left pane: Ink nav tree (30 cols)
 *   - Right pane: nested tmux attach to project agent sessions
 *
 * Keybindings (global on outer session):
 *   Tab     — switch focus between left/right panes
 *   Ctrl+B  — toggle nav panel (0 ↔ 30 cols)
 *   Ctrl+T  — new window tab in inner (right pane) session
 *   Ctrl+\  — quit: unbind, kill session
 */

import { execSync } from 'node:child_process';
import { executeTmux } from '../lib/tmux.js';

const TUI_SESSION = 'genie-tui';
const NAV_WIDTH = 30;

/** Pane IDs captured after session creation. */
let leftPaneId = '';
let rightPaneId = '';
let navCollapsed = false;
let currentProjectSession: string | null = null;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Run a tmux command synchronously. Used in places where we need
 * guaranteed ordering (session creation, key bindings).
 */
function tmuxSync(cmd: string): string {
  try {
    return execSync(`tmux ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

/**
 * Check if tmux is available on the system.
 */
export function hasTmux(): boolean {
  try {
    execSync('tmux -V', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if we're currently inside a tmux session.
 */
export function insideTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Get the current terminal dimensions.
 */
function getTermSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 40,
  };
}

// ─── Session Lifecycle ─────────────────────────────────────────────────────

/**
 * Create the genie-tui tmux session with left (Ink) + right (agent) split.
 *
 * Architecture:
 *   1. Kill any stale genie-tui session
 *   2. Create new detached session (full terminal width)
 *   3. Split horizontally: left=30 cols (Ink nav), right=rest (agent pane)
 *   4. Left pane runs the Ink process (passed back to caller)
 *   5. Right pane starts empty or with a nested attach
 *   6. Install keybindings on the outer session
 *   7. Attach to the session
 *
 * Returns the left pane ID so the caller can pipe Ink output into it.
 */
export async function createTuiSession(): Promise<{
  session: string;
  leftPane: string;
  rightPane: string;
}> {
  // Kill stale session if exists
  try {
    await executeTmux(`kill-session -t '${TUI_SESSION}'`);
  } catch {
    /* no session to kill */
  }

  const { cols, rows } = getTermSize();

  // Create detached session with explicit size
  tmuxSync(`new-session -d -s '${TUI_SESSION}' -x ${cols} -y ${rows}`);

  // The initial window becomes the left pane host
  // Split: left pane stays at NAV_WIDTH, right pane gets the rest
  const rightId = tmuxSync(`split-window -d -h -t '${TUI_SESSION}:0' -l ${cols - NAV_WIDTH - 1} -P -F '#{pane_id}'`);
  rightPaneId = rightId;

  // Get the left pane ID (it's the original pane from session creation)
  const panes = tmuxSync(`list-panes -t '${TUI_SESSION}:0' -F '#{pane_id}'`);
  const paneIds = panes.split('\n').filter(Boolean);
  leftPaneId = paneIds.find((id) => id !== rightPaneId) || paneIds[0];

  // Style the outer session
  styleOuterSession();

  // Install keybindings
  installKeybindings();

  // Right pane starts with a welcome message
  tmuxSync(`send-keys -t '${rightPaneId}' 'echo \"Select a project in the nav panel to open its session\"' Enter`);

  return {
    session: TUI_SESSION,
    leftPane: leftPaneId,
    rightPane: rightPaneId,
  };
}

/**
 * Style the outer tmux session — 2050 purple/cyan palette.
 */
function styleOuterSession(): void {
  const s = TUI_SESSION;

  // Status bar: dark bg, purple accent
  tmuxSync(`set-option -t '${s}' status on`);
  tmuxSync(`set-option -t '${s}' status-style 'bg=#1a1028,fg=#a855f7'`);
  tmuxSync(`set-option -t '${s}' status-left '#[bg=#7c3aed,fg=#ffffff,bold] GENIE TUI #[default] '`);
  tmuxSync(`set-option -t '${s}' status-left-length 20`);
  tmuxSync(
    `set-option -t '${s}' status-right '#[fg=#22d3ee]%H:%M #[fg=#a855f7]│ #[fg=#34d399]Tab:switch #[fg=#a855f7]│ #[fg=#34d399]C-b:nav #[fg=#a855f7]│ #[fg=#34d399]C-t:tab #[fg=#a855f7]│ #[fg=#34d399]C-\\\\:quit'`,
  );
  tmuxSync(`set-option -t '${s}' status-right-length 80`);

  // Pane borders: purple theme
  tmuxSync(`set-option -t '${s}' pane-border-style 'fg=#3b2063'`);
  tmuxSync(`set-option -t '${s}' pane-active-border-style 'fg=#a855f7'`);

  // No window list in status (the tab bar is on the inner session)
  tmuxSync(`set-option -t '${s}' window-status-format ''`);
  tmuxSync(`set-option -t '${s}' window-status-current-format ''`);

  // Mouse support for pane switching
  tmuxSync(`set-option -t '${s}' mouse on`);

  // Don't exit on last shell exit (we manage lifecycle)
  tmuxSync(`set-option -t '${s}' remain-on-exit off`);
}

// ─── Keybindings ───────────────────────────────────────────────────────────

/**
 * Install keybindings on the genie-tui session.
 *
 * These are session-scoped (won't affect other tmux sessions).
 * We use the root key table so they work from any pane.
 */
function installKeybindings(): void {
  const s = TUI_SESSION;

  // Tab — switch focus between left/right panes
  tmuxSync(
    `bind-key -T root -t '${s}' Tab select-pane -t '${s}:0.+' 2>/dev/null || tmux bind-key -T root Tab select-pane -t '${s}:0.+'`,
  );

  // Ctrl+B — toggle nav panel width (0 ↔ 30 cols)
  // We use a run-shell to toggle — stores state in a tmux env var
  tmuxSync(`set-environment -t '${s}' GENIE_NAV_COLLAPSED 0`);
  const toggleScript = `
    state=$(tmux show-environment -t '${s}' GENIE_NAV_COLLAPSED 2>/dev/null | cut -d= -f2);
    if [ "$state" = "1" ]; then
      tmux resize-pane -t '${leftPaneId}' -x ${NAV_WIDTH};
      tmux set-environment -t '${s}' GENIE_NAV_COLLAPSED 0;
    else
      tmux resize-pane -t '${leftPaneId}' -x 0;
      tmux set-environment -t '${s}' GENIE_NAV_COLLAPSED 1;
    fi
  `
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  tmuxSync(`bind-key -T root C-b run-shell "${toggleScript}"`);

  // Ctrl+T — new window tab in the inner (right pane) session
  // This sends the key sequence to the right pane, which hosts a nested tmux
  const newTabScript = `
    proj=$(tmux show-environment -t '${s}' GENIE_ACTIVE_PROJECT 2>/dev/null | cut -d= -f2);
    if [ -n "$proj" ]; then
      tmux send-keys -t '${rightPaneId}' C-b c;
    fi
  `
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  tmuxSync(`bind-key -T root C-t run-shell "${newTabScript}"`);

  // Ctrl+\ — quit cleanly
  const quitScript = `tmux kill-session -t '${s}'`;
  tmuxSync(`bind-key -T root 'C-\\\\' run-shell "${quitScript}"`);
}

/**
 * Remove all custom keybindings from the genie-tui session.
 */
function unbindKeybindings(): void {
  tmuxSync('unbind-key -T root Tab');
  tmuxSync('unbind-key -T root C-b');
  tmuxSync('unbind-key -T root C-t');
  tmuxSync("unbind-key -T root 'C-\\\\'");
}

// ─── Project Attach / Switch ───────────────────────────────────────────────

/**
 * Attach a project's tmux session into the right pane via nested attach.
 *
 * Uses `TMUX='' tmux attach -t <session>` trick to nest tmux sessions.
 * The inner session gets tab-styled chrome for its windows.
 */
export async function attachProject(sessionName: string): Promise<void> {
  if (!rightPaneId) return;

  // Check if the target session exists
  try {
    const check = await executeTmux(`has-session -t '${sessionName}'`);
    void check;
  } catch {
    // Session doesn't exist — show message in right pane
    tmuxSync(`send-keys -t '${rightPaneId}' 'echo \"No tmux session found: ${sessionName}\"' Enter`);
    return;
  }

  // Respawn the right pane with a nested tmux attach
  // TMUX='' allows nesting; we set the inner session's prefix to Ctrl+A to avoid conflicts
  const attachCmd = `TMUX='' tmux attach-session -t '${sessionName}'`;
  tmuxSync(`respawn-pane -k -t '${rightPaneId}' '${attachCmd}'`);

  // Store active project for Ctrl+T
  tmuxSync(`set-environment -t '${TUI_SESSION}' GENIE_ACTIVE_PROJECT '${sessionName}'`);

  // Style the inner session's chrome as tabs
  await styleAsTabs(sessionName);

  currentProjectSession = sessionName;
}

/**
 * Style the inner (project) session's window list as a tab bar.
 *
 * Makes tmux windows look like browser tabs:
 *   - Active tab: bright purple bg, white text
 *   - Inactive tabs: dim bg, muted text
 *   - Clickable via mouse mode
 */
export async function styleAsTabs(sessionName: string): Promise<void> {
  try {
    // Status bar at top for tab feel
    await executeTmux(`set-option -t '${sessionName}' status-position top`);

    // Tab bar styling
    await executeTmux(`set-option -t '${sessionName}' status-style 'bg=#1a1028,fg=#8b8b8b'`);

    // Active tab: purple highlight
    await executeTmux(
      `set-option -t '${sessionName}' window-status-current-format '#[bg=#7c3aed,fg=#ffffff,bold] #I:#W #[default]'`,
    );

    // Inactive tabs: subtle
    await executeTmux(`set-option -t '${sessionName}' window-status-format '#[fg=#6b6b8b] #I:#W #[default]'`);

    // Left status: session name
    await executeTmux(`set-option -t '${sessionName}' status-left '#[fg=#22d3ee,bold]${sessionName} #[fg=#3b2063]│ '`);
    await executeTmux(`set-option -t '${sessionName}' status-left-length 30`);

    // Right status: minimal
    await executeTmux(`set-option -t '${sessionName}' status-right ''`);

    // Pane borders matching palette
    await executeTmux(`set-option -t '${sessionName}' pane-border-style 'fg=#3b2063'`);
    await executeTmux(`set-option -t '${sessionName}' pane-active-border-style 'fg=#22d3ee'`);

    // Mouse support for tab clicking
    await executeTmux(`set-option -t '${sessionName}' mouse on`);
  } catch {
    /* best-effort — inner session may have been killed */
  }
}

/**
 * Switch the right pane to a different project session.
 *
 * Uses respawn-pane for instant switching (<500ms).
 * Preserves the old session (just detaches from it).
 */
export async function switchRightPane(sessionName: string): Promise<void> {
  if (!rightPaneId) return;

  // Skip if already showing this project
  if (currentProjectSession === sessionName) return;

  await attachProject(sessionName);
}

// ─── Cleanup ───────────────────────────────────────────────────────────────

/**
 * Clean up: unbind all keybindings, kill the genie-tui session.
 * Called on exit (Ctrl+\ or normal exit).
 */
export async function cleanup(): Promise<void> {
  unbindKeybindings();

  try {
    await executeTmux(`kill-session -t '${TUI_SESSION}'`);
  } catch {
    /* session already gone */
  }

  // Reset module state
  leftPaneId = '';
  rightPaneId = '';
  navCollapsed = false;
  currentProjectSession = null;
}

// ─── Queries ───────────────────────────────────────────────────────────────

/**
 * Get the TUI session name constant.
 */
export function getTuiSessionName(): string {
  return TUI_SESSION;
}

/**
 * Get the nav width constant.
 */
export function getNavWidth(): number {
  return NAV_WIDTH;
}

/**
 * Get the current right pane ID.
 */
export function getRightPaneId(): string {
  return rightPaneId;
}

/**
 * Get the current left pane ID.
 */
export function getLeftPaneId(): string {
  return leftPaneId;
}

/**
 * Check if nav is currently collapsed.
 */
export function isNavCollapsed(): boolean {
  return navCollapsed;
}

/**
 * Get the name of the currently attached project session.
 */
export function getCurrentProjectSession(): string | null {
  return currentProjectSession;
}

/**
 * List windows in the currently attached project session (for tab bar info).
 */
export async function listProjectWindows(): Promise<
  Array<{ id: string; name: string; index: number; active: boolean }>
> {
  if (!currentProjectSession) return [];

  try {
    const format = '#{window_id}:#{window_name}:#{window_index}:#{?window_active,1,0}';
    const output = await executeTmux(`list-windows -t '${currentProjectSession}' -F '${format}'`);
    if (!output) return [];

    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, name, indexStr, active] = line.split(':');
        return {
          id,
          name,
          index: Number.parseInt(indexStr, 10),
          active: active === '1',
        };
      });
  } catch {
    return [];
  }
}

/**
 * Check if a project session exists in tmux.
 */
export async function hasProjectSession(sessionName: string): Promise<boolean> {
  try {
    await executeTmux(`has-session -t '${sessionName}'`);
    return true;
  } catch {
    return false;
  }
}
