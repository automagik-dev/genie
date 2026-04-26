/**
 * Tests for the `genie metrics agents` deprecation stub.
 *
 * Wish: invincible-genie / Group 5 — the corpse counter was deleted but
 * a one-release stub stays so existing CI scripts surface a redirect
 * instead of silently breaking. The stub MUST:
 *   1. Print a redirect message to `genie status` on stderr.
 *   2. Exit cleanly (no `process.exit(1)`); deprecation is not a failure.
 *   3. Emit a structured JSON body when `--json` is passed so any
 *      scripted callers can parse the deprecation marker.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { metricsAgentsCommand } from './metrics.js';

describe('metricsAgentsCommand (deprecation stub)', () => {
  const originalLog = console.log;
  const originalError = console.error;
  let captured: { stream: 'log' | 'error'; line: string }[] = [];

  beforeEach(() => {
    captured = [];
    console.log = (...args: unknown[]) => {
      captured.push({
        stream: 'log',
        line: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      });
    };
    console.error = (...args: unknown[]) => {
      captured.push({
        stream: 'error',
        line: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
      });
    };
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  test('emits redirect to `genie status` on stderr in human mode', async () => {
    await metricsAgentsCommand({});
    const stderr = captured.filter((c) => c.stream === 'error').map((c) => c.line);
    expect(stderr.some((l) => l.includes('deprecated'))).toBe(true);
    expect(stderr.some((l) => l.includes('genie status'))).toBe(true);
  });

  test('emits structured JSON deprecation marker with --json', async () => {
    await metricsAgentsCommand({ json: true });
    const stdout = captured.filter((c) => c.stream === 'log').map((c) => c.line);
    expect(stdout.length).toBeGreaterThan(0);
    const payload = JSON.parse(stdout[0]);
    expect(payload.deprecated).toBe(true);
    expect(payload.replacement).toBe('genie status');
    expect(typeof payload.message).toBe('string');
  });

  test('does not write to stderr in JSON mode (parsers shouldnt see warnings)', async () => {
    await metricsAgentsCommand({ json: true });
    const stderr = captured.filter((c) => c.stream === 'error');
    expect(stderr.length).toBe(0);
  });
});
