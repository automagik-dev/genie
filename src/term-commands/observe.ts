/**
 * `genie observe agents` — fleet-level observability snapshot.
 *
 * Wish 3/5 (agent-observability-snapshot) Group 2.
 *
 * Reads the canonical `v_agent_observability` view via
 * `src/lib/agent-observability.ts` so this command, `genie agent observe`,
 * `genie status`, the TUI, and the app all converge on one truth.
 *
 * Exit codes:
 *   0 — fleet healthy (no rows or every row passed health checks)
 *   1 — at least one degraded row, only when `--strict` is requested
 *   2 — caller blocked by missing dependency (DB unavailable)
 */

import type { Command } from 'commander';
import {
  AGENT_OBSERVABILITY_SCHEMA_VERSION,
  type AgentObservabilitySnapshot,
  type HealthFlag,
  listAgentObservability,
} from '../lib/agent-observability.js';
import { color, formatRelativeTimestamp, padRight, truncate } from '../lib/term-format.js';

interface ObserveAgentsOptions {
  json?: boolean;
  includeHarness?: boolean;
  strict?: boolean;
  limit?: string;
}

const FLAG_LABELS: Record<HealthFlag, string> = {
  stale_executor: 'STALE',
  missing_session: 'NO-SESSION',
  missing_attribution: 'UNATTRIBUTED',
  high_hook_latency: 'SLOW-HOOK',
  recent_failure: 'TOOL-ERR',
  cost_spike: 'COST',
};

function summarize(snap: AgentObservabilitySnapshot): string {
  const name = snap.customName ?? snap.role ?? snap.agentId;
  const namePart = padRight(truncate(name, 28), 28);
  const exec = snap.executorState ?? '-';
  const execPart = padRight(truncate(exec, 12), 12);
  const tools = `${snap.recentToolCount} tools / ${snap.recentErrorCount} err`;
  const cost = snap.recentCostUsd > 0 ? `$${snap.recentCostUsd.toFixed(2)}` : '$0';
  const last = snap.recentLastToolAt ? formatRelativeTimestamp(snap.recentLastToolAt) : '-';
  const health =
    snap.health.flags.length === 0
      ? color('green', 'OK')
      : color('yellow', snap.health.flags.map((f) => FLAG_LABELS[f]).join(','));
  return `  ${namePart} ${execPart} ${padRight(tools, 18)} ${padRight(cost, 8)} last:${padRight(last, 9)} ${health}`;
}

function renderHumanFleet(snaps: AgentObservabilitySnapshot[], includeHarness: boolean): void {
  console.log('');
  const heading = includeHarness ? 'AGENTS + HARNESS' : 'AGENTS';
  console.log(color('bold', heading));
  console.log('-'.repeat(72));
  if (snaps.length === 0) {
    console.log(color('dim', '  (none)'));
    console.log('');
    return;
  }
  for (const snap of snaps) {
    console.log(summarize(snap));
  }
  const degraded = snaps.filter((s) => s.health.degraded).length;
  console.log('');
  console.log(
    color('dim', `  ${snaps.length} rows, ${degraded} degraded — schema v${AGENT_OBSERVABILITY_SCHEMA_VERSION}`),
  );
  console.log('');
}

export async function observeAgentsCommand(opts: ObserveAgentsOptions = {}): Promise<void> {
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
  const snaps = await listAgentObservability({
    includeHarness: opts.includeHarness === true,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  if (opts.json) {
    const payload = {
      _source: { schemaVersion: AGENT_OBSERVABILITY_SCHEMA_VERSION, view: 'v_agent_observability' },
      agents: snaps,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    renderHumanFleet(snaps, opts.includeHarness === true);
  }

  if (opts.strict && snaps.some((s) => s.health.degraded)) {
    process.exit(1);
  }
}

export function registerObserveCommands(program: Command): void {
  const observe = program.command('observe').description('Canonical observability snapshots');

  observe
    .command('agents')
    .description('Fleet-level agent observability snapshot')
    .option('--json', 'Emit machine-readable JSON')
    .option('--include-harness', 'Include rows whose classification is `harness`')
    .option('--strict', 'Exit with code 1 when any row is degraded')
    .option('--limit <n>', 'Maximum rows to return')
    .action(async (options: ObserveAgentsOptions) => {
      try {
        await observeAgentsCommand(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`observe: ${message}`);
        process.exit(2);
      }
    });

  observe.on('command:*', (operands: string[]) => {
    const cmd = operands[0];
    const available = observe.commands.map((c) => c.name()).join(', ');
    observe.error(`Unknown observe command '${cmd}'. Available: ${available}`);
  });
}
