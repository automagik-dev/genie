/**
 * genie metrics — the operator's switch for opt-in lifecycle capture.
 *
 *   metrics enable    create <GENIE_HOME>/metrics/capture.on (the one switch)
 *   metrics disable   remove the switch; the ledger is kept
 *   metrics status    what is on, where the ledger is, which runtime session this shell is in
 *   metrics export    ledger + task_events + runtime session logs → per-transition time and tokens;
 *                     `--phoenix` projects the intervals to a Phoenix the operator configured
 *
 * Capture is OFF until `enable` runs: a host that never runs it sees no new
 * file, directory, latency or network call. Enabling sends nothing anywhere —
 * the ledger is machine-local metadata (`src/lib/metrics-capture.ts`).
 */

import { chmodSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import {
  type CaptureStatus,
  captureLedgerPath,
  captureStatus,
  disableCapture,
  enableCapture,
} from '../lib/metrics-capture.js';
import {
  buildIntervals,
  formatSummary,
  readCaptureLedger,
  summarize,
  verifyAgainstTaskEvents,
} from '../lib/metrics-export.js';
import {
  type PhoenixExportTarget,
  exportTargetPath,
  loadSavedTarget,
  projectToPhoenix,
  saveTarget,
  validateTarget,
} from '../lib/metrics-phoenix.js';
import { printErr, printOut } from '../lib/term-output.js';

interface ExportOptions {
  since?: string;
  json?: boolean;
  out?: string;
  phoenix?: boolean;
  endpoint?: string;
  project?: string;
  apiKeyEnv?: string;
  save?: boolean;
  verifyTimeout: string;
}

/** `7d`, `12h`, `30m` or an ISO date → epoch ms; undefined → 0 (everything); null when unparseable. */
export function parseSince(value: string | undefined, now = Date.now()): number | null {
  if (value === undefined) return 0;
  const relative = /^(\d+)([dhm])$/.exec(value.trim());
  if (relative) {
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[relative[2] as 'd' | 'h' | 'm'];
    return now - Number(relative[1]) * unit;
  }
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? absolute : null;
}

/** The flags win over the saved target; a half-given target is a usage error, never a guess. */
function resolveExportTarget(options: ExportOptions): PhoenixExportTarget | string | null {
  const flagged = options.endpoint !== undefined || options.project !== undefined || options.apiKeyEnv !== undefined;
  if (!flagged) return loadSavedTarget();
  return validateTarget({ endpoint: options.endpoint, project: options.project, apiKeyEnv: options.apiKeyEnv });
}

const fail = (code: number, message: string): number => {
  printErr(`Error (genie metrics export): ${message}`);
  return code;
};

async function runExport(options: ExportOptions): Promise<number> {
  const since = parseSince(options.since);
  if (since === null) return fail(2, `--since takes 7d, 12h, 30m or an ISO date, not ${options.since}`);
  const timeoutSeconds = Number(options.verifyTimeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) return fail(2, '--verify-timeout takes seconds');
  const target = options.phoenix || options.save ? resolveExportTarget(options) : null;
  if (typeof target === 'string') return fail(2, `the Phoenix target needs ${target}`);
  if ((options.phoenix || options.save) && target === null) {
    return fail(
      2,
      `no Phoenix target configured. Name yours once: genie metrics export --endpoint <url> --project <name> [--api-key-env <VAR>] --save (stored in ${exportTargetPath()}). Nothing was sent.`,
    );
  }
  if (options.save && target) saveTarget(target);

  const ledger = readCaptureLedger(captureLedgerPath(), since);
  const { matched, unmatched } = verifyAgainstTaskEvents(ledger.lines);
  const intervals = buildIntervals(matched);
  const summary = summarize(intervals);
  const stats = { lines: ledger.lines.length, unmatched, corrupt: ledger.corrupt };
  if (options.out) {
    writeFileSync(options.out, intervals.map((i) => `${JSON.stringify(i)}\n`).join(''), { mode: 0o600 });
    chmodSync(options.out, 0o600);
  }
  printOut(
    options.json
      ? JSON.stringify({ ...stats, intervals: intervals.length, summary })
      : formatSummary(summary, stats).trimEnd(),
  );

  if (!options.phoenix || !target) return 0;
  try {
    const result = await projectToPhoenix(target, intervals, { timeoutMs: timeoutSeconds * 1000 });
    printErr(
      `phoenix ${target.project}: ${result.expected} spans expected, ${result.alreadyStored} already stored, ${result.posted} posted, ${result.missing} not yet readable`,
    );
    return result.missing === 0 ? 0 : 1;
  } catch (error) {
    return fail(
      1,
      `Phoenix at ${target.endpoint}: ${error instanceof Error ? error.message : String(error)}. The ledger is unchanged; re-run to resume.`,
    );
  }
}

interface JsonOption {
  json?: boolean;
}

function renderStatus(status: CaptureStatus): string {
  const state = status.enabled ? 'on' : status.disabledByEnv ? 'off (GENIE_METRICS=off in this environment)' : 'off';
  const session = status.session.source
    ? `${status.session.source} ${status.session.id ?? '(no id)'}`
    : 'none detected';
  const ledger = status.ledgerBytes === null ? 'not created' : `${status.ledgerBytes} bytes`;
  return [
    `capture: ${state}`,
    `switch:  ${status.signal}`,
    `ledger:  ${status.ledger} (${ledger})`,
    `session: ${session}`,
  ].join('\n');
}

export function registerMetricsCommand(program: Command): void {
  const metrics = program
    .command('metrics')
    .description('Opt-in lifecycle capture: a machine-local metadata ledger, off until enabled');

  metrics
    .command('enable')
    .description('Turn capture on for this GENIE_HOME (writes the switch; sends nothing anywhere)')
    .action(() => {
      try {
        enableCapture();
      } catch (error) {
        printErr(`Error (genie metrics enable): ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
      printOut(renderStatus(captureStatus()));
    });

  metrics
    .command('disable')
    .description('Turn capture off (removes the switch; the ledger is kept)')
    .action(() => {
      const removed = disableCapture();
      printOut(removed ? 'capture: off' : 'capture: already off');
    });

  metrics
    .command('export')
    .description('Measure time and tokens per lifecycle transition from the ledger; --phoenix sends it to your Phoenix')
    .option('--since <when>', 'Only events from this window: 7d, 12h, 30m or an ISO date')
    .option('--json', 'Emit the summary as JSON')
    .option('--out <file>', 'Also write every interval as JSON lines to this file')
    .option('--phoenix', 'Project the intervals into the configured Phoenix and wait until every span reads back')
    .option('--endpoint <url>', 'Phoenix base URL (with --project; overrides the saved target)')
    .option('--project <name>', 'Phoenix project to write to (dedicate one to genie)')
    .option('--api-key-env <VAR>', 'Name of the env var holding the Phoenix API key (the key is never stored)')
    .option('--save', 'Save --endpoint/--project/--api-key-env as the target for later exports')
    .option('--verify-timeout <seconds>', 'How long --phoenix waits for every span to read back', '120')
    .action(async (options: ExportOptions) => {
      process.exitCode = await runExport(options);
    });

  metrics
    .command('status')
    .description('Show whether capture is on, where the ledger is, and the runtime session of this shell')
    .option('--json', 'Emit the status as JSON')
    .action((options: JsonOption) => {
      const status = captureStatus();
      printOut(options.json ? JSON.stringify(status) : renderStatus(status));
    });
}
