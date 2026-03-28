/** @jsxImportSource @opentui/react */
/** tmux inventory: sessions > windows > panes with PID and command info */

import { useMemo } from 'react';
import type { TmuxSession } from '../diagnostics.js';
import { palette } from '../theme.js';

interface TmuxViewProps {
  sessions: TmuxSession[];
  selectedIndex: number;
}

interface FlatTmuxRow {
  id: string;
  depth: number;
  label: string;
  color: string;
  detail: string;
  detailColor: string;
  type: 'session' | 'window' | 'pane';
  sessionName: string;
  /** Whether pane is running claude */
  isClaude: boolean;
}

function flattenSessions(sessions: TmuxSession[]): FlatTmuxRow[] {
  const rows: FlatTmuxRow[] = [];

  for (const session of sessions) {
    rows.push({
      id: `s:${session.name}`,
      depth: 0,
      label: session.name,
      color: session.attached ? palette.emerald : palette.textDim,
      detail: `${session.windowCount}w ${session.attached ? '(attached)' : ''}`,
      detailColor: session.attached ? palette.emerald : palette.textMuted,
      type: 'session',
      sessionName: session.name,
      isClaude: false,
    });

    for (const window of session.windows) {
      rows.push({
        id: `w:${session.name}:${window.index}`,
        depth: 1,
        label: `${window.index}:${window.name}`,
        color: window.active ? palette.cyan : palette.text,
        detail: `${window.paneCount}p${window.active ? ' *' : ''}`,
        detailColor: window.active ? palette.cyan : palette.textMuted,
        type: 'window',
        sessionName: session.name,
        isClaude: false,
      });

      for (const pane of window.panes) {
        const isClaude = pane.command === 'claude' || pane.title.includes('claude');
        rows.push({
          id: `p:${pane.paneId}`,
          depth: 2,
          label: `${pane.paneId} [${pane.command}]`,
          color: isClaude ? palette.cyan : palette.textDim,
          detail: `pid:${pane.pid} ${pane.size}`,
          detailColor: palette.textMuted,
          type: 'pane',
          sessionName: session.name,
          isClaude,
        });
      }
    }
  }

  return rows;
}

export function TmuxView({ sessions, selectedIndex }: TmuxViewProps) {
  const rows = useMemo(() => flattenSessions(sessions), [sessions]);

  const totalPanes = sessions.reduce((sum, s) => sum + s.windows.reduce((ws, w) => ws + w.panes.length, 0), 0);

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Summary */}
      <box height={1} paddingX={1} backgroundColor={palette.bgLighter}>
        <text>
          <span fg={palette.textDim}>
            {sessions.length}s {sessions.reduce((s, x) => s + x.windowCount, 0)}w {totalPanes}p
          </span>
        </text>
      </box>

      {/* Tree */}
      <scrollbox
        focused
        height="100%"
        style={{
          scrollbarOptions: {
            showArrows: false,
            trackOptions: {
              foregroundColor: palette.scrollThumb,
              backgroundColor: palette.scrollTrack,
            },
          },
        }}
      >
        {rows.map((row, i) => {
          const indent = '  '.repeat(row.depth);
          const icon = row.type === 'session' ? '\u25c8' : row.type === 'window' ? '\u25a1' : '\u2500'; // ◈ □ ─
          const selected = i === selectedIndex;

          return (
            <box key={row.id} height={1} width="100%" backgroundColor={selected ? palette.violet : undefined}>
              <text>
                <span fg={palette.textMuted}>{indent}</span>
                <span fg={row.color}>
                  {icon} {row.label}
                </span>
                <span fg={row.detailColor}> {row.detail}</span>
              </text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}

/** Get the total number of flat rows for keyboard navigation. */
export function getTmuxRowCount(sessions: TmuxSession[]): number {
  let count = 0;
  for (const s of sessions) {
    count++; // session
    for (const w of s.windows) {
      count++; // window
      count += w.panes.length; // panes
    }
  }
  return count;
}
