/**
 * `genie status` — canonical observability surface.
 *
 * Wish: invincible-genie / Group 2.
 *
 * Pure aggregator over `shouldResume()` × N agents + active derived
 * signals + a small fixed health checklist. Three sections, three flags,
 * no SQL forensics.
 *
 * Per Decision #7, this command never duplicates resume logic — every
 * decision routes through `shouldResume()`. Per Decision #11, every
 * derived signal it renders has a documented consumer (this file) and a
 * documented action threshold (the rule that emits it).
 */

import { collectObservabilityHealth } from '../genie-commands/observability-health.js';
import { auditAgentKind } from '../lib/agent-registry.js';
import { listAgentsForRender } from '../lib/agent-registry.js';
import {
  type DerivedSignal,
  SIGNAL_DRILLDOWN,
  detectPartitionMissing,
  listActiveDerivedSignals,
} from '../lib/derived-signals/index.js';
import { recordDerivedSignal } from '../lib/derived-signals/index.js';
import { getExecutor } from '../lib/executor-registry.js';
import { BOOT_PASS_CONCURRENCY_CAP, type ShouldResumeResult, shouldResume } from '../lib/should-resume.js';
import { formatRelativeTimestamp } from '../lib/term-format.js';

export interface StatusOptions {
  health?: boolean;
  all?: boolean;
  debug?: boolean;
  json?: boolean;
}

interface AgentStatusLine {
  agentId: string;
  name: string;
  kind: 'permanent' | 'task' | null;
  decision: ShouldResumeResult;
  /** Live executor session UUID prefix (8 chars) when present. */
  sessionPreview: string | null;
  /** ISO timestamp of last executor write, when known. */
  lastWriteAt: string | null;
}

interface HealthCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'unknown';
  message?: string;
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
} as const;

function colorize(text: string, color: keyof typeof ANSI): string {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

/**
 * Run `shouldResume` over every non-archived agent with bounded
 * concurrency. Mirrors the boot-pass cap so `genie status` and the
 * scheduler share scaling characteristics.
 */
async function aggregateAgentDecisions(includeArchived: boolean): Promise<AgentStatusLine[]> {
  // Render path: dedupe bare-name shadow rows so each agent is reported once
  // with the live signals from its UUID-keyed peer (see agent-registry).
  const agents = await listAgentsForRender({ includeArchived });
  const results: AgentStatusLine[] = new Array(agents.length);
  let cursor = 0;

  const cap = Math.min(BOOT_PASS_CONCURRENCY_CAP, Math.max(1, agents.length));
  const workers = Array.from({ length: cap }, async () => {
    while (cursor < agents.length) {
      const i = cursor++;
      if (i >= agents.length) return;
      const a = agents[i];
      const decision = await shouldResume(a.id).catch(
        (): ShouldResumeResult => ({ resume: false, reason: 'no_session_id', rehydrate: 'lazy' }),
      );
      const name = a.customName ?? a.role ?? a.id;
      const sessionPreview = decision.sessionId ? decision.sessionId.slice(0, 8) : null;
      let lastWriteAt: string | null = null;
      if (a.currentExecutorId) {
        const exec = await getExecutor(a.currentExecutorId).catch(() => null);
        lastWriteAt = exec?.updatedAt ?? exec?.startedAt ?? null;
      }
      results[i] = {
        agentId: a.id,
        name,
        kind: a.kind ?? null,
        decision,
        sessionPreview,
        lastWriteAt,
      };
    }
  });
  await Promise.all(workers);
  return results;
}

/** The fixed four-item health checklist. */
async function collectHealthChecks(): Promise<HealthCheck[]> {
  const report = await collectObservabilityHealth();
  return [
    {
      name: 'partition',
      status: report.partition_health,
      message: report.next_rotation_at ? `next rotation: ${report.next_rotation_at}` : undefined,
    },
    { name: 'watchdog', status: report.watchdog, message: report.watchdog_detail },
    {
      name: 'spill journal',
      status: report.spill_journal === 'pending' ? 'warn' : report.spill_journal === 'unknown' ? 'unknown' : 'ok',
      message: report.spill_path,
    },
    {
      name: 'watcher metrics',
      status: report.watcher_metrics,
      message: report.watcher_metrics === 'ok' ? 'all six recently seen' : 'one or more meta-events missing',
    },
  ];
}

function statusIcon(status: HealthCheck['status']): string {
  switch (status) {
    case 'ok':
      return colorize('✓', 'green');
    case 'warn':
      return colorize('!', 'yellow');
    case 'fail':
      return colorize('✗', 'red');
    default:
      return colorize('?', 'dim');
  }
}

function severityBadge(sev: DerivedSignal['severity']): string {
  if (sev === 'critical') return colorize('[CRITICAL]', 'red');
  if (sev === 'warn') return colorize('[WARN]', 'yellow');
  return colorize('[INFO]', 'dim');
}

function formatAgentLine(line: AgentStatusLine): string {
  const kindTag = line.kind === 'permanent' ? colorize('p', 'magenta') : colorize('t', 'cyan');
  const session = line.sessionPreview ? colorize(line.sessionPreview, 'dim') : colorize('no-session', 'yellow');
  const lastWrite = line.lastWriteAt ? formatRelativeTimestamp(line.lastWriteAt) : '-';
  const reason =
    line.decision.reason === 'ok' ? colorize('resume ready', 'green') : colorize(line.decision.reason, 'yellow');
  return `  [${kindTag}] ${line.name.padEnd(28).slice(0, 28)} ${session.padEnd(8)} last:${lastWrite.padEnd(10)} ${reason}`;
}

function renderResumableSection(lines: AgentStatusLine[]): void {
  const resumable = lines.filter((l) => l.decision.resume);
  if (resumable.length === 0) {
    console.log(colorize('  (no in-flight agents — every prior anchor is closed or paused)', 'dim'));
    return;
  }
  for (const line of resumable) console.log(formatAgentLine(line));
}

function renderStuckSection(lines: AgentStatusLine[]): void {
  const stuck = lines.filter(
    (l) => !l.decision.resume && l.decision.reason !== 'assignment_closed' && l.decision.reason !== 'unknown_agent',
  );
  if (stuck.length === 0) return;
  console.log('');
  console.log(colorize('STUCK / NEEDS ATTENTION', 'bold'));
  console.log('-'.repeat(60));
  for (const line of stuck) {
    console.log(formatAgentLine(line));
    if (line.decision.reason === 'auto_resume_disabled') {
      console.log(colorize(`     → genie agent resume ${line.name}`, 'dim'));
    } else if (line.decision.reason === 'no_session_id') {
      console.log(colorize(`     → genie agent show ${line.name}   # inspect; consider archive`, 'dim'));
    }
  }
}

function renderArchivedSection(lines: AgentStatusLine[]): void {
  const done = lines.filter((l) => l.decision.reason === 'assignment_closed');
  if (done.length === 0) return;
  console.log('');
  console.log(colorize('DONE / ARCHIVED', 'bold'));
  console.log('-'.repeat(60));
  for (const line of done) console.log(formatAgentLine(line));
}

function renderSignalsSection(signals: DerivedSignal[]): void {
  if (signals.length === 0) {
    console.log(colorize('  (no active alerts)', 'dim'));
    return;
  }
  for (const sig of signals) {
    console.log(`  ${severityBadge(sig.severity)} ${colorize(sig.type, 'bold')} on ${sig.subject}`);
    const drilldown = SIGNAL_DRILLDOWN[sig.type];
    if (drilldown) console.log(colorize(`     → ${drilldown}`, 'dim'));
    if (sig.triggeredAt) console.log(colorize(`     ${formatRelativeTimestamp(sig.triggeredAt)}`, 'dim'));
  }
}

function renderHealthSection(checks: HealthCheck[]): void {
  for (const check of checks) {
    const detail = check.message ? colorize(`    ${check.message}`, 'dim') : '';
    console.log(`  ${statusIcon(check.status)} ${check.name.padEnd(18)} ${detail}`);
  }
}

async function renderDebugSection(): Promise<void> {
  const audit = await auditAgentKind();
  console.log('');
  console.log(colorize('DEBUG — kind audit', 'bold'));
  console.log('-'.repeat(60));
  console.log(`  rows scanned: ${audit.total}`);
  console.log(`  drift count : ${audit.drifted.length}`);
  if (audit.drifted.length > 0) {
    for (const d of audit.drifted.slice(0, 10)) {
      console.log(colorize(`    drift: ${d.id}  stored=${d.kind ?? 'null'} expected=${d.expected}`, 'yellow'));
    }
  }
}

interface StatusReport {
  agents: AgentStatusLine[];
  signals: DerivedSignal[];
  health?: HealthCheck[];
}

/**
 * Build the structured report (used by `--json` and the human renderer).
 * Pure assembly — no console writes.
 */
async function buildReport(opts: StatusOptions): Promise<StatusReport> {
  const includeArchived = opts.all === true;
  const [agents, signals] = await Promise.all([aggregateAgentDecisions(includeArchived), listActiveDerivedSignals()]);

  // The partition signal is polled on-demand because the underlying
  // state isn't in the audit stream; merge it in once per call.
  const partitionSignal = await detectPartitionMissing().catch(() => null);
  if (partitionSignal) {
    // Persist for downstream consumers (TUI alert badge, follow-up runs).
    // Best-effort; the merged signal still renders even if the write fails.
    await recordDerivedSignal(partitionSignal).catch(() => {});
    signals.unshift(partitionSignal);
  }

  const report: StatusReport = { agents, signals };
  if (opts.health) report.health = await collectHealthChecks();
  return report;
}

/**
 * Entry point — `genie status [--health|--all|--debug|--json]`.
 */
export async function statusCommand(opts: StatusOptions = {}): Promise<void> {
  const t0 = Date.now();
  const report = await buildReport(opts);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('');
  console.log(colorize('IN-FLIGHT — should resume', 'bold'));
  console.log('-'.repeat(60));
  renderResumableSection(report.agents);

  renderStuckSection(report.agents);

  if (opts.all) renderArchivedSection(report.agents);

  console.log('');
  console.log(colorize('ACTIVE SIGNALS', 'bold'));
  console.log('-'.repeat(60));
  renderSignalsSection(report.signals);

  if (report.health) {
    console.log('');
    console.log(colorize('HEALTH', 'bold'));
    console.log('-'.repeat(60));
    renderHealthSection(report.health);
  }

  if (opts.debug) await renderDebugSection();

  console.log('');
  console.log(
    colorize(
      `  rendered in ${Date.now() - t0}ms — ${report.agents.length} agents, ${report.signals.length} signals`,
      'dim',
    ),
  );
  console.log('');
}
