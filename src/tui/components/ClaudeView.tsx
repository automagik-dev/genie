/** @jsxImportSource @opentui/react */
/** Executor list — renders executor metadata from DB with gap detection */

import { useMemo } from 'react';
import type { DiagnosticGaps } from '../diagnostics.js';
import { palette } from '../theme.js';
import type { TuiAssignment, TuiExecutor } from '../types.js';

interface ClaudeViewProps {
  executors: TuiExecutor[];
  assignments: TuiAssignment[];
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

const STATE_COLORS: Record<string, string> = {
  working: palette.emerald,
  idle: palette.textDim,
  running: palette.cyan,
  spawning: palette.warning,
  permission: palette.warning,
  question: palette.warning,
  error: palette.error,
};

function stateColor(state: string): string {
  return STATE_COLORS[state] ?? palette.textMuted;
}

function executorToRows(exec: TuiExecutor, assignments: TuiAssignment[], isDead: boolean): FlatClaudeRow[] {
  const displayName = exec.agentName ? `${exec.agentName}${exec.team ? `@${exec.team}` : ''}` : exec.agentId;
  const roleLabel = exec.role ? ` (${exec.role})` : '';

  const rows: FlatClaudeRow[] = [
    {
      id: `exec:${exec.id}`,
      depth: 0,
      label: `${displayName}${roleLabel}`,
      color: isDead ? palette.error : stateColor(exec.state),
      detail: isDead ? `DEAD pid:${exec.pid}` : `${exec.state} ${exec.provider}`,
      detailColor: isDead ? palette.error : palette.textMuted,
      isOrphan: isDead,
    },
    {
      id: `meta:${exec.id}`,
      depth: 1,
      label: exec.tmuxPaneId
        ? `${exec.tmuxSession ?? '?'}:${exec.tmuxPaneId}`
        : exec.transport === 'api'
          ? 'api (no tmux)'
          : 'tmux: not linked',
      color: exec.tmuxPaneId ? palette.emerald : exec.transport === 'api' ? palette.textDim : palette.error,
      detail: exec.pid != null ? `pid:${exec.pid}` : '',
      detailColor: palette.textMuted,
      isOrphan: !exec.tmuxPaneId && exec.transport !== 'api',
    },
  ];

  // Show active assignment if any
  const activeAssignment = assignments.find((a) => a.executorId === exec.id);
  if (activeAssignment) {
    const taskLabel = activeAssignment.taskTitle ?? activeAssignment.taskId ?? 'unknown';
    const wishLabel = activeAssignment.wishSlug ? ` [${activeAssignment.wishSlug}]` : '';
    rows.push({
      id: `assign:${exec.id}`,
      depth: 1,
      label: `\u2192 ${taskLabel}${wishLabel}`,
      color: palette.purple,
      detail: activeAssignment.groupNumber != null ? `grp:${activeAssignment.groupNumber}` : '',
      detailColor: palette.textMuted,
      isOrphan: false,
    });
  }

  return rows;
}

function flattenExecutors(
  executors: TuiExecutor[],
  assignments: TuiAssignment[],
  gaps: DiagnosticGaps,
): FlatClaudeRow[] {
  const deadIds = new Set(gaps.deadPidExecutors.map((e) => e.id));
  const rows: FlatClaudeRow[] = executors.flatMap((exec) => executorToRows(exec, assignments, deadIds.has(exec.id)));

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

export function ClaudeView({ executors, assignments, gaps, selectedIndex }: ClaudeViewProps) {
  const rows = useMemo(() => flattenExecutors(executors, assignments, gaps), [executors, assignments, gaps]);

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Gap summary */}
      <box height={1} paddingX={1} backgroundColor={palette.bgLighter}>
        <text>
          <span fg={palette.emerald}>{gaps.linkedCount} linked</span>
          {gaps.deadPidExecutors.length > 0 ? (
            <span fg={palette.error}> {gaps.deadPidExecutors.length} dead</span>
          ) : null}
          {gaps.orphanPanes.length > 0 ? <span fg={palette.warning}> {gaps.orphanPanes.length} unmapped</span> : null}
        </text>
      </box>

      {/* Executor list */}
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
export function getClaudeRowCount(
  executors: TuiExecutor[],
  assignments: TuiAssignment[],
  gaps: DiagnosticGaps,
): number {
  let count = 0;
  for (const exec of executors) {
    count += 2; // executor + meta line
    if (assignments.some((a) => a.executorId === exec.id)) count++; // assignment line
  }
  if (gaps.orphanPanes.length > 0) {
    count += 1 + gaps.orphanPanes.length;
  }
  return count;
}
