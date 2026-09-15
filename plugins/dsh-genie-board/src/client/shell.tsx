import { Button, IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { type Workspace, api, remembered } from './api';

/** Loading, error and confirmation line under the panel header. */
export interface Status {
  tone: 'idle' | 'busy' | 'ok' | 'error';
  text: string;
}

/** Workspace selection shared by every panel; remembered per browser. */
export function useWorkspaces(): {
  workspaces: Workspace[];
  workspaceId: string;
  setWorkspaceId: (id: string) => void;
  status: Status;
  setStatus: (status: Status) => void;
  reload: () => Promise<void>;
} {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, select] = useState(remembered.get('workspace') ?? '');
  const [status, setStatus] = useState<Status>({ tone: 'idle', text: '' });
  const setWorkspaceId = useCallback((id: string) => {
    remembered.set('workspace', id);
    select(id);
  }, []);
  const reload = useCallback(async () => {
    setStatus({ tone: 'busy', text: 'Loading workspaces…' });
    try {
      const list = await api.workspaces();
      setWorkspaces(list);
      const current = remembered.get('workspace');
      const next = list.find((entry) => entry.id === current)?.id ?? list[0]?.id ?? '';
      select(next);
      if (next) remembered.set('workspace', next);
      setStatus(
        list.length
          ? { tone: 'idle', text: '' }
          : { tone: 'error', text: 'Add a repository workspace in DSH to browse its Genie catalog.' },
      );
    } catch (error) {
      setStatus({ tone: 'error', text: error instanceof Error ? error.message : 'Request failed' });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { workspaces, workspaceId, setWorkspaceId, status, setStatus, reload };
}

/** Common panel chrome: title row with workspace picker and refresh, then a status line. */
export function PanelShell({
  icon,
  title,
  subtitle,
  workspaces,
  workspaceId,
  onWorkspace,
  onRefresh,
  busy,
  status,
  actions,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  workspaces: Workspace[];
  workspaceId: string;
  onWorkspace: (id: string) => void;
  onRefresh: () => void;
  busy: boolean;
  status: Status;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="gb-panel" aria-label={title}>
      <header className="gb-head">
        <h1 className="gb-title">
          {icon}
          {title}
          {subtitle && <span className="gb-sub">{subtitle}</span>}
        </h1>
        <select
          className="gb-select"
          aria-label="Workspace"
          value={workspaceId}
          onChange={(event) => onWorkspace(event.currentTarget.value)}
          disabled={busy || !workspaces.length}
        >
          {workspaces.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.title}
            </option>
          ))}
        </select>
        {actions}
        <Button size="sm" variant="outline" icon={<IconRefreshOutline16 />} onClick={onRefresh} disabled={busy}>
          Refresh
        </Button>
      </header>
      <div
        className="gb-status"
        role={status.tone === 'error' ? 'alert' : 'status'}
        aria-live="polite"
        data-tone={status.tone === 'busy' ? 'idle' : status.tone}
      >
        {status.text}
      </div>
      <div className="gb-body">{children}</div>
    </section>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="gb-empty">
      <strong>{title}</strong>
      {hint && <span>{hint}</span>}
    </div>
  );
}

export function when(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
