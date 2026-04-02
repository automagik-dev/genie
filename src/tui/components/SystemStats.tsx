/** @jsxImportSource @opentui/react */
/** System stats footer — version, CPU, RAM, swap, load average */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import { useEffect, useRef, useState } from 'react';
import { VERSION } from '../../lib/version.js';
import { palette } from '../theme.js';

interface SystemInfo {
  cpuPercent: number;
  ramUsedGB: number;
  ramTotalGB: number;
  swapUsedGB: number;
  swapTotalGB: number;
  loadAvg: [number, number, number];
}

function getCpuTimes(): { idle: number; total: number } {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function getSwapInfo(): { total: number; used: number } {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf-8');
    const totalMatch = meminfo.match(/SwapTotal:\s+(\d+)/);
    const freeMatch = meminfo.match(/SwapFree:\s+(\d+)/);
    const total = totalMatch ? Number.parseInt(totalMatch[1], 10) * 1024 : 0;
    const free = freeMatch ? Number.parseInt(freeMatch[1], 10) * 1024 : 0;
    return { total, used: total - free };
  } catch {
    return { total: 0, used: 0 };
  }
}

function toGB(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

function bar(percent: number, width: number): string {
  const filled = Math.round((percent / 100) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

export function SystemStats() {
  const [stats, setStats] = useState<SystemInfo | null>(null);
  const prevCpu = useRef(getCpuTimes());

  useEffect(() => {
    function refresh() {
      const now = getCpuTimes();
      const prev = prevCpu.current;
      const idleDelta = now.idle - prev.idle;
      const totalDelta = now.total - prev.total;
      const cpuPercent = totalDelta > 0 ? Math.round(((totalDelta - idleDelta) / totalDelta) * 100) : 0;
      prevCpu.current = now;

      const ramTotal = os.totalmem();
      const ramFree = os.freemem();
      const swap = getSwapInfo();
      const load = os.loadavg();

      setStats({
        cpuPercent,
        ramUsedGB: toGB(ramTotal - ramFree),
        ramTotalGB: toGB(ramTotal),
        swapUsedGB: toGB(swap.used),
        swapTotalGB: toGB(swap.total),
        loadAvg: [Math.round(load[0] * 10) / 10, Math.round(load[1] * 10) / 10, Math.round(load[2] * 10) / 10],
      });
    }

    // Short delay for initial CPU delta to be meaningful
    const init = setTimeout(refresh, 500);
    const timer = setInterval(refresh, 3000);
    return () => {
      clearTimeout(init);
      clearInterval(timer);
    };
  }, []);

  if (!stats) return null;

  const BAR_W = 8;
  const ramPct = stats.ramTotalGB > 0 ? Math.round((stats.ramUsedGB / stats.ramTotalGB) * 100) : 0;
  const swpPct = stats.swapTotalGB > 0 ? Math.round((stats.swapUsedGB / stats.swapTotalGB) * 100) : 0;

  const cpuClr = stats.cpuPercent > 80 ? palette.error : stats.cpuPercent > 50 ? palette.warning : palette.emerald;
  const ramClr = ramPct > 80 ? palette.error : ramPct > 50 ? palette.warning : palette.emerald;
  const swpClr = swpPct > 50 ? palette.warning : palette.textDim;

  return (
    <box flexDirection="column" paddingX={1} backgroundColor={palette.bgLight}>
      {/* Version */}
      <text>
        <span fg={palette.purple}>genie</span>
        <span fg={palette.textDim}> v{VERSION}</span>
      </text>
      {/* CPU */}
      <text>
        <span fg={palette.textMuted}>CPU </span>
        <span fg={cpuClr}>{String(stats.cpuPercent).padStart(3)}%</span>
        <span fg={cpuClr}> {bar(stats.cpuPercent, BAR_W)}</span>
      </text>
      {/* RAM */}
      <text>
        <span fg={palette.textMuted}>RAM </span>
        <span fg={ramClr}>
          {stats.ramUsedGB}/{stats.ramTotalGB}G
        </span>
        <span fg={ramClr}> {bar(ramPct, BAR_W)}</span>
      </text>
      {/* Swap (only if swap exists) */}
      {stats.swapTotalGB > 0 ? (
        <text>
          <span fg={palette.textMuted}>SWP </span>
          <span fg={swpClr}>
            {stats.swapUsedGB}/{stats.swapTotalGB}G
          </span>
          <span fg={swpClr}> {bar(swpPct, BAR_W)}</span>
        </text>
      ) : null}
      {/* Load average */}
      <text>
        <span fg={palette.textMuted}>Load </span>
        <span fg={palette.textDim}>{stats.loadAvg.join(' ')}</span>
      </text>
    </box>
  );
}
