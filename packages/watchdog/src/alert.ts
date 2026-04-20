/**
 * Alert routing — formats a probe failure into a structured payload and
 * dispatches it through the configured channels.
 *
 * Dispatch itself is intentionally a thin shell: we POST JSON at a webhook
 * if configured, and otherwise log to stderr with a recognizable prefix so
 * the host's log aggregator can page. Email/SMS integrations are host-specific
 * and are expected to be wired via the webhook target.
 */

import type { WatchdogConfig } from './config.ts';
import type { ProbeResult } from './probe.ts';

export interface AlertPayload {
  readonly event: 'genie-watchdog.alert';
  readonly severity: 'warn' | 'critical';
  readonly reason: ProbeResult['reason'];
  readonly detail?: string;
  readonly stale_seconds: number | null;
  readonly probed_at: string;
  readonly host: string;
}

export function formatAlert(result: ProbeResult, host: string): AlertPayload {
  const severity: AlertPayload['severity'] =
    result.reason === 'pg_unreachable' || (result.stale_seconds ?? 0) > 600 ? 'critical' : 'warn';
  return {
    event: 'genie-watchdog.alert',
    severity,
    reason: result.reason,
    detail: result.detail,
    stale_seconds: result.stale_seconds,
    probed_at: result.probed_at,
    host,
  };
}

export async function dispatchAlert(payload: AlertPayload, config: WatchdogConfig): Promise<void> {
  const body = JSON.stringify(payload);
  process.stderr.write(`genie-watchdog ALERT ${body}\n`);

  if (config.alerts.webhook) {
    try {
      await fetch(config.alerts.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      process.stderr.write(`genie-watchdog webhook failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Email/SMS are deployment-specific — operators wire them through the
  // webhook target (PagerDuty, Opsgenie, Twilio bridge, sendgrid, etc.).
  // We still echo the addresses into the log so the operator can confirm
  // routing intent during install.
  if (config.alerts.email && config.alerts.email.length > 0) {
    process.stderr.write(`genie-watchdog alert-email-targets: ${config.alerts.email.join(',')}\n`);
  }
  if (config.alerts.sms && config.alerts.sms.length > 0) {
    process.stderr.write(`genie-watchdog alert-sms-targets: ${config.alerts.sms.join(',')}\n`);
  }
}
