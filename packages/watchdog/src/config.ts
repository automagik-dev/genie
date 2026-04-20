/**
 * Watchdog configuration loader — tolerant of missing/partial files so an
 * operator never ends up with a non-running probe because of a typo.
 *
 * We parse a tiny subset of YAML (key: value + nested keys via indent) by
 * hand to avoid pulling js-yaml into the watchdog's standalone dep closure.
 * Complex configs can fall back to JSON (same keys).
 */

import { existsSync, readFileSync } from 'node:fs';

export const DEFAULT_CONFIG_PATH = '/etc/genie-watchdog/alerts.yaml';

export interface WatchdogConfig {
  readonly pg: { readonly dsn: string };
  readonly staleness_seconds: number;
  readonly alerts: {
    readonly email?: ReadonlyArray<string>;
    readonly sms?: ReadonlyArray<string>;
    readonly webhook?: string;
  };
}

const DEFAULT_CONFIG: WatchdogConfig = Object.freeze({
  pg: { dsn: process.env.GENIE_WATCHDOG_PG_DSN ?? 'postgres://localhost/genie' },
  staleness_seconds: 300,
  alerts: {},
});

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): WatchdogConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return DEFAULT_CONFIG;
  }
  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Partial<WatchdogConfig>;
      return mergeConfig(parsed);
    } catch {
      return DEFAULT_CONFIG;
    }
  }
  return mergeConfig(parseYamlSubset(raw));
}

function mergeConfig(partial: Partial<WatchdogConfig>): WatchdogConfig {
  return {
    pg: { dsn: partial.pg?.dsn ?? DEFAULT_CONFIG.pg.dsn },
    staleness_seconds: partial.staleness_seconds ?? DEFAULT_CONFIG.staleness_seconds,
    alerts: {
      email: partial.alerts?.email,
      sms: partial.alerts?.sms,
      webhook: partial.alerts?.webhook,
    },
  };
}

type YamlStackFrame = { indent: number; node: Record<string, unknown> };

function appendListItem(parent: Record<string, unknown>, trimmed: string): void {
  const value = parseScalar(trimmed.slice(2).trim());
  const lastKey = Object.keys(parent).pop();
  if (lastKey && Array.isArray(parent[lastKey])) {
    (parent[lastKey] as unknown[]).push(value);
  }
}

function nextNonBlankStartsList(lines: string[], idx: number): boolean {
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '' || t.startsWith('#')) continue;
    return t.startsWith('- ');
  }
  return false;
}

function assignKeyedEntry(
  stack: YamlStackFrame[],
  parent: Record<string, unknown>,
  indent: number,
  key: string,
  rawValue: string,
  lines: string[],
  lineIdx: number,
): void {
  if (rawValue !== '') {
    parent[key] = parseScalar(rawValue);
    return;
  }
  if (nextNonBlankStartsList(lines, lineIdx)) {
    parent[key] = [];
    return;
  }
  const child: Record<string, unknown> = {};
  parent[key] = child;
  stack.push({ indent, node: child });
}

function processYamlLine(stack: YamlStackFrame[], rawLine: string, lines: string[], lineIdx: number): void {
  const line = rawLine.replace(/#.*$/, '').trimEnd();
  if (line.trim() === '') return;

  const indent = line.match(/^( *)/)?.[1].length ?? 0;
  while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
  const parent = stack[stack.length - 1].node;
  const trimmed = line.trim();

  if (trimmed.startsWith('- ')) {
    appendListItem(parent, trimmed);
    return;
  }

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) return;
  const key = trimmed.slice(0, colonIdx).trim();
  const rawValue = trimmed.slice(colonIdx + 1).trim();
  assignKeyedEntry(stack, parent, indent, key, rawValue, lines, lineIdx);
}

/**
 * Minimal YAML parser — top-level keys and simple nesting by 2-space indent.
 * Values can be strings, numbers, arrays (`- item`), or nested objects.
 * Comments (`#`) and blank lines are ignored.
 */
export function parseYamlSubset(input: string): Partial<WatchdogConfig> {
  const out: Record<string, unknown> = {};
  const stack: YamlStackFrame[] = [{ indent: -1, node: out }];
  const lines = input.split('\n');
  for (let i = 0; i < lines.length; i++) {
    processYamlLine(stack, lines[i], lines, i);
  }
  return out as Partial<WatchdogConfig>;
}

function parseScalar(raw: string): unknown {
  if (raw === '') return '';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}
