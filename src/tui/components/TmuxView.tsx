/** @jsxImportSource @opentui/react */
/** tmux inventory: sessions > windows > panes with PID and command info */

import { useMemo } from 'react';
import type { TmuxPane, TmuxSession } from '../diagnostics.js';
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
  windowIndex?: number;
  /** Whether pane is running claude */
  isClaude: boolean;
  /** Whether pane has exited */
  isDead: boolean;
}

function toPaneRow(pane: TmuxPane, sessionName: string, windowIndex: number): FlatTmuxRow {
  const isClaude = pane.command === 'claude' || pane.title.includes('claude');
  const color = pane.isDead ? palette.error : isClaude ? palette.cyan : palette.text;
  const stateIcon = pane.isDead ? '\u2718' : isClaude ? '\u25c6' : '\u25cb'; // ✘ ◆ ○
  const cmdLabel = pane.command === 'claude' ? 'claude' : pane.command === 'bun' ? 'bun' : pane.command;
  return {
    id: `p:${pane.paneId}`,
    depth: 2,
    label: pane.isDead ? `${stateIcon} dead` : `${stateIcon} ${cmdLabel}`,
    color,
    detail: isClaude ? `pid:${pane.pid}` : `pid:${pane.pid} ${pane.size}`,
    detailColor: palette.textMuted,
    type: 'pane',
    sessionName,
    windowIndex,
    isClaude,
    isDead: pane.isDead,
  };
}

function flattenSessions(sessions: TmuxSession[]): FlatTmuxRow[] {
  return sessions.flatMap((session) => {
    const sessionIcon = session.attached ? '\u25b6' : '\u25b8'; // ▶ ▸
    const sessionRow: FlatTmuxRow = {
      id: `s:${session.name}`,
      depth: 0,
      label: `${sessionIcon} ${session.name}`,
      color: session.attached ? palette.emerald : palette.text,
      detail: session.attached ? 'attached' : `${session.windowCount}w`,
      detailColor: session.attached ? palette.emerald : palette.textMuted,
      type: 'session',
      sessionName: session.name,
      isClaude: false,
      isDead: false,
    };
    const windowRows = session.windows.flatMap((window) => {
      const deadInWindow = window.panes.filter((p) => p.isDead).length;
      const winIcon = window.active ? '\u25a0' : '\u25a1'; // ■ □
      const winRow: FlatTmuxRow = {
        id: `w:${session.name}:${window.index}`,
        depth: 1,
        label: `${winIcon} ${window.name}`,
        color: window.active ? palette.cyan : palette.text,
        detail: `${window.paneCount}p${deadInWindow > 0 ? ` ${deadInWindow}\u2620` : ''}`,
        detailColor: window.active ? palette.cyan : palette.textMuted,
        type: 'window',
        sessionName: session.name,
        windowIndex: window.index,
        isClaude: false,
        isDead: false,
      };
      const paneRows: FlatTmuxRow[] = window.panes.map((pane) => toPaneRow(pane, session.name, window.index));
      return [winRow, ...paneRows];
    });
    return [sessionRow, ...windowRows];
  });
}

export function TmuxView({ sessions, selectedIndex }: TmuxViewProps) {
  const rows = useMemo(() => flattenSessions(sessions), [sessions]);

  const totalPanes = sessions.reduce((sum, s) => sum + s.windows.reduce((ws, w) => ws + w.panes.length, 0), 0);
  const deadPanes = sessions.reduce(
    (sum, s) => sum + s.windows.reduce((ws, w) => ws + w.panes.filter((p) => p.isDead).length, 0),
    0,
  );

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Summary */}
      <box height={1} paddingX={1} backgroundColor={palette.bgLighter}>
        <text>
          <span fg={palette.textDim}>
            {sessions.length}s {sessions.reduce((s, x) => s + x.windowCount, 0)}w {totalPanes}p
          </span>
          {deadPanes > 0 ? <span fg={palette.error}> {deadPanes} dead</span> : null}
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
          const indent = row.depth === 1 ? '  ' : row.depth === 2 ? '    ' : '';
          const selected = i === selectedIndex;

          return (
            <box key={row.id} height={1} width="100%" backgroundColor={selected ? palette.violet : undefined}>
              <text>
                <span fg={palette.textMuted}>{indent}</span>
                <span fg={row.color}>{row.label}</span>
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

/** Look up session target for a given row index (for Enter key navigation). */
export function getTmuxRowTarget(
  sessions: TmuxSession[],
  index: number,
): { sessionName: string; windowIndex?: number } | null {
  const rows = flattenSessions(sessions);
  const row = rows[index];
  if (!row) return null;
  return { sessionName: row.sessionName, windowIndex: row.windowIndex };
}
