/**
 * Tests for the OTel scope-warning helpers exported by audit-events.ts.
 *
 * Issue #1263 Sub-fix 1 — the roll-ups (`events tools`, `events summary`,
 * `events costs`) and the filtered list surfaces (`events list --type
 * otel_*`, `events list --enriched --kind tool`) must surface the
 * capture scope so empty output isn't read as "observability is
 * broken." These tests pin down the helper behavior the command
 * wrappers rely on. (`--v2` is the legacy alias kept for one release;
 * see invincible-genie Group 5.)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { isOtelKindFilter, isOtelTypeFilter, printOtelScopeWarning } from './audit-events.js';

describe('isOtelTypeFilter', () => {
  test('matches otel_* prefixes', () => {
    expect(isOtelTypeFilter('otel_tool_call')).toBe(true);
    expect(isOtelTypeFilter('otel_api_request')).toBe(true);
  });

  test('does not match non-otel types', () => {
    expect(isOtelTypeFilter('agent_spawn')).toBe(false);
    expect(isOtelTypeFilter('task_moved')).toBe(false);
    expect(isOtelTypeFilter('')).toBe(false);
  });

  test('handles undefined/nullish inputs', () => {
    expect(isOtelTypeFilter(undefined)).toBe(false);
  });
});

describe('isOtelKindFilter', () => {
  test('matches tool / tool_call / tool_result prefixes', () => {
    expect(isOtelKindFilter('tool')).toBe(true);
    expect(isOtelKindFilter('tool_call')).toBe(true);
    expect(isOtelKindFilter('tool_result')).toBe(true);
  });

  test('does not match non-tool kinds', () => {
    expect(isOtelKindFilter('mailbox')).toBe(false);
    expect(isOtelKindFilter('agent.lifecycle')).toBe(false);
    expect(isOtelKindFilter('message')).toBe(false);
    expect(isOtelKindFilter('')).toBe(false);
  });

  test('handles undefined inputs', () => {
    expect(isOtelKindFilter(undefined)).toBe(false);
  });
});

describe('printOtelScopeWarning', () => {
  const originalLog = console.log;
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    console.log = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test('always emits the genie-spawned scope note', () => {
    printOtelScopeWarning({ empty: false });
    expect(captured.some((l) => l.includes('OTel-derived events only cover genie-spawned sessions'))).toBe(true);
  });

  test('non-empty case does NOT print the remediation hint', () => {
    printOtelScopeWarning({ empty: false });
    const joined = captured.join('\n');
    expect(joined).not.toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(joined).toContain('not captured unless they export OTLP');
  });

  test('empty case prints the remediation hint with a concrete endpoint', () => {
    printOtelScopeWarning({ empty: true });
    const joined = captured.join('\n');
    expect(joined).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    // Either a live port resolved from getOtelPort() or the fallback placeholder
    expect(/http:\/\/127\.0\.0\.1:(\d+|<otel-port>)/.test(joined)).toBe(true);
    expect(joined).toContain('CLAUDE_CODE_ENABLE_TELEMETRY=1');
    expect(joined).toContain('restart your Claude Code session');
  });
});
