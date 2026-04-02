/** @jsxImportSource @opentui/react */
/** System stats footer — version, CPU (with per-core heatmap), RAM, swap, load */

import os from 'node:os';
import { useEffect, useRef, useState } from 'react';
import si from 'systeminformation';
import { VERSION } from '../../lib/version.js';
import { palette } from '../theme.js';

interface SystemInfo {
  cpu: { combined: number; cores: number[] };
  ram: { activeGB: number; totalGB: number; percent: number };
  swap: { usedGB: number; totalGB: number; percent: number };
  load: { avg1: number; percent: number; coreCount: number };
}

function toGB(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

function bar(percent: number, width: number): string {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

/** Map a 0-100 load to a colored single-char block for the core heatmap. */
function coreChar(load: number): { ch: string; fg: string } {
  if (load > 80) return { ch: '\u2588', fg: palette.error };
  if (load > 50) return { ch: '\u2593', fg: palette.warning };
  if (load > 20) return { ch: '\u2592', fg: palette.emerald };
  return { ch: '\u2591', fg: palette.textMuted };
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

        setStats({
          cpu: {
            combined: Math.round(cpu.currentLoad),
            cores: cpu.cpus.map((c) => Math.round(c.load)),
          },
          ram: {
            activeGB: toGB(mem.active),
            totalGB: toGB(mem.total),
            percent: mem.total > 0 ? Math.round((mem.active / mem.total) * 100) : 0,
          },
          swap: {
            usedGB: toGB(mem.swapused),
            totalGB: toGB(mem.swaptotal),
            percent: mem.swaptotal > 0 ? Math.round((mem.swapused / mem.swaptotal) * 100) : 0,
          },
          load: {
            avg1: Math.round(avg1 * 10) / 10,
            percent: coreCount > 0 ? Math.round((avg1 / coreCount) * 100) : 0,
            coreCount,
          },
        });
      } catch {
        // best-effort — don't crash the TUI
      }
    }

    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, []);

  if (!stats) {
    return (
      <box paddingX={1} backgroundColor={palette.bgLight}>
        <text>
          <span fg={palette.purple}>genie</span>
          <span fg={palette.textDim}> v{VERSION}</span>
        </text>
      </box>
    );
  }

  const BAR_W = 8;
  const { cpu, ram, swap, load } = stats;

  const cpuClr = cpu.combined > 80 ? palette.error : cpu.combined > 50 ? palette.warning : palette.emerald;
  const ramClr = ram.percent > 80 ? palette.error : ram.percent > 50 ? palette.warning : palette.emerald;
  const swpClr = swap.percent > 50 ? palette.warning : palette.textDim;
  const loadClr = load.percent > 80 ? palette.error : load.percent > 50 ? palette.warning : palette.emerald;

  // Build per-core heatmap rows (fit sidebar width ~24 chars)
  // Each cell carries its absolute core index for a stable React key.
  const COLS = 21;
  const coreRows: { ch: string; fg: string; id: number }[][] = [];
  for (let i = 0; i < cpu.cores.length; i += COLS) {
    coreRows.push(cpu.cores.slice(i, i + COLS).map((load, ci) => ({ ...coreChar(load), id: i + ci })));
  }

  return (
    <box flexDirection="column" paddingX={1} backgroundColor={palette.bgLight}>
      {/* Version */}
      <text>
        <span fg={palette.purple}>genie</span>
        <span fg={palette.textDim}> v{VERSION}</span>
      </text>
      {/* CPU combined */}
      <text>
        <span fg={palette.textMuted}>CPU </span>
        <span fg={cpuClr}>
          {String(cpu.combined).padStart(3)}% {bar(cpu.combined, BAR_W)}
        </span>
        <span fg={palette.textDim}> {load.coreCount}c</span>
      </text>
      {/* Per-core heatmap (always visible — compact) */}
      {coreRows.map((row) => (
        <text key={`cr-${row[0].id}`}>
          <span fg={palette.textMuted}>{'    '}</span>
          {row.map((cell) => (
            <span key={`c${cell.id}`} fg={cell.fg}>
              {cell.ch}
            </span>
          ))}
        </text>
      ))}
      {/* RAM — uses "active" memory (excludes buffers/cache) */}
      <text>
        <span fg={palette.textMuted}>RAM </span>
        <span fg={ramClr}>
          {ram.activeGB}/{ram.totalGB}G {bar(ram.percent, BAR_W)}
        </span>
      </text>
      {/* Swap (only if swap exists) */}
      {swap.totalGB > 0 ? (
        <text>
          <span fg={palette.textMuted}>SWP </span>
          <span fg={swpClr}>
            {swap.usedGB}/{swap.totalGB}G {bar(swap.percent, BAR_W)}
          </span>
        </text>
      ) : null}
      {/* Load — humanized as % of cores */}
      <text>
        <span fg={palette.textMuted}>Load </span>
        <span fg={loadClr}>{load.percent}%</span>
        <span fg={palette.textDim}>
          {' '}
          ({load.avg1}/{load.coreCount} cores)
        </span>
      </text>
    </box>
  );
}
