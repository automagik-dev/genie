/**
 * Workspace Manager — Stub for Group 3.
 *
 * Will manage git worktree isolation for app-level workspaces.
 */

export interface Workspace {
  path: string;
  name: string;
  branch: string | null;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return [];
}

export async function openWorkspace(_path: string): Promise<void> {
  // No-op — will be implemented in Group 3
}

export async function initWorkspace(_path: string): Promise<void> {
  // No-op — will be implemented in Group 3
}
