/** @jsxImportSource @opentui/react */
/** Claude Code process list with PID linking and gap detection */

import { useMemo } from 'react';
import type { DiagnosticGaps, LinkedProcess } from '../diagnostics.js';
import { palette } from '../theme.js';

interface ClaudeViewProps {
  processes: LinkedProcess[];
  gaps: DiagnosticGaps;
  selectedIndex: number;
}

interface FlatClaudeRow {
  id: string;
  depth: number;
  label: string;
  color: string;
  detail: string;
  detailColor: string;
  isOrphan: boolean;
}

function processToRows(proc: LinkedProcess, isOrphan: boolean): FlatClaudeRow[] {
  const displayName = proc.agentName
    ? `${proc.agentName}${proc.teamName ? `@${proc.teamName}` : ''}`
    : `pid:${proc.pid}`;
  const typeLabel = proc.agentType ? ` (${proc.agentType})` : '';

  const main: FlatClaudeRow = {
    id: `proc:${proc.pid}`,
    depth: 0,
    label: `${displayName}${typeLabel}`,
    color: isOrphan ? palette.error : palette.cyan,
    detail: `pid:${proc.pid}`,
    detailColor: palette.textMuted,
    isOrphan,
  };

  const tmux: FlatClaudeRow = proc.tmuxLocation
    ? {
        id: `tmux:${proc.pid}`,
        depth: 1,
        label: `tmux: ${proc.tmuxLocation}`,
        color: palette.emerald,
        detail: proc.tmuxPane ? `[${proc.tmuxPane.title}]` : '',
        detailColor: palette.textDim,
        isOrphan: false,
      }
    : {
        id: `tmux:${proc.pid}`,
        depth: 1,
        label: 'tmux: not linked',
        color: palette.error,
        detail: `ppid:${proc.ppid}`,
        detailColor: palette.textMuted,
        isOrphan: true,
      };

  return [main, tmux];
}

function flattenProcesses(processes: LinkedProcess[], gaps: DiagnosticGaps): FlatClaudeRow[] {
  const orphanPids = new Set(gaps.orphanProcesses.map((p) => p.pid));
  const rows: FlatClaudeRow[] = processes.flatMap((proc) => processToRows(proc, orphanPids.has(proc.pid)));

  if (gaps.orphanPanes.length > 0) {
    rows.push({
      id: 'orphan-header',
      depth: 0,
      label: `\u2500\u2500 Orphan Panes (${gaps.orphanPanes.length}) \u2500\u2500`,
      color: palette.warning,
      detail: '',
      detailColor: palette.textMuted,
      isOrphan: false,
    });
    for (const pane of gaps.orphanPanes) {
      rows.push({
        id: `orphan:${pane.paneId}`,
        depth: 1,
        label: `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`,
        color: palette.error,
        detail: `pid:${pane.pid} [${pane.title}]`,
        detailColor: palette.textMuted,
        isOrphan: true,
      });
    }
  }

  return rows;
}

export function ClaudeView({ processes, gaps, selectedIndex }: ClaudeViewProps) {
  const rows = useMemo(() => flattenProcesses(processes, gaps), [processes, gaps]);

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Gap summary */}
      <box height={1} paddingX={1} backgroundColor={palette.bgLighter}>
        <text>
          <span fg={palette.emerald}>{gaps.linkedCount} linked</span>
          {gaps.orphanProcesses.length > 0 ? (
            <span fg={palette.error}> {gaps.orphanProcesses.length} orphan</span>
          ) : null}
          {gaps.orphanPanes.length > 0 ? <span fg={palette.warning}> {gaps.orphanPanes.length} unmapped</span> : null}
        </text>
      </box>

      {/* Process list */}
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
          const icon = row.depth === 0 ? (row.isOrphan ? '\u2718' : '\u2713') : '\u2514'; // ✘ ✓ └
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
export function getClaudeRowCount(processes: LinkedProcess[], gaps: DiagnosticGaps): number {
  let count = processes.length * 2; // each process + its tmux link line
  if (gaps.orphanPanes.length > 0) {
    count += 1 + gaps.orphanPanes.length; // header + orphan panes
  }
  return count;
}
