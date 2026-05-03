/**
 * `genie agent observe <name>` — single-agent observability detail.
 *
 * Wish 3/5 (agent-observability-snapshot) Group 2.
 *
 * Sections (human mode):
 *   - identity (id, name, role, team, kind)
 *   - executor (state, provider, transport, pid, tmux pane, started/updated)
 *   - session (id, status, total turns, link source)
 *   - recent activity (last 24h tools / errors / cost / tokens)
 *   - health flags
 *
 * JSON mode emits the canonical snapshot shape from `agent-observability.ts`
 * with a `_source` debug key (schema version + view name) so callers can
 * detect drift between the CLI surface and the underlying view.
 *
 * Exit codes:
 *   0 — agent healthy
 *   1 — agent degraded (only when `--strict` is requested)
 *   2 — agent not found OR underlying dependency missing
 */

import type { Command } from 'commander';
import {
  AGENT_OBSERVABILITY_SCHEMA_VERSION,
  type AgentObservabilitySnapshot,
  type HealthFlag,
  getAgentObservability,
} from '../../lib/agent-observability.js';
import { color, formatRelativeTimestamp, padRight } from '../../lib/term-format.js';

interface ObserveOptions {
  json?: boolean;
  strict?: boolean;
}

const FLAG_LABELS: Record<HealthFlag, string> = {
  stale_executor: 'stale executor (no recent heartbeat)',
  missing_session: 'missing session linkage',
  missing_attribution: 'missing attribution (no name/role)',
  high_hook_latency: 'high hook latency',
  recent_failure: 'tool error in last 24h',
  cost_spike: 'cost spike (>= threshold)',
};

function row(label: string, value: string | number | null): void {
  if (value == null || value === '') return;
  console.log(`  ${padRight(`${label}:`, 22)} ${value}`);
}

function fmtTime(ts: string | null): string | null {
  if (!ts) return null;
  return `${formatRelativeTimestamp(ts)} (${ts})`;
}

function renderHuman(snap: AgentObservabilitySnapshot): void {
  console.log('');
  console.log(color('bold', `AGENT: ${snap.customName ?? snap.role ?? snap.agentId}`));
  console.log('-'.repeat(72));

  console.log(color('cyan', 'identity'));
  row('id', snap.agentId);
  row('custom name', snap.customName);
  row('role', snap.role);
  row('team', snap.team);
  row('kind', snap.kind);
  row('classification', snap.classification);

  console.log('');
  console.log(color('cyan', 'executor'));
  if (!snap.executorId) {
    console.log(color('dim', '  (no current executor)'));
  } else {
    row('id', snap.executorId);
    row('state', snap.executorState);
    row('provider', snap.executorProvider);
    row('transport', snap.executorTransport);
    row('pid', snap.executorPid);
    row('tmux pane', snap.executorTmuxPane);
    row('tmux session', snap.executorTmuxSession);
    row('started', fmtTime(snap.executorStartedAt));
    row('updated', fmtTime(snap.executorUpdatedAt));
    row('ended', fmtTime(snap.executorEndedAt));
    row('claude session', snap.claudeSessionId);
  }

  console.log('');
  console.log(color('cyan', 'session'));
  if (!snap.sessionId) {
    console.log(color('dim', '  (no linked session)'));
  } else {
    row('id', snap.sessionId);
    row('status', snap.sessionStatus);
    row('display', snap.sessionDisplayName);
    row('total turns', snap.sessionTotalTurns);
    row('started', fmtTime(snap.sessionStartedAt));
    row('link source', snap.sessionLinkSource);
  }

  console.log('');
  console.log(color('cyan', 'recent activity (24h)'));
  row('tool events', snap.recentToolCount);
  row('errors', snap.recentErrorCount);
  row('last tool', fmtTime(snap.recentLastToolAt));
  row('cost (USD)', snap.recentCostUsd > 0 ? `$${snap.recentCostUsd.toFixed(4)}` : '$0');
  row('input tokens', snap.recentInputTokens);
  row('output tokens', snap.recentOutputTokens);

  console.log('');
  console.log(color('cyan', 'health'));
  if (snap.health.flags.length === 0) {
    console.log(color('green', '  ✓ no flags raised'));
  } else {
    for (const flag of snap.health.flags) {
      console.log(`  ${color('yellow', '!')} ${flag.padEnd(22)} — ${FLAG_LABELS[flag]}`);
    }
  }

  console.log('');
  console.log(color('dim', `  schema v${AGENT_OBSERVABILITY_SCHEMA_VERSION} via v_agent_observability`));
  console.log('');
}

export async function observeAgent(name: string, options: ObserveOptions): Promise<void> {
  const snap = await getAgentObservability(name);
  if (!snap) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'agent_not_found', identifier: name }, null, 2));
    } else {
      console.error(`Agent "${name}" not found.`);
    }
    process.exit(2);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          _source: { schemaVersion: AGENT_OBSERVABILITY_SCHEMA_VERSION, view: 'v_agent_observability' },
          agent: snap,
        },
        null,
        2,
      ),
    );
  } else {
    renderHuman(snap);
  }

  if (options.strict && snap.health.degraded) {
    process.exit(1);
  }
}

export function registerAgentObserve(parent: Command): void {
  parent
    .command('observe <name>')
    .description('Canonical observability snapshot for one agent (id, name, or role)')
    .option('--json', 'Emit machine-readable JSON')
    .option('--strict', 'Exit with code 1 when any health flag is raised')
    .action(async (name: string, options: ObserveOptions) => {
      try {
        await observeAgent(name, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`observe: ${message}`);
        process.exit(2);
      }
    });
}
