/** @jsxImportSource @opentui/react */
/** System stats footer — version, CPU, RAM, load */

import os from 'node:os';
import { useEffect, useRef, useState } from 'react';
import si from 'systeminformation';
import { VERSION } from '../../lib/version.js';
import { palette } from '../theme.js';

interface CpuStats {
  combined: number;
  hotCores: { id: number; load: number }[];
  coreCount: number;
}

interface MemStats {
  usedGB: number;
  totalGB: number;
  percent: number;
}

interface LoadStats {
  percent: number;
  busy: number;
  total: number;
}

interface SystemInfo {
  cpu: CpuStats;
  ram: MemStats;
  swap: MemStats;
  load: LoadStats;
}

function toGB(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

/** Safe ASCII progress bar: [===-----] */
function bar(percent: number, width: number): string {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  return `[${'='.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

/**
 * Color thresholds (calibrated 2026-04-26): >90 = error, >70 = warning,
 * else accent. Tuned away from the prior `>50/>80` band so a normal
 * multitasked dev box renders mint instead of permanent traffic-light amber.
 */
export function pickColor(percent: number): string {
  if (percent > 90) return palette.error;
  if (percent > 70) return palette.warning;
  return palette.accent;
}

/**
 * Pure presentational view — accepts a fully-formed `SystemInfo` (or null
 * for the pre-data placeholder) and renders. No data fetching, no timers.
 * Exported so the visual snapshot harness can render it with deterministic
 * fixtures at 10 / 50 / 85 / 95 % CPU without booting `systeminformation`.
 */
export function SystemStatsView({ stats }: { stats: SystemInfo | null }) {
  if (!stats) {
    return (
      <box flexDirection="column" paddingX={1} backgroundColor={palette.bgRaised}>
        <box height={1} width="100%">
          <text>
            <span fg={palette.accent}>genie</span>
            <span fg={palette.textDim}>{` v${VERSION}`}</span>
          </text>
        </box>
      </box>
    );
  }

  const { cpu, ram, swap, load } = stats;
  const hotStr = cpu.hotCores.map((c) => `#${c.id} ${c.load}%`).join('  ');

  return (
    <box flexDirection="column" paddingX={1} backgroundColor={palette.bgRaised}>
      <box height={1} width="100%">
        <text>
          <span fg={palette.accent}>genie</span>
          <span fg={palette.textDim}>{` v${VERSION}`}</span>
        </text>
      </box>
      <box height={1} width="100%">
        <text>
          <span fg={palette.textMuted}>CPU </span>
          <span fg={pickColor(cpu.combined)}>{`${String(cpu.combined).padStart(3)}% ${bar(cpu.combined, 8)}`}</span>
          <span fg={palette.textDim}>{` ${cpu.coreCount}c`}</span>
        </text>
      </box>
      <box height={1} width="100%">
        <text>
          <span fg={palette.textMuted}> hot </span>
          <span fg={palette.warning}>{hotStr}</span>
        </text>
      </box>
      <box height={1} width="100%">
        <text>
          <span fg={palette.textMuted}>RAM </span>
          <span fg={pickColor(ram.percent)}>{`${ram.usedGB}/${ram.totalGB}G ${bar(ram.percent, 8)}`}</span>
        </text>
      </box>
      {swap.totalGB > 0 ? (
        <box height={1} width="100%">
          <text>
            <span fg={palette.textMuted}>SWP </span>
            <span fg={pickColor(swap.percent)}>{`${swap.usedGB}/${swap.totalGB}G ${bar(swap.percent, 8)}`}</span>
          </text>
        </box>
      ) : null}
      <box height={1} width="100%">
        <text>
          <span fg={palette.textMuted}>Load </span>
          <span fg={pickColor(load.percent)}>{`${load.percent}%`}</span>
          <span fg={palette.textDim}>{` (${load.busy}/${load.total} busy)`}</span>
        </text>
      </box>
    </box>
  );
}

export function SystemStats() {
  const [stats, setStats] = useState<SystemInfo | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    async function refresh() {
      try {
        const [cpu, mem] = await Promise.all([si.currentLoad(), si.mem()]);
        if (!mountedRef.current) return;

        const coreCount = os.cpus().length;
        const avg1 = os.loadavg()[0];

        // Top 3 busiest cores
        const sorted = cpu.cpus.map((c, i) => ({ id: i, load: Math.round(c.load) })).sort((a, b) => b.load - a.load);

        setStats({
          cpu: {
            combined: Math.round(cpu.currentLoad),
            hotCores: sorted.slice(0, 3),
            coreCount,
          },
          ram: {
            usedGB: toGB(mem.active),
            totalGB: toGB(mem.total),
            percent: mem.total > 0 ? Math.round((mem.active / mem.total) * 100) : 0,
          },
          swap: {
            usedGB: toGB(mem.swapused),
            totalGB: toGB(mem.swaptotal),
            percent: mem.swaptotal > 0 ? Math.round((mem.swapused / mem.swaptotal) * 100) : 0,
          },
          load: {
            percent: coreCount > 0 ? Math.round((avg1 / coreCount) * 100) : 0,
            busy: Math.round(avg1 * 10) / 10,
            total: coreCount,
          },
        });
      } catch {
        // best-effort
      }
    }

    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, []);

  return <SystemStatsView stats={stats} />;
}

export type { SystemInfo };
