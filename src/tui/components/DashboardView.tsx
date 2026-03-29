/** @jsxImportSource @opentui/react */
/** Dashboard view — KPI cards: agents, tasks, teams, spend */

import { useMemo } from 'react';
import type { DiagnosticGaps } from '../diagnostics.js';
import { palette } from '../theme.js';
import type { Task, TuiExecutor } from '../types.js';

export interface DashboardTeam {
  name: string;
  status: string;
  wishSlug: string | null;
  memberCount: number;
}

interface DashboardViewProps {
  executors: TuiExecutor[];
  gaps: DiagnosticGaps;
  tasks: Task[];
  teams: DashboardTeam[];
  selectedIndex: number;
}

interface KpiCard {
  id: string;
  icon: string;
  label: string;
  value: string;
  color: string;
  detail: string;
  detailColor: string;
}

function buildCards(executors: TuiExecutor[], gaps: DiagnosticGaps, tasks: Task[], teams: DashboardTeam[]): KpiCard[] {
  // Agent KPIs
  const working = executors.filter((e) => e.state === 'working' || e.state === 'spawning').length;
  const idle = executors.filter((e) => e.state === 'idle' || e.state === 'running').length;
  const errored = executors.filter((e) => e.state === 'error').length;
  const waiting = executors.filter((e) => e.state === 'permission' || e.state === 'question').length;

  // Task KPIs
  const active = tasks.filter((t) => t.status === 'in_progress').length;
  const backlog = tasks.filter((t) => t.status === 'ready' || t.status === 'blocked').length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;

  // Team KPIs
  const activeTeams = teams.filter((t) => t.status === 'in_progress').length;
  const blockedTeams = teams.filter((t) => t.status === 'blocked').length;

  const cards: KpiCard[] = [
    // ── Section: Agents ──
    {
      id: 'agents-header',
      icon: '\u25b6', // ▶
      label: 'AGENTS',
      value: `${executors.length}`,
      color: palette.purple,
      detail: `${gaps.linkedCount} linked`,
      detailColor: palette.emerald,
    },
    {
      id: 'agents-working',
      icon: '\u25cf', // ●
      label: 'Working',
      value: `${working}`,
      color: palette.emerald,
      detail: working > 0 ? 'active' : '',
      detailColor: palette.textMuted,
    },
    {
      id: 'agents-idle',
      icon: '\u25cb', // ○
      label: 'Idle',
      value: `${idle}`,
      color: palette.textDim,
      detail: '',
      detailColor: palette.textMuted,
    },
    {
      id: 'agents-waiting',
      icon: '\u25cc', // ◌
      label: 'Waiting',
      value: `${waiting}`,
      color: waiting > 0 ? palette.warning : palette.textMuted,
      detail: waiting > 0 ? 'needs input' : '',
      detailColor: palette.warning,
    },
    {
      id: 'agents-error',
      icon: '\u2718', // ✘
      label: 'Errored',
      value: `${errored}`,
      color: errored > 0 ? palette.error : palette.textMuted,
      detail: gaps.deadPidExecutors.length > 0 ? `${gaps.deadPidExecutors.length} dead` : '',
      detailColor: palette.error,
    },

    // ── Separator ──
    { id: 'sep-1', icon: '', label: '', value: '', color: '', detail: '', detailColor: '' },

    // ── Section: Tasks ──
    {
      id: 'tasks-header',
      icon: '\u2261', // ≡
      label: 'TASKS',
      value: `${tasks.length}`,
      color: palette.purple,
      detail: `${active} in flight`,
      detailColor: palette.cyan,
    },
    {
      id: 'tasks-active',
      icon: '\u25cf', // ●
      label: 'Active',
      value: `${active}`,
      color: palette.cyan,
      detail: '',
      detailColor: palette.textMuted,
    },
    {
      id: 'tasks-backlog',
      icon: '\u25cb', // ○
      label: 'Backlog',
      value: `${backlog}`,
      color: palette.textDim,
      detail: '',
      detailColor: palette.textMuted,
    },
    {
      id: 'tasks-done',
      icon: '\u2713', // ✓
      label: 'Done',
      value: `${done}`,
      color: palette.emerald,
      detail: tasks.length > 0 ? `${Math.round((done / tasks.length) * 100)}%` : '',
      detailColor: palette.emerald,
    },
    {
      id: 'tasks-failed',
      icon: '\u2718', // ✘
      label: 'Failed',
      value: `${failed}`,
      color: failed > 0 ? palette.error : palette.textMuted,
      detail: '',
      detailColor: palette.error,
    },

    // ── Separator ──
    { id: 'sep-2', icon: '', label: '', value: '', color: '', detail: '', detailColor: '' },

    // ── Section: Teams ──
    {
      id: 'teams-header',
      icon: '\u25c6', // ◆
      label: 'TEAMS',
      value: `${teams.length}`,
      color: palette.purple,
      detail: `${activeTeams} active`,
      detailColor: palette.cyan,
    },
    ...teams.map((t) => ({
      id: `team:${t.name}`,
      icon: t.status === 'in_progress' ? '\u25cf' : t.status === 'blocked' ? '\u25cc' : '\u2713', // ● ◌ ✓
      label: t.name,
      value: `${t.memberCount}`,
      color: t.status === 'in_progress' ? palette.cyan : t.status === 'blocked' ? palette.warning : palette.emerald,
      detail: t.wishSlug ?? '',
      detailColor: palette.textMuted,
    })),
    ...(blockedTeams > 0
      ? [
          {
            id: 'teams-blocked',
            icon: '\u26a0', // ⚠
            label: 'Blocked',
            value: `${blockedTeams}`,
            color: palette.warning,
            detail: '',
            detailColor: palette.warning,
          },
        ]
      : []),

    // ── Separator ──
    { id: 'sep-3', icon: '', label: '', value: '', color: '', detail: '', detailColor: '' },

    // ── Section: Spend ──
    {
      id: 'spend-header',
      icon: '$',
      label: 'SPEND',
      value: '\u2014', // —
      color: palette.purple,
      detail: 'coming soon',
      detailColor: palette.textMuted,
    },
  ];

  return cards;
}

export function DashboardView({ executors, gaps, tasks, teams, selectedIndex }: DashboardViewProps) {
  const cards = useMemo(() => buildCards(executors, gaps, tasks, teams), [executors, gaps, tasks, teams]);

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Summary bar */}
      <box height={1} paddingX={1} backgroundColor={palette.bgLighter}>
        <text>
          <span fg={palette.emerald}>{executors.filter((e) => e.state === 'working').length} working</span>
          <span fg={palette.textMuted}> | </span>
          <span fg={palette.cyan}>{tasks.filter((t) => t.status === 'in_progress').length} tasks</span>
          <span fg={palette.textMuted}> | </span>
          <span fg={palette.purple}>{teams.filter((t) => t.status === 'in_progress').length} teams</span>
        </text>
      </box>

      {/* KPI cards */}
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
        {cards.map((card, i) => {
          // Separator row
          if (card.id.startsWith('sep-')) {
            return (
              <box key={card.id} height={1} width="100%">
                <text>
                  <span fg={palette.border}>{'\u2500'.repeat(40)}</span>
                </text>
              </box>
            );
          }

          const selected = i === selectedIndex;
          const isHeader = card.id.endsWith('-header');

          return (
            <box key={card.id} height={1} width="100%" backgroundColor={selected ? palette.violet : undefined}>
              <text>
                {isHeader ? (
                  <>
                    <span fg={card.color}>
                      {card.icon} {card.label}
                    </span>
                    <span fg={palette.text}> {card.value}</span>
                    {card.detail ? <span fg={card.detailColor}> {card.detail}</span> : null}
                  </>
                ) : (
                  <>
                    <span fg={palette.textMuted}> </span>
                    <span fg={card.color}>{card.icon}</span>
                    <span fg={palette.text}> {card.label}</span>
                    <span fg={card.color}> {card.value}</span>
                    {card.detail ? <span fg={card.detailColor}> {card.detail}</span> : null}
                  </>
                )}
              </text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}

/** Get the total number of navigable rows for keyboard navigation. */
export function getDashboardRowCount(
  executors: TuiExecutor[],
  gaps: DiagnosticGaps,
  tasks: Task[],
  teams: DashboardTeam[],
): number {
  return buildCards(executors, gaps, tasks, teams).length;
}
