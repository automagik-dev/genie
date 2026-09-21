import { IconSearchOutline16, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { type WorkflowEntry, api } from './api';
import { IconWorkflows16 } from './icons';
import { Empty, PanelShell, useWorkspaces } from './shell';

function Document({ entry, text }: { entry: WorkflowEntry; text: string | undefined }) {
  return (
    <div className="gb-doc">
      <div className="gb-doc-head">
        <h2>{entry.name}</h2>
        <span className="gb-mono">{entry.path}</span>
      </div>
      <div className="gb-doc-body">
        <p className="gb-doc-desc">{entry.description}</p>
        {entry.whenToUse && <p className="gb-doc-desc">{entry.whenToUse}</p>}
        {entry.phases.length > 0 && (
          <ol className="gb-phases" aria-label="Phases">
            {entry.phases.map((phase) => (
              <li key={phase.title}>
                <span>{phase.title}</span>
                {phase.detail && <small>{phase.detail}</small>}
              </li>
            ))}
          </ol>
        )}
        <div className="gb-invoke">
          <span>Run on Claude Code with</span>
          <code>/{entry.name}</code>
          <span>or on DSH with</span>
          <code>
            /workflow {entry.name} {'{…}'}
          </code>
        </div>
        <pre className="gb-pre" aria-label="Workflow script">
          {text ?? 'Loading…'}
        </pre>
      </div>
    </div>
  );
}

function CatalogPanel({
  icon,
  title,
  fetchEntries,
  emptyHint,
}: {
  icon: ReactNode;
  title: string;
  fetchEntries: (workspaceId: string) => Promise<WorkflowEntry[]>;
  emptyHint: string;
}) {
  const ws = useWorkspaces();
  const [entries, setEntries] = useState<WorkflowEntry[]>([]);
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState('');
  const [text, setText] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { setStatus } = ws;

  const load = useCallback(
    async (workspaceId: string) => {
      setBusy(true);
      setStatus({ tone: 'busy', text: `Reading ${title.toLowerCase()}…` });
      try {
        const list = await fetchEntries(workspaceId);
        setEntries(list);
        setSelected((current) => (list.some((entry) => entry.name === current) ? current : list[0]?.name));
        setStatus({ tone: 'idle', text: list.length ? `${list.length} in this workspace` : '' });
      } catch (error) {
        setEntries([]);
        setStatus({ tone: 'error', text: error instanceof Error ? error.message : 'Request failed' });
      } finally {
        setBusy(false);
      }
    },
    [fetchEntries, setStatus, title],
  );

  useEffect(() => {
    if (ws.workspaceId) void load(ws.workspaceId);
  }, [ws.workspaceId, load]);

  useEffect(() => {
    if (!ws.workspaceId || !selected) return;
    let live = true;
    setText(undefined);
    api
      .document(ws.workspaceId, selected)
      .then((doc) => live && setText(doc.text))
      .catch(
        (error: unknown) => live && setText(error instanceof Error ? error.message : 'Could not read the document'),
      );
    return () => {
      live = false;
    };
  }, [ws.workspaceId, selected]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(needle));
  }, [entries, query]);
  const current = entries.find((entry) => entry.name === selected);

  return (
    <PanelShell
      icon={icon}
      title={title}
      subtitle={entries.length ? String(entries.length) : undefined}
      workspaces={ws.workspaces}
      workspaceId={ws.workspaceId}
      onWorkspace={(id) => {
        ws.setWorkspaceId(id);
        setSelected(undefined);
      }}
      onRefresh={() => (ws.workspaceId ? void load(ws.workspaceId) : void ws.reload())}
      busy={busy}
      status={ws.status}
    >
      {!entries.length && !busy ? (
        <Empty title={`No ${title.toLowerCase()} in this workspace`} hint={emptyHint} />
      ) : (
        <>
          <nav className="gb-list" aria-label={`${title} list`}>
            <div className="gb-list-search">
              <input
                className="gb-select"
                style={{ backgroundImage: 'none', paddingRight: 10, width: '100%', maxWidth: 'none' }}
                aria-label={`Filter ${title.toLowerCase()}`}
                placeholder={`Filter ${title.toLowerCase()}`}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
            {visible.map((entry) => (
              <button
                key={entry.name}
                type="button"
                className="gb-item"
                aria-current={entry.name === selected}
                onClick={() => setSelected(entry.name)}
              >
                <span className="gb-item-name">
                  {entry.name}
                  {entry.phases.length > 0 && <Tag tone="quiet">{entry.phases.length} phases</Tag>}
                </span>
                <span className="gb-item-desc">{entry.description}</span>
              </button>
            ))}
            {!visible.length && (
              <div className="gb-empty">
                <IconSearchOutline16 />
                <span>No match</span>
              </div>
            )}
          </nav>
          {current ? <Document entry={current} text={text} /> : <Empty title="Select an entry" />}
        </>
      )}
    </PanelShell>
  );
}

export function WorkflowsPanel() {
  return (
    <CatalogPanel
      icon={<IconWorkflows16 />}
      title="Workflows"
      fetchEntries={api.workflows}
      emptyHint="Saved workflows live under .claude/workflows/<name>.js in the repository."
    />
  );
}
