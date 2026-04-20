/**
 * @automagik/genie-watchdog — external dead-man's switch.
 *
 * This package is INTENTIONALLY standalone: no imports from the `@automagik/genie`
 * source tree, no shared PG pool, its own `postgres` client dependency. The
 * thing watching the watcher must not depend on the thing being watched.
 *
 * The probe runs every 60s (via systemd timer, or any cron-style runner):
 *   SELECT extract(epoch from (now() - max(created_at))) FROM genie_runtime_events;
 *
 * If the probe can't connect to PG, or the result is greater than the
 * configured staleness threshold (default 300s), we fire an alert via the
 * configured escalation channels (SMS/email/webhook).
 *
 * Deliberately minimal — each probe is a short-lived process invocation so
 * there is no long-lived state to corrupt. Configuration is read from a
 * YAML file (`/etc/genie-watchdog/alerts.yaml` by default).
 */

export { runProbe, type ProbeResult, type WatchdogConfig } from './probe.ts';
export { loadConfig, DEFAULT_CONFIG_PATH } from './config.ts';
export { formatAlert, dispatchAlert, type AlertPayload } from './alert.ts';
