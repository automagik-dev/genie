# @automagik/genie-watchdog

External dead-man's switch for genie's structured observability stream.

This package runs every 60 seconds via systemd timer (or any cron-style runner).
Each run connects to PG, reads the freshness of `genie_runtime_events`, and
fires an alert if the stream has gone silent for more than 300 seconds (default)
or if PG itself is unreachable.

## Design constraints

- **Standalone.** No imports from `@automagik/genie`, no shared PG pool. The
  isolation test (`test/isolation.test.ts`) enforces this structurally.
- **Minimal deps.** Only `postgres` is permitted in the runtime dependency set.
- **Oneshot service.** Each probe is a short-lived process. No long-lived state.
- **Config by file.** YAML at `/etc/genie-watchdog/alerts.yaml` (or JSON if the
  file starts with `{`).

## Install

```bash
bun run src/cli.ts install
systemctl enable --now genie-watchdog.timer
```

## Manual probe

```bash
bun run src/cli.ts probe --config /etc/genie-watchdog/alerts.yaml --json
```

Exit code 0 on success, 2 on alert, >64 on usage error.

## Alerts

The probe emits JSON to stderr with prefix `genie-watchdog ALERT`. Pipe the
systemd journal into your log aggregator and alert on that prefix; or wire a
webhook under `alerts.webhook` in the YAML for direct fan-out to PagerDuty,
Opsgenie, Slack, or a Twilio bridge.

## Related

- `/etc/systemd/system/genie-watchdog.timer`
- `/etc/systemd/system/genie-watchdog.service`
- Wish: `.genie/wishes/genie-serve-structured-observability/WISH.md` (Group 6)
