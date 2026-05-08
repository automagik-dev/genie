import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { getAuxiliaryPortBase } from './db.js';
import {
  type AuditRow,
  getOtelPort,
  isAllowlistedResourceKey,
  isOtelReceiverRunning,
  isPortBusyError,
  isSensitiveOtelKey,
  processLogs,
  processMetrics,
  startOtelReceiver,
  stopOtelReceiver,
} from './otel-receiver.js';

type TestServer = ReturnType<typeof Bun.serve>;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function startBusyServer(port: number): TestServer {
  return Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch: () => new Response('busy'),
  });
}

async function stopBusyServer(server: TestServer): Promise<void> {
  await server.stop(true);
}

async function stopBusyServers(servers: TestServer[]): Promise<void> {
  await Promise.all(servers.map((server) => server.stop(true)));
}

async function startBusyServers(ports: number[]): Promise<TestServer[]> {
  const servers: TestServer[] = [];
  try {
    for (const port of ports) {
      servers.push(startBusyServer(port));
    }
    return servers;
  } catch (err) {
    await stopBusyServers(servers);
    throw err;
  }
}

function getServerPort(server: TestServer): number {
  const port = server.port;
  if (port === undefined) throw new Error('Test server did not expose a bound port');
  return port;
}

async function reserveConsecutivePorts(count: number): Promise<TestServer[]> {
  const minPort = 57000;
  const maxBasePort = 64000 - count + 1;

  for (let attempt = 0; attempt < 100; attempt++) {
    const basePort = minPort + Math.floor(Math.random() * (maxBasePort - minPort + 1));
    const servers: TestServer[] = [];
    try {
      for (let offset = 0; offset < count; offset++) {
        servers.push(startBusyServer(basePort + offset));
      }
      return servers;
    } catch (err) {
      await stopBusyServers(servers);
      if (!isPortBusyError(err)) throw err;
    }
  }

  throw new Error(`Could not reserve ${count} consecutive test ports`);
}

async function useFreeExplicitOtelPort(): Promise<number> {
  const [server] = await reserveConsecutivePorts(1);
  const port = getServerPort(server);
  await stopBusyServer(server);
  process.env.GENIE_OTEL_PORT = String(port);
  return port;
}

async function configureDefaultOtelPortWindow(count: number): Promise<number> {
  const servers = await reserveConsecutivePorts(count);
  const defaultPort = getServerPort(servers[0]);
  await stopBusyServers(servers);
  process.env.GENIE_PG_PORT = String(defaultPort - 1);
  return getOtelPort();
}

describe('otel-receiver', () => {
  let origPort: string | undefined;
  let origProbeMax: string | undefined;
  let origPgPort: string | undefined;

  beforeEach(() => {
    origPort = process.env.GENIE_OTEL_PORT;
    origProbeMax = process.env.GENIE_OTEL_PORT_PROBE_MAX;
    origPgPort = process.env.GENIE_PG_PORT;
    restoreEnv('GENIE_OTEL_PORT', undefined);
    restoreEnv('GENIE_OTEL_PORT_PROBE_MAX', undefined);
    restoreEnv('GENIE_PG_PORT', undefined);
  });

  afterEach(async () => {
    await stopOtelReceiver();
    restoreEnv('GENIE_OTEL_PORT', origPort);
    restoreEnv('GENIE_OTEL_PORT_PROBE_MAX', origProbeMax);
    restoreEnv('GENIE_PG_PORT', origPgPort);
  });

  test('getOtelPort returns pgserve port + 1 by default', () => {
    expect(getOtelPort()).toBe(getAuxiliaryPortBase() + 1);
  });

  test('getOtelPort returns a valid default without env overrides', () => {
    const port = getOtelPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });

  test('getOtelPort respects GENIE_OTEL_PORT env', () => {
    process.env.GENIE_OTEL_PORT = '12345';
    expect(getOtelPort()).toBe(12345);
  });

  test('isPortBusyError recognizes Node, legacy, and Bun busy-port shapes', () => {
    expect(isPortBusyError(Object.assign(new Error('listen failed'), { code: 'EADDRINUSE' }))).toBe(true);
    expect(isPortBusyError('EADDRINUSE')).toBe(true);
    expect(isPortBusyError(new Error('address already in use'))).toBe(true);
    expect(isPortBusyError(new Error('Failed to start server. Is port 4318 in use?'))).toBe(true);
    expect(isPortBusyError(new Error('port 4318 is in use'))).toBe(true);
    expect(isPortBusyError(new Error('permission denied'))).toBe(false);
  });

  test('default mode probes to a distinct free port and reports the bound port', async () => {
    const defaultPort = await configureDefaultOtelPortWindow(2);
    const [busyDefault, freeNext] = await startBusyServers([defaultPort, defaultPort + 1]);
    const nextPort = defaultPort + 1;
    await stopBusyServer(freeNext);
    process.env.GENIE_OTEL_PORT_PROBE_MAX = '2';

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const started = await startOtelReceiver();
      expect(started).toBe(true);
      expect(isOtelReceiverRunning()).toBe(true);
      expect(getOtelPort()).toBe(nextPort);
      expect(warnSpy).not.toHaveBeenCalled();

      const res = await fetch(`http://127.0.0.1:${getOtelPort()}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { port: number };
      expect(body.port).toBe(nextPort);
    } finally {
      warnSpy.mockRestore();
      await stopBusyServer(busyDefault);
    }
  });

  test('explicit GENIE_OTEL_PORT attempts one busy port and does not probe', async () => {
    const [busyExplicit, freeNext] = await reserveConsecutivePorts(2);
    await stopBusyServer(freeNext);
    const busyPort = getServerPort(busyExplicit);
    process.env.GENIE_OTEL_PORT = String(busyPort);
    process.env.GENIE_OTEL_PORT_PROBE_MAX = '2';

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const started = await startOtelReceiver();
      expect(started).toBe(false);
      expect(isOtelReceiverRunning()).toBe(false);
      expect(getOtelPort()).toBe(busyPort);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain(`port ${busyPort} already in use`);
    } finally {
      warnSpy.mockRestore();
      await stopBusyServer(busyExplicit);
    }
  });

  test('default mode warns once when all probed ports are busy', async () => {
    const defaultPort = await configureDefaultOtelPortWindow(3);
    const blockers = await startBusyServers([defaultPort, defaultPort + 1, defaultPort + 2]);
    process.env.GENIE_OTEL_PORT_PROBE_MAX = '3';

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const started = await startOtelReceiver();
      expect(started).toBe(false);
      expect(isOtelReceiverRunning()).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain(`all probed ports busy (${defaultPort}-${defaultPort + 2})`);
    } finally {
      warnSpy.mockRestore();
      await stopBusyServers(blockers);
    }
  });

  test('stopOtelReceiver clears the bound port', async () => {
    const defaultPort = await configureDefaultOtelPortWindow(2);
    const [busyDefault, freeNext] = await startBusyServers([defaultPort, defaultPort + 1]);
    await stopBusyServer(freeNext);
    process.env.GENIE_OTEL_PORT_PROBE_MAX = '2';

    try {
      const started = await startOtelReceiver();
      expect(started).toBe(true);
      expect(getOtelPort()).toBe(defaultPort + 1);

      await stopOtelReceiver();
      expect(isOtelReceiverRunning()).toBe(false);
      expect(getOtelPort()).toBe(defaultPort);
    } finally {
      await stopBusyServer(busyDefault);
    }
  });

  test('startOtelReceiver starts and is idempotent', async () => {
    const port = await useFreeExplicitOtelPort();
    expect(isOtelReceiverRunning()).toBe(false);

    const started = await startOtelReceiver();
    expect(started).toBe(true);
    expect(isOtelReceiverRunning()).toBe(true);
    expect(getOtelPort()).toBe(port);

    // Second call is idempotent
    const started2 = await startOtelReceiver();
    expect(started2).toBe(true);
  });

  test('stopOtelReceiver stops the server', async () => {
    await useFreeExplicitOtelPort();
    const started = await startOtelReceiver();
    expect(started).toBe(true);
    expect(isOtelReceiverRunning()).toBe(true);

    await stopOtelReceiver();
    expect(isOtelReceiverRunning()).toBe(false);
  });

  test('POST /v1/logs returns 200', async () => {
    await useFreeExplicitOtelPort();
    const started = await startOtelReceiver();
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
    await useFreeExplicitOtelPort();
    const started = await startOtelReceiver();
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
    await useFreeExplicitOtelPort();
    const started = await startOtelReceiver();
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
    await useFreeExplicitOtelPort();
    const started = await startOtelReceiver();
    expect(started).toBe(true);
    const port = getOtelPort();

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  test('unknown route returns 404', async () => {
    await useFreeExplicitOtelPort();
    const started = await startOtelReceiver();
    expect(started).toBe(true);
    const port = getOtelPort();

    const res = await fetch(`http://127.0.0.1:${port}/v1/unknown`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

// ============================================================================
// Sensitive key redaction — wish observability-signal-normalization Group 3
// ============================================================================

const SENSITIVE_KEYS = ['user.email', 'user.id', 'user.account_id', 'user.account_uuid', 'organization.id'] as const;

function flattenDetails(rows: AuditRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.details)) keys.add(key);
  return keys;
}

describe('OTel sensitive key redaction', () => {
  test('isSensitiveOtelKey covers every documented identifier', () => {
    for (const key of SENSITIVE_KEYS) expect(isSensitiveOtelKey(key)).toBe(true);
    expect(isSensitiveOtelKey('agent.name')).toBe(false);
    expect(isSensitiveOtelKey('model')).toBe(false);
  });

  test('isAllowlistedResourceKey only admits the documented safe keys', () => {
    expect(isAllowlistedResourceKey('agent.name')).toBe(true);
    expect(isAllowlistedResourceKey('team.name')).toBe(true);
    expect(isAllowlistedResourceKey('session.id')).toBe(true);
    expect(isAllowlistedResourceKey('service.name')).toBe(true);
    // Sensitive keys never reach the allowlist
    for (const key of SENSITIVE_KEYS) expect(isAllowlistedResourceKey(key)).toBe(false);
    // Random unknown attribute is NOT allowlisted
    expect(isAllowlistedResourceKey('terminal.type')).toBe(false);
  });

  test('processLogs drops sensitive keys from log record attributes', () => {
    const rows = processLogs({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'agent.name', value: { stringValue: 'engineer-3' } },
              // Resource-level sensitive identifiers MUST be dropped
              { key: 'user.email', value: { stringValue: 'leak@example.com' } },
              { key: 'user.id', value: { stringValue: 'res-user-1' } },
              { key: 'organization.id', value: { stringValue: 'org-9' } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: 'event.name', value: { stringValue: 'claude_code.user_prompt' } },
                    { key: 'user.email', value: { stringValue: 'leak@example.com' } },
                    { key: 'user.id', value: { stringValue: 'log-user-1' } },
                    { key: 'user.account_id', value: { stringValue: 'acct-1' } },
                    { key: 'user.account_uuid', value: { stringValue: 'acct-uuid-1' } },
                    { key: 'organization.id', value: { stringValue: 'org-1' } },
                    { key: 'prompt_length', value: { intValue: '42' } },
                  ],
                  body: { stringValue: 'pong' },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(rows).toHaveLength(1);
    const keys = flattenDetails(rows);
    for (const sensitive of SENSITIVE_KEYS) expect(keys.has(sensitive)).toBe(false);
    // Non-sensitive payload survives
    expect(keys.has('prompt_length')).toBe(true);
    expect(keys.has('event_name')).toBe(true);
    expect(rows[0].actor).toBe('engineer-3');
  });

  test('processLogs drops sensitive keys from kvlist body values', () => {
    const rows = processLogs({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [{ key: 'event.name', value: { stringValue: 'claude_code.api_request' } }],
                  body: {
                    kvlistValue: {
                      values: [
                        { key: 'user.email', value: { stringValue: 'kv-leak@example.com' } },
                        { key: 'duration_ms', value: { intValue: '120' } },
                      ],
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const keys = flattenDetails(rows);
    expect(keys.has('user.email')).toBe(false);
    expect(keys.has('duration_ms')).toBe(true);
  });

  test('processMetrics drops sensitive keys from data point attributes', () => {
    const rows = processMetrics({
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: 'agent.name', value: { stringValue: 'engineer-3' } },
              { key: 'user.email', value: { stringValue: 'leak@example.com' } },
              { key: 'user.account_uuid', value: { stringValue: 'acct-uuid' } },
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.cost.usage',
                  sum: {
                    dataPoints: [
                      {
                        asDouble: 0.05,
                        attributes: [
                          { key: 'model', value: { stringValue: 'opus' } },
                          { key: 'user.email', value: { stringValue: 'leak@example.com' } },
                          { key: 'user.id', value: { stringValue: 'metric-user-1' } },
                          { key: 'organization.id', value: { stringValue: 'org-2' } },
                        ],
                      },
                    ],
                  },
                },
                {
                  name: 'claude_code.token.usage',
                  histogram: {
                    dataPoints: [
                      {
                        sum: 100,
                        count: 1,
                        attributes: [
                          { key: 'token_type', value: { stringValue: 'input' } },
                          { key: 'user.account_id', value: { stringValue: 'hist-acct-1' } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(rows.length).toBeGreaterThanOrEqual(2);
    const keys = flattenDetails(rows);
    for (const sensitive of SENSITIVE_KEYS) expect(keys.has(sensitive)).toBe(false);
    // Operational attributes still propagate
    expect(keys.has('model')).toBe(true);
    expect(keys.has('token_type')).toBe(true);
    // Resource agent.name is still extracted via the allowlist path
    expect(rows[0].actor).toBe('engineer-3');
  });

  test('non-allowlisted resource attributes (terminal.type, app.version) are not promoted into details', () => {
    const rows = processLogs({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'agent.name', value: { stringValue: 'engineer-3' } },
              { key: 'terminal.type', value: { stringValue: 'tmux' } },
              { key: 'app.version', value: { stringValue: '4.260502.1' } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [{ key: 'event.name', value: { stringValue: 'claude_code.tool_result' } }],
                },
              ],
            },
          ],
        },
      ],
    });
    const keys = flattenDetails(rows);
    expect(keys.has('terminal.type')).toBe(false);
    expect(keys.has('app.version')).toBe(false);
  });
});
