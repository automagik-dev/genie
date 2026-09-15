import { IconSearchOutline16, IconSkillOutline16, Tag } from '@deepseek-ai/dsh-client-ui-primitives';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SKILL_CATEGORIES } from '../taxonomy';
import { type SkillEntry, type WorkflowEntry, api } from './api';
import { IconWorkflows16 } from './icons';
import { Empty, PanelShell, useWorkspaces } from './shell';

type Kind = 'skill' | 'workflow';
type Entry = SkillEntry | WorkflowEntry;

function isWorkflow(entry: Entry): entry is WorkflowEntry {
  return 'phases' in entry;
}

/** The label shown above an uncategorized group; always last. */
const UNCATEGORIZED = 'Other';

/**
 * Group the visible entries by their declared `category`, in taxonomy order,
 * with everything uncategorized last. A workflow list has no categories, so it
 * comes back as one unlabelled group and renders exactly as it did before.
 */
export function groupByCategory(entries: Entry[], grouped: boolean): { label?: string; entries: Entry[] }[] {
  if (!grouped) return [{ entries }];
  const buckets = new Map<string, Entry[]>();
  for (const entry of entries) {
    const category = (entry as SkillEntry).category;
    const key: string = category ?? UNCATEGORIZED;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }
  const order = [...SKILL_CATEGORIES, UNCATEGORIZED] as readonly string[];
  return order
    .filter((label) => buckets.has(label))
    .map((label) => ({ label, entries: buckets.get(label) as Entry[] }));
}

function Document({ kind, entry, text }: { kind: Kind; entry: Entry; text: string | undefined }) {
  return (
    <div className="gb-doc">
      <div className="gb-doc-head">
        <h2>{entry.name}</h2>
        <span className="gb-mono">{entry.path}</span>
      </div>
      <div className="gb-doc-body">
        <p className="gb-doc-desc">{entry.description}</p>
        {isWorkflow(entry) ? (
          <>
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
          </>
        ) : (
          <>
            {entry.resources.length > 0 && (
              <div className="gb-chips" aria-label="Shipped resources">
                {entry.resources.map((resource) => (
                  <Tag key={resource} tone="neutral">
                    {resource}
                  </Tag>
                ))}
              </div>
            )}
            <div className="gb-invoke">
              <span>Invoke with</span>
              <code>/{entry.name}</code>
            </div>
          </>
        )}
        <pre className="gb-pre" aria-label={kind === 'skill' ? 'SKILL.md' : 'Workflow script'}>
          {text ?? 'Loading…'}
        </pre>
      </div>
    </div>
  );
}

function CatalogPanel({
  kind,
  icon,
  title,
  fetchEntries,
  emptyHint,
  grouped = false,
}: {
  kind: Kind;
  icon: ReactNode;
  title: string;
  fetchEntries: (workspaceId: string) => Promise<Entry[]>;
  emptyHint: string;
  grouped?: boolean;
}) {
  const ws = useWorkspaces();
  const [entries, setEntries] = useState<Entry[]>([]);
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
      .document(ws.workspaceId, kind, selected)
      .then((doc) => live && setText(doc.text))
      .catch(
        (error: unknown) => live && setText(error instanceof Error ? error.message : 'Could not read the document'),
      );
    return () => {
      live = false;
    };
  }, [ws.workspaceId, kind, selected]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(needle));
  }, [entries, query]);
  const groups = useMemo(() => groupByCategory(visible, grouped), [visible, grouped]);
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
            {groups.map((group) => (
              <div key={group.label ?? 'all'} className="gb-group">
                {group.label && <div className="gb-group-head">{group.label}</div>}
                {group.entries.map((entry) => (
                  <button
                    key={entry.name}
                    type="button"
                    className="gb-item"
                    aria-current={entry.name === selected}
                    onClick={() => setSelected(entry.name)}
                  >
                    <span className="gb-item-name">
                      {entry.name}
                      {isWorkflow(entry) && entry.phases.length > 0 && (
                        <Tag tone="quiet">{entry.phases.length} phases</Tag>
                      )}
                      {!isWorkflow(entry) && entry.mutates !== undefined && (
                        <Tag tone="quiet">{entry.mutates ? 'mutates' : 'read-only'}</Tag>
                      )}
                    </span>
                    <span className="gb-item-desc">{entry.description}</span>
                  </button>
                ))}
              </div>
            ))}
            {!visible.length && (
              <div className="gb-empty">
                <IconSearchOutline16 />
                <span>No match</span>
              </div>
            )}
          </nav>
          {current ? <Document kind={kind} entry={current} text={text} /> : <Empty title="Select an entry" />}
        </>
      )}
    </PanelShell>
  );
}

export function SkillsPanel() {
  return (
    <CatalogPanel
      kind="skill"
      icon={<IconSkillOutline16 />}
      title="Skills"
      fetchEntries={api.skills}
      emptyHint="Skills live under skills/<name>/SKILL.md in the repository."
      grouped
    />
  );
}

export function WorkflowsPanel() {
  return (
    <CatalogPanel
      kind="workflow"
      icon={<IconWorkflows16 />}
      title="Workflows"
      fetchEntries={api.workflows}
      emptyHint="Saved workflows live under .claude/workflows/<name>.js in the repository."
    />
  );
}
