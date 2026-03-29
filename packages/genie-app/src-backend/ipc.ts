/**
 * IPC Command Registry — Tauri invoke command handlers.
 *
 * Each exported function maps to a Tauri invoke command.
 * Returns JSON-serializable results for the webview frontend.
 */

import * as pgBridge from './pg-bridge.js';
import * as pty from './pty.js';
import * as workspace from './workspace.js';

// ============================================================================
// Agent Commands
// ============================================================================

export async function list_agents() {
  return pgBridge.listAgents();
}

export async function show_agent(params: { id: string }) {
  return pgBridge.showAgent(params.id);
}

// ============================================================================
// Task Commands
// ============================================================================

export async function list_tasks(params: { boardId?: string }) {
  return pgBridge.listTasks(params.boardId);
}

export async function kanban_board(params: { boardId: string }) {
  return pgBridge.kanbanBoard(params.boardId);
}

// ============================================================================
// Team Commands
// ============================================================================

export async function list_teams() {
  return pgBridge.listTeams();
}

// ============================================================================
// Dashboard Commands
// ============================================================================

export async function dashboard_stats() {
  return pgBridge.dashboardStats();
}

// ============================================================================
// Event Commands
// ============================================================================

export async function stream_events(params: { afterId?: number; team?: string; limit?: number }) {
  return pgBridge.streamEvents(params);
}

// ============================================================================
// Terminal Commands
// ============================================================================

export async function spawn_terminal(params: {
  agentName?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}) {
  if (params.agentName) {
    const session = await pty.spawnForAgent(params.agentName, {
      cwd: params.cwd,
      cols: params.cols,
      rows: params.rows,
    });
    return {
      sessionId: session.id,
      agentId: session.agentId,
      executorId: session.executorId,
    };
  }

  const session = pty.spawnBash(params.cwd);
  return {
    sessionId: session.id,
    agentId: null,
    executorId: null,
  };
}

export function write_terminal(params: { sessionId: string; data: string }) {
  return { ok: pty.writeTerminal(params.sessionId, params.data) };
}

export function resize_terminal(params: { sessionId: string; cols: number; rows: number }) {
  return { ok: pty.resizeTerminal(params.sessionId, params.cols, params.rows) };
}

export async function kill_terminal(params: { sessionId: string }) {
  return { ok: await pty.killTerminal(params.sessionId) };
}

// ============================================================================
// Workspace Commands
// ============================================================================

export async function list_workspaces() {
  return workspace.listWorkspaces();
}

export async function open_workspace(params: { path: string }) {
  await workspace.openWorkspace(params.path);
  return { ok: true };
}

export async function init_workspace(params: { path: string }) {
  await workspace.initWorkspace(params.path);
  return { ok: true };
}

// ============================================================================
// Command Map
// ============================================================================

export const commands: Record<string, (params: never) => unknown> = {
  list_agents,
  show_agent,
  list_tasks,
  kanban_board,
  list_teams,
  dashboard_stats,
  stream_events,
  spawn_terminal,
  write_terminal,
  resize_terminal,
  kill_terminal,
  list_workspaces,
  open_workspace,
  init_workspace,
};
