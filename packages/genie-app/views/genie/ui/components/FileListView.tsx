import { theme } from '../../../../lib/theme';
import { InlineInput } from './FileDialogs';
import type { FsEntry } from './FileTree';

// ============================================================================
// Helpers
// ============================================================================

const extensionIcons: Record<string, string> = {
  png: '\ud83d\uddbc',
  jpg: '\ud83d\uddbc',
  jpeg: '\ud83d\uddbc',
  gif: '\ud83d\uddbc',
  svg: '\ud83d\uddbc',
  webp: '\ud83d\uddbc',
  mp4: '\ud83c\udfa5',
  mov: '\ud83c\udfa5',
  avi: '\ud83c\udfa5',
  mkv: '\ud83c\udfa5',
  mp3: '\ud83c\udfa7',
  wav: '\ud83c\udfa7',
  flac: '\ud83c\udfa7',
  ts: '\ud83d\udcdc',
  tsx: '\ud83d\udcdc',
  js: '\ud83d\udcdc',
  jsx: '\ud83d\udcdc',
  py: '\ud83d\udc0d',
  rb: '\ud83d\udc0d',
  go: '\ud83d\udc0d',
  rs: '\ud83d\udc0d',
  c: '\ud83d\udcdc',
  cpp: '\ud83d\udcdc',
  h: '\ud83d\udcdc',
  css: '\ud83c\udfa8',
  html: '\ud83c\udfa8',
  json: '\u2699',
  yaml: '\u2699',
  yml: '\u2699',
  toml: '\u2699',
  xml: '\u2699',
  md: '\ud83d\udcdd',
  txt: '\ud83d\udcc4',
  pdf: '\ud83d\udcc4',
  doc: '\ud83d\udcc4',
  docx: '\ud83d\udcc4',
  csv: '\ud83d\udccb',
  xls: '\ud83d\udccb',
  xlsx: '\ud83d\udccb',
  zip: '\ud83d\udce6',
  tar: '\ud83d\udce6',
  gz: '\ud83d\udce6',
  rar: '\ud83d\udce6',
};

export function getFileEmoji(entry: FsEntry): string {
  if (entry.isDirectory) return '\ud83d\udcc1';
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  return extensionIcons[ext] ?? '\ud83d\udcc4';
}

// ============================================================================
// Types
// ============================================================================

export type SortCol = 'name' | 'type';

export interface FileListViewProps {
  entries: FsEntry[];
  selectedNames: Set<string>;
  renamingName: string | null;
  sortCol: SortCol;
  sortDir: 'asc' | 'desc';
  onSort: (col: SortCol) => void;
  onSelect: (name: string, e: React.MouseEvent) => void;
  onNavigate: (entry: FsEntry) => void;
  onPreview: (entry: FsEntry) => void;
  onRenameSubmit: (entry: FsEntry, newName: string) => void;
  onRenameCancel: () => void;
}

// ============================================================================
// FileListView
// ============================================================================

export function FileListView({
  entries,
  selectedNames,
  renamingName,
  sortCol,
  sortDir,
  onSort,
  onSelect,
  onNavigate,
  onPreview,
  onRenameSubmit,
  onRenameCancel,
}: FileListViewProps) {
  const th = {
    padding: '6px 12px',
    textAlign: 'left' as const,
    fontSize: '11px',
    fontWeight: 600,
    color: theme.textMuted,
    borderBottom: `1px solid ${theme.border}`,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    userSelect: 'none' as const,
  };

  const sortArrow = (col: SortCol) => (sortCol === col ? (sortDir === 'asc' ? ' \u2191' : ' \u2193') : '');

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
      <thead style={{ position: 'sticky', top: 0, backgroundColor: theme.bg, zIndex: 2 }}>
        <tr>
          <th
            style={th}
            onClick={() => onSort('name')}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSort('name')}
          >
            Name{sortArrow('name')}
          </th>
          <th style={{ ...th, width: '80px', textAlign: 'right' }}>Size</th>
          <th
            style={{ ...th, width: '80px' }}
            onClick={() => onSort('type')}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSort('type')}
          >
            Type{sortArrow('type')}
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const isSelected = selectedNames.has(entry.name);
          const isRenaming = renamingName === entry.name;
          const emoji = getFileEmoji(entry);
          const ext = entry.isDirectory ? 'folder' : (entry.name.split('.').pop()?.toUpperCase() ?? 'FILE');

          return (
            <tr
              key={entry.name}
              style={{
                borderBottom: `1px solid ${theme.border}22`,
                backgroundColor: isSelected ? `${theme.violet}22` : 'transparent',
                cursor: 'default',
                transition: 'background-color 0.1s ease',
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(entry.name, e);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (entry.isDirectory) onNavigate(entry);
                  else onPreview(entry);
                }
              }}
              onDoubleClick={() => {
                if (entry.isDirectory) onNavigate(entry);
                else onPreview(entry);
              }}
            >
              <td
                style={{
                  padding: '5px 12px',
                  maxWidth: 0,
                  width: '100%',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: theme.text }}>
                  <span style={{ fontSize: '14px', flexShrink: 0 }}>{emoji}</span>
                  {isRenaming ? (
                    <InlineInput
                      initialValue={entry.name}
                      onSubmit={(newName) => onRenameSubmit(entry, newName)}
                      onCancel={onRenameCancel}
                    />
                  ) : (
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: entry.isDirectory ? theme.blue : theme.text,
                        fontWeight: entry.isDirectory ? 500 : 400,
                      }}
                    >
                      {entry.name}
                    </span>
                  )}
                </div>
              </td>
              <td
                style={{
                  padding: '5px 12px',
                  textAlign: 'right',
                  width: '80px',
                  color: theme.textDim,
                  fontSize: '12px',
                }}
              >
                --
              </td>
              <td style={{ padding: '5px 12px', width: '80px', color: theme.textMuted, fontSize: '10px' }}>{ext}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ============================================================================
// FileGridView
// ============================================================================

export interface FileGridViewProps {
  entries: FsEntry[];
  selectedNames: Set<string>;
  onSelect: (name: string, e: React.MouseEvent) => void;
  onNavigate: (entry: FsEntry) => void;
  onPreview: (entry: FsEntry) => void;
}

export function FileGridView({ entries, selectedNames, onSelect, onNavigate, onPreview }: FileGridViewProps) {
  return (
    <div
      style={{
        display: 'grid',
        gap: '8px',
        padding: '12px',
        gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
        alignContent: 'start',
      }}
    >
      {entries.map((entry) => {
        const isSelected = selectedNames.has(entry.name);
        const emoji = getFileEmoji(entry);

        return (
          <button
            key={entry.name}
            type="button"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '4px',
              padding: '8px 4px',
              borderRadius: theme.radiusSm,
              cursor: 'default',
              border: `2px solid ${isSelected ? theme.violet : 'transparent'}`,
              backgroundColor: isSelected ? `${theme.violet}22` : 'transparent',
              transition: 'background-color 0.1s ease, border-color 0.1s ease',
              textAlign: 'center',
              fontFamily: theme.fontFamily,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(entry.name, e);
            }}
            onDoubleClick={() => {
              if (entry.isDirectory) onNavigate(entry);
              else onPreview(entry);
            }}
            onMouseEnter={(e) => {
              if (!isSelected) e.currentTarget.style.backgroundColor = theme.bgCard;
            }}
            onMouseLeave={(e) => {
              if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            <span style={{ fontSize: '24px', lineHeight: '1' }}>{emoji}</span>
            <span
              style={{
                fontSize: '11px',
                color: entry.isDirectory ? theme.blue : theme.textDim,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                width: '100%',
                textAlign: 'center',
              }}
            >
              {entry.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ============================================================================
// FilePreviewPanel
// ============================================================================

function isTextFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const textExts = new Set([
    'md',
    'txt',
    'ts',
    'tsx',
    'js',
    'jsx',
    'py',
    'rb',
    'go',
    'rs',
    'c',
    'cpp',
    'h',
    'css',
    'html',
    'json',
    'yaml',
    'yml',
    'toml',
    'xml',
    'csv',
    'sh',
    'bash',
    'zsh',
    'env',
    'gitignore',
    'editorconfig',
  ]);
  return textExts.has(ext) || name.startsWith('.');
}

export function isPreviewable(name: string): boolean {
  return isTextFile(name);
}

export interface FilePreviewPanelProps {
  entry: FsEntry | null;
  content: string | null;
  loading: boolean;
}

export function FilePreviewPanel({ entry, content, loading }: FilePreviewPanelProps) {
  const panelStyle = {
    width: '320px',
    minWidth: '240px',
    borderLeft: `1px solid ${theme.border}`,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    backgroundColor: theme.bgCard,
  };

  if (!entry) {
    return (
      <div style={panelStyle}>
        <div
          style={{
            padding: '8px 12px',
            borderBottom: `1px solid ${theme.border}`,
            fontSize: '12px',
            fontWeight: 600,
            color: theme.text,
            flexShrink: 0,
          }}
        >
          Preview
        </div>
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '12px',
          }}
        >
          <span style={{ fontSize: '12px', color: theme.textMuted }}>Select a file to preview</span>
        </div>
      </div>
    );
  }

  const emoji = getFileEmoji(entry);

  return (
    <div style={panelStyle}>
      <div
        style={{
          padding: '8px 12px',
          borderBottom: `1px solid ${theme.border}`,
          fontSize: '12px',
          fontWeight: 600,
          color: theme.text,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        <span>{emoji}</span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {entry.name}
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '12px' }}>
        {loading ? (
          <span style={{ fontSize: '12px', color: theme.textMuted }}>Loading...</span>
        ) : content === null ? (
          <span style={{ fontSize: '12px', color: theme.textMuted }}>
            {entry.isDirectory ? 'Directory' : 'Cannot preview this file type'}
          </span>
        ) : (
          <pre
            style={{
              fontSize: '11px',
              fontFamily: theme.fontFamily,
              color: theme.textDim,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
