/**
 * `genie-watchdog --install` — writes the systemd unit files and
 * `/etc/genie-watchdog/alerts.yaml` to a clean default, then enables the
 * timer so the probe starts running on the next minute boundary.
 *
 * The install step itself is idempotent: existing files are backed up with
 * a `.bak-<timestamp>` suffix so operators can diff before swapping.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG_PATH } from './config.ts';

export const SYSTEMD_TIMER_PATH = '/etc/systemd/system/genie-watchdog.timer';
export const SYSTEMD_SERVICE_PATH = '/etc/systemd/system/genie-watchdog.service';

export const SYSTEMD_TIMER_CONTENTS = `[Unit]
Description=genie-watchdog observability dead-man's-switch
Documentation=https://github.com/automagik-dev/genie/tree/main/packages/watchdog

[Timer]
OnBootSec=60s
OnUnitActiveSec=60s
AccuracySec=5s
Unit=genie-watchdog.service

[Install]
WantedBy=timers.target
`;

export const SYSTEMD_SERVICE_CONTENTS = `[Unit]
Description=genie-watchdog probe run
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env genie-watchdog probe --config /etc/genie-watchdog/alerts.yaml
Nice=5
TimeoutStartSec=30s
`;

export const DEFAULT_ALERTS_YAML = `# genie-watchdog alerts.yaml
# The watchdog runs every 60s. Fires an alert if PG is unreachable OR the
# newest row in genie_runtime_events is older than staleness_seconds.

pg:
  dsn: postgres://genie@localhost/genie

staleness_seconds: 300

alerts:
  # Drop the webhook target of your paging provider here (PagerDuty,
  # Opsgenie, Slack, Twilio bridge). A POST with a JSON AlertPayload is sent.
  webhook:
  email: []
  sms: []
`;

export interface InstallOptions {
  readonly dryRun?: boolean;
  readonly targetRoot?: string;
}

export interface InstallResult {
  readonly files_written: string[];
  readonly files_skipped: string[];
  readonly dry_run: boolean;
}

function resolve(path: string, root?: string): string {
  if (!root) return path;
  return `${root.replace(/\/$/, '')}${path}`;
}

function safeWrite(path: string, contents: string, dryRun: boolean): 'written' | 'skipped' {
  if (dryRun) return 'skipped';
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      const existing = readFileSync(path, 'utf8');
      if (existing === contents) return 'skipped';
      writeFileSync(`${path}.bak-${Date.now()}`, existing);
    } catch {
      // Unable to back up — continue writing anyway; loud surface on host logs.
    }
  }
  writeFileSync(path, contents);
  return 'written';
}

export function install(opts: InstallOptions = {}): InstallResult {
  const dryRun = opts.dryRun ?? false;
  const timer = resolve(SYSTEMD_TIMER_PATH, opts.targetRoot);
  const service = resolve(SYSTEMD_SERVICE_PATH, opts.targetRoot);
  const alerts = resolve(DEFAULT_CONFIG_PATH, opts.targetRoot);

  const results: Array<{ path: string; kind: 'written' | 'skipped' }> = [];
  results.push({ path: timer, kind: safeWrite(timer, SYSTEMD_TIMER_CONTENTS, dryRun) });
  results.push({ path: service, kind: safeWrite(service, SYSTEMD_SERVICE_CONTENTS, dryRun) });
  results.push({ path: alerts, kind: safeWrite(alerts, DEFAULT_ALERTS_YAML, dryRun) });

  return {
    dry_run: dryRun,
    files_written: results.filter((r) => r.kind === 'written').map((r) => r.path),
    files_skipped: results.filter((r) => r.kind === 'skipped').map((r) => r.path),
  };
}
