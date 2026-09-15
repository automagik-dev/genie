import type { SkillEntry, WorkflowEntry } from '../catalog';
import type { Aggregate } from '../schema';

export type { Aggregate, SkillEntry, WorkflowEntry };
export type Card = Aggregate['lanes'][number]['cards'][number];
export interface Workspace {
  id: string;
  title: string;
}
export interface Board {
  id: string;
  name: string;
  laneCount: number;
  cardCount: number;
}
export interface Health {
  compatible: boolean;
  version: string;
  minimumGenieVersion: string;
  error: string;
  /** Which sub-rows the manager row has mounted; absent on a pre-split Host. */
  mounted?: { board?: boolean; skills?: boolean; workflows?: boolean };
  /** The resolved per-row config, manager first. */
  config?: Record<string, Record<string, unknown>>;
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`/api/genie-board/${path}${query ? `?${query}` : ''}`, {
    headers: { accept: 'application/json' },
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? 'Request failed');
  return value;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/genie-board/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? 'Request failed');
  return value;
}

export const api = {
  health: () => get<Health>('health'),
  workspaces: () => get<Workspace[]>('workspaces'),
  boards: (workspaceId: string) => post<Board[]>('action', { action: 'list', workspaceId }),
  load: (workspaceId: string, boardRef: string) => post<Aggregate>('action', { action: 'load', workspaceId, boardRef }),
  mutate: (workspaceId: string, boardRef: string, action: string, extra: Record<string, unknown>) =>
    post<Aggregate>('action', { action, workspaceId, boardRef, ...extra }),
  skills: (workspaceId: string) => get<SkillEntry[]>('skills', { workspaceId }),
  workflows: (workspaceId: string) => get<WorkflowEntry[]>('workflows', { workspaceId }),
  // Each catalog row owns its own document path: two cordis rows cannot share
  // one exact route, and the split is what makes disable-by-id remove exactly
  // that row's surface.
  document: (workspaceId: string, kind: 'skill' | 'workflow', name: string) =>
    get<{ text: string }>(`${kind === 'skill' ? 'skills' : 'workflows'}/document`, { workspaceId, name }),
};

/** Remembered per browser: the last workspace and board the person looked at. */
export const remembered = {
  get(key: string): string | undefined {
    try {
      return window.localStorage.getItem(`genie-board:${key}`) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(`genie-board:${key}`, value);
    } catch {
      // Storage may be unavailable; the panel works without it.
    }
  },
};
