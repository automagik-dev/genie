import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getOtelPort, isOtelReceiverRunning, startOtelReceiver, stopOtelReceiver } from './otel-receiver.js';

describe('otel-receiver', () => {
  let origPort: string | undefined;

  beforeEach(() => {
    origPort = process.env.GENIE_OTEL_PORT;
    // Use a random high port to avoid conflicts with running pgserve or parallel tests
    // Range 57000-63999 avoids typical pgserve ports (19643-19700) and ephemeral ports
    process.env.GENIE_OTEL_PORT = String(57000 + Math.floor(Math.random() * 7000));
  });

  afterEach(async () => {
    await stopOtelReceiver();
    if (origPort !== undefined) process.env.GENIE_OTEL_PORT = origPort;
    else process.env.GENIE_OTEL_PORT = undefined;
  });

  // Parallel test workers can collide on the 7000-port window (57000-63999)
  // because port selection is random, not coordinated. When they do,
  // startOtelReceiver() returns false with EADDRINUSE and the test fails
  // intermittently in CI. This helper re-rolls the port and retries up to
  // maxAttempts. If the receiver fails for a non-port reason, all retries
  // fail the same way and the test surfaces the real error instead of
  // silently masking it. Source-level fix (#1148) would be ephemeral port
  // binding (port: 0) in otel-receiver.ts itself — tracked separately.
  async function startWithPortRetry(maxAttempts = 5): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) {
        // re-roll on retry so we don't keep hitting the same busy port
        process.env.GENIE_OTEL_PORT = String(57000 + Math.floor(Math.random() * 7000));
      }
      const ok = await startOtelReceiver();
      if (ok) return true;
      // Ensure no leaked server between attempts
      await stopOtelReceiver();
    }
    return false;
  }

  test('getOtelPort returns pgserve port + 1 by default', () => {
    const port = getOtelPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  test('getOtelPort respects GENIE_OTEL_PORT env', () => {
    process.env.GENIE_OTEL_PORT = '12345';
    expect(getOtelPort()).toBe(12345);
  });

  test('startOtelReceiver starts and is idempotent', async () => {
    expect(isOtelReceiverRunning()).toBe(false);

    const started = await startWithPortRetry();
    expect(started).toBe(true);
    expect(isOtelReceiverRunning()).toBe(true);

    // Second call is idempotent
    const started2 = await startOtelReceiver();
    expect(started2).toBe(true);
  });

  test('stopOtelReceiver stops the server', async () => {
    const started = await startWithPortRetry();
    expect(started).toBe(true);
    expect(isOtelReceiverRunning()).toBe(true);

    await stopOtelReceiver();
    expect(isOtelReceiverRunning()).toBe(false);
  });

  test('POST /v1/logs returns 200', async () => {
    const started = await startWithPortRetry();
    expect(started).toBe(true);
    const port = getOtelPort();

    const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resourceLogs: [
          {
            resource: {
              attributes: [
                { key: 'agent.name', value: { stringValue: 'test-agent' } },
                { key: 'team.name', value: { stringValue: 'test-team' } },
              ],
            },
            scopeLogs: [
              {
                logRecords: [
                  {
                    attributes: [{ key: 'event.name', value: { stringValue: 'claude_code.tool_result' } }],
                    body: { stringValue: 'test event' },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
  });

  test('POST /v1/metrics returns 200', async () => {
    const started = await startWithPortRetry();
    expect(started).toBe(true);
    const port = getOtelPort();

    const res = await fetch(`http://127.0.0.1:${port}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resourceMetrics: [
          {
            resource: {
              attributes: [{ key: 'agent.name', value: { stringValue: 'test-agent' } }],
            },
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'claude_code.cost.usage',
                    sum: {
                      dataPoints: [{ asDouble: 0.05, attributes: [{ key: 'model', value: { stringValue: 'opus' } }] }],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
  });

  test('POST /v1/logs handles empty payload', async () => {
    const started = await startWithPortRetry();
    expect(started).toBe(true);
    const port = getOtelPort();

    const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(200);
  });

  test('GET /health returns ok', async () => {
    const started = await startWithPortRetry();
    expect(started).toBe(true);
    const port = getOtelPort();

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  test('unknown route returns 404', async () => {
    const started = await startWithPortRetry();
    expect(started).toBe(true);
    const port = getOtelPort();

    const res = await fetch(`http://127.0.0.1:${port}/v1/unknown`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
