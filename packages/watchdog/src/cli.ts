#!/usr/bin/env bun
/**
 * genie-watchdog CLI — invoked by the systemd timer (or a manual cron).
 *
 * Subcommands:
 *   probe   — run one probe cycle, dispatch alert on failure.
 *   install — write systemd units + default alerts.yaml.
 *   status  — print resolved config + last probe result to stdout.
 */

import { hostname } from 'node:os';
import { dispatchAlert, formatAlert } from './alert.ts';
import { DEFAULT_CONFIG_PATH, loadConfig } from './config.ts';
import { install } from './install.ts';
import { runProbe } from './probe.ts';

async function main(argv: string[]): Promise<number> {
  const [, , cmd = 'probe', ...rest] = argv;
  const args = parseArgs(rest);
  const configPath = args.config ?? DEFAULT_CONFIG_PATH;

  if (cmd === 'install') {
    const dryRun = args['dry-run'] === 'true' || 'dry-run' in args;
    const result = install({ dryRun });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (cmd === 'probe') {
    const config = loadConfig(configPath);
    const result = await runProbe(config);
    if (args.json === 'true' || 'json' in args) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      const status = result.ok ? 'OK' : 'ALERT';
      process.stdout.write(
        `genie-watchdog probe ${status} reason=${result.reason} stale=${result.stale_seconds ?? 'n/a'}s\n`,
      );
    }
    if (!result.ok) {
      const payload = formatAlert(result, hostname());
      await dispatchAlert(payload, config);
      return 2;
    }
    return 0;
  }

  if (cmd === 'status') {
    const config = loadConfig(configPath);
    process.stdout.write(`${JSON.stringify({ config, host: hostname() }, null, 2)}\n`);
    return 0;
  }

  process.stderr.write(
    `unknown subcommand: ${cmd}\nusage: genie-watchdog <probe|install|status> [--config path] [--json]\n`,
  );
  return 64;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[token.slice(2)] = next;
        i++;
      } else {
        out[token.slice(2)] = 'true';
      }
    }
  }
  return out;
}

if (typeof process !== 'undefined' && import.meta.main !== false) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`genie-watchdog fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
