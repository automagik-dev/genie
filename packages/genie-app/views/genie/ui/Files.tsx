import { useNats } from '@khal-os/sdk/app';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GENIE_SUBJECTS } from '../../../lib/subjects';
import { theme } from '../../../lib/theme';
import type { AppComponentProps } from '../../../lib/types';
import { EmptyState } from '../../shared/EmptyState';
import { ErrorState } from '../../shared/ErrorState';
import { LoadingState } from '../../shared/LoadingState';
import { AgentSelector } from './components/AgentSelector';
import type { AgentRow } from './components/AgentSelector';
import { CreateFolderDialog, DeleteDialog } from './components/FileDialogs';
import { FileGridView, FileListView, FilePreviewPanel, isPreviewable } from './components/FileListView';
import type { SortCol } from './components/FileListView';
import { FileTree } from './components/FileTree';
import type { FsEntry } from './components/FileTree';

// ============================================================================
// Types
// ============================================================================

type ViewMode = 'list' | 'grid';
type LoadState = 'loading' | 'ready' | 'error';

interface FsReadResponse {
  content?: string;
  error?: string;
}
interface FsWriteResponse {
  ok?: boolean;
  error?: string;
}

// ============================================================================
// Constants & helpers
// ============================================================================

const ORG_ID = 'default';
const VIEW_MODE_KEY = 'genie-files-view-mode';

function getStoredViewMode(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_KEY);
    if (v === 'grid' || v === 'list') return v;
  } catch {
    /* ignore */
  }
  return 'list';
}

function sortEntries(entries: FsEntry[], col: SortCol, dir: 'asc' | 'desc'): FsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let cmp = 0;
    if (col === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    else {
      const ea = a.name.split('.').pop() ?? '';
      const eb = b.name.split('.').pop() ?? '';
      cmp = ea.localeCompare(eb);
    }
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ============================================================================
// Styles
// ============================================================================

const s = {
  root: {
    display: 'flex',
    height: '100%',
    backgroundColor: theme.bg,
    color: theme.text,
    fontFamily: theme.fontFamily,
    overflow: 'hidden',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 10px',
    borderBottom: `1px solid ${theme.border}`,
    backgroundColor: theme.bgCard,
    flexShrink: 0,
    flexWrap: 'wrap' as const,
  },
  btn: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '3px 7px',
    fontSize: '12px',
    fontFamily: theme.fontFamily,
    backgroundColor: 'transparent',
    color: theme.textDim,
    border: `1px solid ${theme.border}`,
    borderRadius: theme.radiusSm,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
  },
  btnActive: {
    backgroundColor: `${theme.violet}33`,
    color: theme.text,
    borderColor: theme.violet,
  },
  breadcrumb: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flex: 1,
    overflow: 'hidden',
    fontSize: '12px',
  },
  crumbBtn: {
    padding: '2px 5px',
    borderRadius: theme.radiusSm,
    cursor: 'pointer',
    border: 'none',
    backgroundColor: 'transparent',
    fontFamily: theme.fontFamily,
    fontSize: '12px',
    color: theme.textDim,
    whiteSpace: 'nowrap' as const,
  },
  content: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  filePane: {
    flex: 1,
    overflow: 'auto',
    outline: 'none',
  },
  treeSidebar: {
    width: '190px',
    minWidth: '150px',
    flexShrink: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  statusBar: {
    padding: '3px 12px',
    borderTop: `1px solid ${theme.border}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: '11px',
    color: theme.textMuted,
    flexShrink: 0,
    backgroundColor: theme.bgCard,
  },
} as const;

// ============================================================================
// FilesView — Main Export
// ============================================================================

export function FilesView({ windowId }: AppComponentProps) {
  const { request } = useNats();

  // ---- State ----
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [agentsState, setAgentsState] = useState<LoadState>('loading');
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState('');
  const [currentPath, setCurrentPath] = useState('');
  const [pathHistory, setPathHistory] = useState<string[]>([]);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [dirState, setDirState] = useState<LoadState>('loading');
  const [dirError, setDirError] = useState<string | null>(null);
  const [selectedNames, setSelectedNames] = useState<Set<string>>(new Set());
  const lastClickedRef = useRef<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(getStoredViewMode);
  const [showTree, setShowTree] = useState(false);
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [previewEntry, setPreviewEntry] = useState<FsEntry | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sortCol, setSortCol] = useState<SortCol>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const filePaneRef = useRef<HTMLDivElement>(null);

  // ---- Load agents ----
  useEffect(() => {
    let cancelled = false;
    request<AgentRow[]>(GENIE_SUBJECTS.agents.list(ORG_ID))
      .then((data) => {
        if (!cancelled) {
          setAgents(Array.isArray(data) ? data : []);
          setAgentsState('ready');
        }
      })
      .catch(() => {
        if (!cancelled) setAgentsState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  // ---- Load directory ----
  const loadDirectory = useCallback(
    async (path: string) => {
      if (!path) return;
      setDirState('loading');
      setDirError(null);
      try {
        const result = await request<FsEntry[] | { error?: string }>(GENIE_SUBJECTS.fs.list(ORG_ID), { path });
        if (Array.isArray(result)) {
          setEntries(result);
          setDirState('ready');
        } else if (result && typeof result === 'object' && 'error' in result) {
          setDirError(String(result.error ?? 'Unknown error'));
          setDirState('error');
        } else {
          setEntries([]);
          setDirState('ready');
        }
      } catch (err) {
        setDirError(err instanceof Error ? err.message : String(err));
        setDirState('error');
      }
      setSelectedNames(new Set());
      lastClickedRef.current = null;
    },
    [request],
  );

  useEffect(() => {
    if (currentPath) loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  // ---- Agent selection ----
  const handleSelectAgent = useCallback((agentName: string, brainPath: string) => {
    setSelectedAgentName(agentName);
    setRootPath(brainPath);
    setCurrentPath(brainPath);
    setPathHistory([]);
    setPreviewEntry(null);
    setPreviewContent(null);
    setEntries([]);
  }, []);

  // ---- Navigation ----
  const navigateTo = useCallback(
    (path: string) => {
      setPathHistory((prev) => [...prev, currentPath]);
      setCurrentPath(path);
      setPreviewEntry(null);
      setPreviewContent(null);
    },
    [currentPath],
  );

  const goBack = useCallback(() => {
    if (!pathHistory.length) return;
    const prev = pathHistory[pathHistory.length - 1];
    setPathHistory((h) => h.slice(0, -1));
    setCurrentPath(prev);
    setPreviewEntry(null);
    setPreviewContent(null);
  }, [pathHistory]);

  const goUp = useCallback(() => {
    if (!currentPath || currentPath === rootPath) return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    navigateTo(`/${parts.join('/')}` || '/');
  }, [currentPath, rootPath, navigateTo]);

  const handleNavigate = useCallback(
    (entry: FsEntry) => {
      if (entry.isDirectory) navigateTo(entry.path);
    },
    [navigateTo],
  );

  // ---- Breadcrumbs ----
  const breadcrumbs = (() => {
    if (!currentPath || !rootPath) return [];
    const rootParts = rootPath.split('/').filter(Boolean);
    const currParts = currentPath.split('/').filter(Boolean);
    return currParts.slice(rootParts.length - 1).map((seg, i) => ({
      label: seg,
      path: `/${currParts.slice(0, rootParts.length - 1 + i + 1).join('/')}`,
    }));
  })();

  // ---- Selection ----
  const handleSelect = useCallback(
    (name: string, e: React.MouseEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;
      if (shift && lastClickedRef.current) {
        const names = entries.map((en) => en.name);
        const a = names.indexOf(lastClickedRef.current);
        const b = names.indexOf(name);
        if (a !== -1 && b !== -1) {
          const range = names.slice(Math.min(a, b), Math.max(a, b) + 1);
          setSelectedNames((prev) => {
            const next = new Set(prev);
            for (const n of range) next.add(n);
            return next;
          });
        }
      } else if (meta) {
        setSelectedNames((prev) => {
          const next = new Set(prev);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        });
        lastClickedRef.current = name;
      } else {
        setSelectedNames(new Set([name]));
        lastClickedRef.current = name;
      }
    },
    [entries],
  );

  const handleClearSelection = useCallback(() => {
    setSelectedNames(new Set());
    lastClickedRef.current = null;
  }, []);

  // ---- Preview ----
  const handlePreview = useCallback(
    async (entry: FsEntry) => {
      setPreviewEntry(entry);
      if (entry.isDirectory || !isPreviewable(entry.name)) {
        setPreviewContent(null);
        return;
      }
      setPreviewLoading(true);
      setPreviewContent(null);
      try {
        const result = await request<FsReadResponse>(GENIE_SUBJECTS.fs.read(ORG_ID), { path: entry.path });
        setPreviewContent(result?.content ?? null);
      } catch {
        setPreviewContent(null);
      } finally {
        setPreviewLoading(false);
      }
    },
    [request],
  );

  // ---- File operations ----
  const handleRenameSubmit = useCallback(
    async (_entry: FsEntry, _newName: string) => {
      setRenamingName(null);
      await loadDirectory(currentPath);
    },
    [currentPath, loadDirectory],
  );

  const handleDeleteConfirm = useCallback(async () => {
    setPendingDelete(null);
    setSelectedNames(new Set());
    await loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  const handleCreateFolder = useCallback(
    async (name: string) => {
      setShowCreateFolder(false);
      const newPath = `${(currentPath.endsWith('/') ? currentPath : `${currentPath}/`) + name}/.gitkeep`;
      try {
        await request<FsWriteResponse>(GENIE_SUBJECTS.fs.write(ORG_ID), { path: newPath, content: '' });
        await loadDirectory(currentPath);
      } catch (err) {
        console.error('[FilesView] Create folder failed:', err);
      }
    },
    [currentPath, request, loadDirectory],
  );

  // ---- Sort & view mode ----
  const handleSort = useCallback(
    (col: SortCol) => {
      if (sortCol === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setSortCol(col);
        setSortDir('asc');
      }
    },
    [sortCol],
  );

  const handleViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, []);

  // ---- Keyboard ----
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (renamingName) return;
      if (e.key === 'Escape') {
        handleClearSelection();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNames.size > 0) {
        e.preventDefault();
        const names = entries.filter((en) => selectedNames.has(en.name)).map((en) => en.name);
        if (names.length) setPendingDelete(names);
        return;
      }
      if (e.key === 'F2' && selectedNames.size === 1) {
        e.preventDefault();
        setRenamingName([...selectedNames][0]);
        return;
      }
      if (e.key === 'Enter' && selectedNames.size === 1) {
        e.preventDefault();
        const entry = entries.find((en) => en.name === [...selectedNames][0]);
        if (entry) {
          if (entry.isDirectory) handleNavigate(entry);
          else handlePreview(entry);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        setSelectedNames(new Set(entries.map((en) => en.name)));
      }
    },
    [renamingName, selectedNames, entries, handleClearSelection, handleNavigate, handlePreview],
  );

  // ---- Status bar ----
  const statusText = (() => {
    const dc = entries.filter((e) => e.isDirectory).length;
    const fc = entries.length - dc;
    const parts: string[] = [];
    if (dc) parts.push(`${dc} folder${dc !== 1 ? 's' : ''}`);
    if (fc) parts.push(`${fc} file${fc !== 1 ? 's' : ''}`);
    if (!parts.length) return 'Empty';
    if (selectedNames.size) return `${parts.join(', ')} \u00b7 ${selectedNames.size} selected`;
    return parts.join(', ');
  })();

  const sorted = sortEntries(entries, sortCol, sortDir);

  // ---- Render ----
  if (agentsState === 'loading') {
    return (
      <div data-window-id={windowId} style={{ height: '100%' }}>
        <LoadingState message="Loading agents..." />
      </div>
    );
  }

  return (
    <div data-window-id={windowId} style={s.root}>
      <AgentSelector agents={agents} selectedName={selectedAgentName} onSelect={handleSelectAgent} />

      <div style={s.main}>
        {/* Toolbar */}
        <div style={s.toolbar}>
          <button
            type="button"
            style={{ ...s.btn, opacity: pathHistory.length ? 1 : 0.4 }}
            onClick={goBack}
            disabled={!pathHistory.length}
            title="Back"
          >
            \u2190
          </button>
          <button
            type="button"
            style={{ ...s.btn, opacity: currentPath !== rootPath ? 1 : 0.4 }}
            onClick={goUp}
            disabled={currentPath === rootPath}
            title="Up"
          >
            \u2191
          </button>

          <div style={s.breadcrumb}>
            {breadcrumbs.map((seg, i) => (
              <span key={seg.path} style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                {i > 0 && <span style={{ color: theme.textMuted }}>/</span>}
                <button
                  type="button"
                  style={{
                    ...s.crumbBtn,
                    fontWeight: i === breadcrumbs.length - 1 ? 600 : 400,
                    color: i === breadcrumbs.length - 1 ? theme.text : theme.textDim,
                  }}
                  onClick={() => navigateTo(seg.path)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = theme.bgCard;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  {seg.label}
                </button>
              </span>
            ))}
            {!selectedAgentName && (
              <span style={{ fontSize: '12px', color: theme.textMuted, fontStyle: 'italic' }}>Select an agent</span>
            )}
          </div>

          <div style={{ flex: 1 }} />
          <button
            type="button"
            style={{ ...s.btn, ...(viewMode === 'list' ? s.btnActive : {}) }}
            onClick={() => handleViewMode('list')}
            title="List"
          >
            \u2630
          </button>
          <button
            type="button"
            style={{ ...s.btn, ...(viewMode === 'grid' ? s.btnActive : {}) }}
            onClick={() => handleViewMode('grid')}
            title="Grid"
          >
            \u2b1c
          </button>
          <button
            type="button"
            style={{ ...s.btn, ...(showTree ? s.btnActive : {}) }}
            onClick={() => setShowTree((v) => !v)}
            title="Toggle tree"
          >
            \ud83c\udf33
          </button>
          <button type="button" style={s.btn} onClick={() => setShowCreateFolder(true)} disabled={!selectedAgentName}>
            + Folder
          </button>
          <button type="button" style={s.btn} onClick={() => loadDirectory(currentPath)} disabled={!currentPath}>
            \u21bb
          </button>
        </div>

        {/* Content area */}
        <div style={s.content}>
          {showTree && rootPath && (
            <div style={s.treeSidebar}>
              <FileTree
                rootPath={rootPath}
                selectedPath={currentPath}
                onNavigate={(path) => {
                  setPathHistory((prev) => [...prev, currentPath]);
                  setCurrentPath(path);
                }}
              />
            </div>
          )}

          <div
            ref={filePaneRef}
            style={s.filePane}
            onKeyDown={handleKeyDown}
            onClick={handleClearSelection}
            role="toolbar"
          >
            {!selectedAgentName ? (
              <EmptyState
                icon="\ud83e\udde0"
                title="No agent selected"
                description="Select an agent from the left to browse their brain folder."
              />
            ) : dirState === 'loading' ? (
              <LoadingState message="Loading files..." />
            ) : dirState === 'error' ? (
              <ErrorState
                message={dirError ?? 'Failed to load directory'}
                service="genie.fs.list"
                onRetry={() => loadDirectory(currentPath)}
              />
            ) : sorted.length === 0 ? (
              <EmptyState icon="\ud83d\udcc2" title="Empty folder" description="No files here yet." />
            ) : viewMode === 'list' ? (
              <FileListView
                entries={sorted}
                selectedNames={selectedNames}
                renamingName={renamingName}
                sortCol={sortCol}
                sortDir={sortDir}
                onSort={handleSort}
                onSelect={handleSelect}
                onNavigate={handleNavigate}
                onPreview={handlePreview}
                onRenameSubmit={handleRenameSubmit}
                onRenameCancel={() => setRenamingName(null)}
              />
            ) : (
              <FileGridView
                entries={sorted}
                selectedNames={selectedNames}
                onSelect={handleSelect}
                onNavigate={handleNavigate}
                onPreview={handlePreview}
              />
            )}
          </div>

          {previewEntry && <FilePreviewPanel entry={previewEntry} content={previewContent} loading={previewLoading} />}
        </div>

        {/* Status bar */}
        <div style={s.statusBar}>
          <span>{selectedAgentName ? statusText : 'No agent selected'}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '400px' }}>
            {currentPath || ''}
          </span>
        </div>
      </div>

      {/* Dialogs */}
      {pendingDelete && (
        <DeleteDialog names={pendingDelete} onConfirm={handleDeleteConfirm} onCancel={() => setPendingDelete(null)} />
      )}
      {showCreateFolder && (
        <CreateFolderDialog onConfirm={handleCreateFolder} onCancel={() => setShowCreateFolder(false)} />
      )}
    </div>
  );
}
