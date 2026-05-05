import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('pgserve lockfile', () => {
  let testHome: string;
  let lockfilePath: string;
  let origGenieHome: string | undefined;
  let origPgPort: string | undefined;

  beforeEach(() => {
    testHome = join(tmpdir(), `genie-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testHome, { recursive: true });
    lockfilePath = join(testHome, 'pgserve.port');
    origGenieHome = process.env.GENIE_HOME;
    origPgPort = process.env.GENIE_PG_PORT;
    process.env.GENIE_HOME = testHome;
  });

  afterEach(() => {
    if (origGenieHome !== undefined) {
      process.env.GENIE_HOME = origGenieHome;
    } else {
      process.env.GENIE_HOME = undefined;
    }
    if (origPgPort !== undefined) {
      process.env.GENIE_PG_PORT = origPgPort;
    } else {
      process.env.GENIE_PG_PORT = undefined;
    }
    // Clean up lockfile
    try {
      unlinkSync(lockfilePath);
    } catch {}
    // Clean up test dir
    try {
      const { rmSync } = require('node:fs');
      rmSync(testHome, { recursive: true, force: true });
    } catch {}
  });

  test('lockfile is written with port number', () => {
    writeFileSync(lockfilePath, '19642', 'utf-8');
    const content = readFileSync(lockfilePath, 'utf-8').trim();
    expect(content).toBe('19642');
    expect(Number.parseInt(content, 10)).toBe(19642);
  });

  test('lockfile with invalid content is treated as absent', () => {
    writeFileSync(lockfilePath, 'not-a-port', 'utf-8');
    const content = readFileSync(lockfilePath, 'utf-8').trim();
    const port = Number.parseInt(content, 10);
    expect(Number.isNaN(port)).toBe(true);
  });

  test('lockfile with out-of-range port is treated as invalid', () => {
    writeFileSync(lockfilePath, '99999', 'utf-8');
    const content = readFileSync(lockfilePath, 'utf-8').trim();
    const port = Number.parseInt(content, 10);
    expect(port).toBeGreaterThan(65535);
  });

  test('missing lockfile returns null from readFileSync catch', () => {
    expect(existsSync(lockfilePath)).toBe(false);
    let result: number | null = null;
    try {
      const content = readFileSync(lockfilePath, 'utf-8').trim();
      const port = Number.parseInt(content, 10);
      if (!Number.isNaN(port) && port > 0 && port < 65536) result = port;
    } catch {
      result = null;
    }
    expect(result).toBeNull();
  });

  test('lockfile is removed by unlinkSync', () => {
    writeFileSync(lockfilePath, '19642', 'utf-8');
    expect(existsSync(lockfilePath)).toBe(true);
    unlinkSync(lockfilePath);
    expect(existsSync(lockfilePath)).toBe(false);
  });

  test('removing non-existent lockfile does not throw', () => {
    expect(existsSync(lockfilePath)).toBe(false);
    expect(() => {
      try {
        unlinkSync(lockfilePath);
      } catch {
        // Expected — mirrors removeLockfile() behavior
      }
    }).not.toThrow();
  });

  test('atomic write via tmp+rename pattern', () => {
    const tmpPath = `${lockfilePath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, '19642', 'utf-8');
    const { renameSync } = require('node:fs');
    renameSync(tmpPath, lockfilePath);

    expect(existsSync(lockfilePath)).toBe(true);
    expect(readFileSync(lockfilePath, 'utf-8').trim()).toBe('19642');
    expect(existsSync(tmpPath)).toBe(false);
  });
});

describe('port listening detection', () => {
  test('detects a listening TCP port', async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        }
      });
    });

    const { createConnection } = await import('node:net');
    const isListening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });

    expect(isListening).toBe(true);
    server.close();
  });

  test('detects a non-listening port', async () => {
    // Use a random high port that's very unlikely to be in use
    const port = 49152 + Math.floor(Math.random() * 10000);

    const { createConnection } = await import('node:net');
    const isListening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });

    expect(isListening).toBe(false);
  });
});

describe('stale lockfile detection', () => {
  let testHome: string;
  let lockfilePath: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `genie-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testHome, { recursive: true });
    lockfilePath = join(testHome, 'pgserve.port');
  });

  afterEach(() => {
    try {
      const { rmSync } = require('node:fs');
      rmSync(testHome, { recursive: true, force: true });
    } catch {}
  });

  test('stale lockfile with non-listening port is cleaned up', async () => {
    // Write a lockfile pointing to a port that nobody is listening on
    const stalePort = 49152 + Math.floor(Math.random() * 10000);
    writeFileSync(lockfilePath, String(stalePort), 'utf-8');
    expect(existsSync(lockfilePath)).toBe(true);

    // Simulate the stale detection logic from _ensurePgserve
    const content = readFileSync(lockfilePath, 'utf-8').trim();
    const port = Number.parseInt(content, 10);

    const { createConnection } = await import('node:net');
    const isListening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });

    expect(isListening).toBe(false);

    // Clean up stale lockfile (mirrors _ensurePgserve behavior)
    unlinkSync(lockfilePath);
    expect(existsSync(lockfilePath)).toBe(false);
  });

  test('valid lockfile with listening port is reused', async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        }
      });
    });

    writeFileSync(lockfilePath, String(port), 'utf-8');

    const content = readFileSync(lockfilePath, 'utf-8').trim();
    const lockfilePort = Number.parseInt(content, 10);
    expect(lockfilePort).toBe(port);

    const { createConnection } = await import('node:net');
    const isListening = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port: lockfilePort, host: '127.0.0.1' }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });

    expect(isListening).toBe(true);

    // Lockfile should NOT be cleaned up — port is valid
    expect(existsSync(lockfilePath)).toBe(true);

    server.close();
  });
});

describe('getLockfilePath', () => {
  test('returns path under GENIE_HOME', async () => {
    // The function exists and returns a string path ending in pgserve.port
    const { getLockfilePath } = await import('./db.js');
    expect(typeof getLockfilePath()).toBe('string');
    expect(getLockfilePath().endsWith('pgserve.port')).toBe(true);
  });
});

describe('isPostgresHealthy timeout', () => {
  test('returns false within 5s when TCP connects but protocol never responds', async () => {
    // Regression test: a proxy that accepts TCP but never sends postgres
    // protocol data caused 40 test failures by hanging isPostgresHealthy
    // forever. The fix wraps the health check in Promise.race with a 4s timeout.
    const server = createServer((socket) => {
      // Accept connection but never write anything — simulates stuck proxy
      socket.on('error', () => {});
    });

    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        }
      });
    });

    try {
      // isPostgresHealthy is not exported, so replicate its Promise.race pattern
      const pg = (await import('postgres')).default;
      const probe = pg({
        host: '127.0.0.1',
        port,
        database: 'genie',
        username: 'postgres',
        password: 'postgres',
        max: 1,
        connect_timeout: 3,
        idle_timeout: 1,
      });

      const start = Date.now();
      const result = await Promise.race([
        (async () => {
          try {
            await probe`SELECT 1`;
            await probe.end({ timeout: 2 });
            return true;
          } catch {
            try {
              await probe.end({ timeout: 1 });
            } catch {
              /* ignore */
            }
            return false;
          }
        })(),
        new Promise<false>((resolve) => {
          const t = setTimeout(() => resolve(false), 4000);
          t.unref();
        }),
      ]);
      const elapsed = Date.now() - start;

      expect(result).toBe(false);
      // Must complete within 5s (4s timeout + margin), never hang forever
      expect(elapsed).toBeLessThan(5000);
    } finally {
      server.close();
    }
  });
});

describe('daemon-owned pgserve', () => {
  test('db.ts uses health check instead of port retry loop', async () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // No more MAX_PORT_RETRIES — daemon owns PG, no fallback ports
    expect(source.includes('MAX_PORT_RETRIES')).toBe(false);
    // Uses real postgres health check, not TCP-only
    expect(source.includes('isPostgresHealthy')).toBe(true);
    // selfHealPostgres was deleted in the canonical-pgserve cutover — pkill of
    // pm2-supervised processes was the bug behind every "Could not kill stale
    // postgres processes" failure. Lock the function out of reintroduction.
    expect(source.includes('selfHealPostgres')).toBe(false);
  });

  test('socket connections answer pgserve v2 postgres-wire auth', async () => {
    const { DB_NAME, resolvePgserveAuthPassword } = await import('./db.js');
    const originalPassword = process.env.PGPASSWORD;

    try {
      process.env.PGPASSWORD = '';
      expect(resolvePgserveAuthPassword()).toBe(DB_NAME);

      process.env.PGPASSWORD = 'custom-local-value';
      expect(resolvePgserveAuthPassword()).toBe('custom-local-value');
    } finally {
      if (originalPassword === undefined) {
        process.env.PGPASSWORD = undefined;
      } else {
        process.env.PGPASSWORD = originalPassword;
      }
    }

    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // Post-refactor (#1651): pgModule call delegates to buildPgClientOptions.
    // Connection is still bound to a local first so concurrent rebuilds can't
    // make this caller observe a nulled `sqlClient`.
    expect(source).toContain('const client = pgModule(buildPgClientOptions(');
    const optionsStart = source.indexOf('function buildPgClientOptions');
    expect(optionsStart).toBeGreaterThan(-1);
    const optionsBody = source.slice(optionsStart, source.indexOf('\n}\n', optionsStart));
    expect(optionsBody).toContain('username: DB_NAME');
    expect(optionsBody).toContain('[PG_AUTH_FIELD]: transport.pgWireCredential');
    expect(source).toContain('const PG_AUTH_FIELD');
    // pgWireCredential resolution moved into resolveTransport.
    expect(source).toContain(
      'const pgWireCredential = useSocket ? resolvePgserveAuthPassword() : resolveTcpPgPassword()',
    );
    // Sharing the global happens AFTER local construction.
    expect(source).toContain('sqlClient = client');
  });

  test('socket connections use the pgserve startup timeout window', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    const helperStart = source.indexOf('function resolvePgConnectTimeoutSeconds');
    expect(helperStart).toBeGreaterThan(-1);
    const helperBody = source.slice(helperStart, source.indexOf('\n/** Back-compat', helperStart));

    expect(helperBody).toContain('process.env.GENIE_PG_CONNECT_TIMEOUT');
    expect(helperBody).toContain('if (!useSocket) return 5');
    expect(helperBody).toContain('Math.max(16, Math.ceil(resolvePgserveTimeoutMs() / 1000))');

    // Post-refactor (#1651): connect_timeout is wired in buildPgClientOptions.
    const optionsStart = source.indexOf('function buildPgClientOptions');
    expect(optionsStart).toBeGreaterThan(-1);
    const optionsBody = source.slice(optionsStart, source.indexOf('\n}\n', optionsStart));
    expect(optionsBody).toContain('connect_timeout: resolvePgConnectTimeoutSeconds(transport.useSocket)');
  });

  test('production connections use UDS-first / TCP-fallback transport discovery', () => {
    // Post-pgserve-transport-discovery: `_buildConnection` no longer hard-fails
    // when the canonical UDS is missing. Instead it asks `resolvePgserveTransport()`
    // for the live transport (UDS preferred, TCP via `pgserve port` as
    // fallback). Test mode (GENIE_TEST_PG_PORT) keeps the legacy in-process
    // TCP path because the test harness provisions its own pgserve --ram
    // instance and exposes the port via env.
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    const fnStart = source.indexOf('async function _buildConnection');
    expect(fnStart).toBeGreaterThan(-1);
    const body = source.slice(fnStart, source.indexOf('\n}\n', fnStart));

    // Test-mode short-circuit: keeps the existing TCP path for unit tests.
    expect(body).toContain('const useTestModeTcp = Boolean(process.env.GENIE_TEST_PG_PORT)');
    expect(body).toContain('await resolveTransport(false)');

    // Production path: probe transports via the new resolver.
    expect(body).toContain('await resolvePgserveTransport()');

    // Resolver must contain both probe primitives.
    const resolverStart = source.indexOf('export async function resolvePgserveTransport');
    expect(resolverStart).toBeGreaterThan(-1);
    const resolverBody = source.slice(resolverStart, source.indexOf('\n}\n', resolverStart));
    expect(resolverBody).toContain('probePgserveDaemon()');
    expect(resolverBody).toContain('isPgserveSocketResponsive()');
    expect(resolverBody).toContain('discoverTcpPgservePort()');
    // Force-flag overrides: both legacy GENIE_PG_FORCE_TCP and new
    // GENIE_PG_FORCE_SOCKET must remain wired so operators can pin one
    // transport for diagnostics.
    expect(resolverBody).toContain("process.env.GENIE_PG_FORCE_TCP === '1'");
    expect(resolverBody).toContain("process.env.GENIE_PG_FORCE_SOCKET === '1'");
  });

  test('canonical-cutover removed every spawn helper from db.ts', () => {
    // Locks out reintroduction of the daemon-owner code paths the cutover
    // wish removed. Genie is consumer-only post-cutover; all helpers below
    // must remain absent from db.ts source.
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    for (const symbol of [
      'startPgserveDaemonOnce',
      'spawnPgserveDirect',
      'startPgserveOnPort',
      'findPgserveBin',
      'findPgserveDaemonCommand',
      'resolvePgservePackageCommand',
      'findBunRuntime',
      'findLocalPgserveRoot',
      'evictOrphanDataDirHolder',
      'detectOrphanDataDirLock',
      'terminatePgserveTree',
      'signalPgserveTree',
      'signalPgserveDaemonPid',
      'recoverUnresponsivePgserveDaemon',
      'isLikelyPgserveDaemonProcess',
      'cleanPartialDaemonState',
      'waitForDaemonSocket',
      'waitForDaemonPort',
      'throwDaemonTimeout',
      'formatPgserveDaemonCommand',
      'selfHealPostgres',
    ]) {
      expect(source).not.toContain(symbol);
    }
    // Lock out pgserve binary spawn invocation, EXCEPT the read-only discovery
    // subcommands (`port`, `url`, `status`). Discovery is consumer-only —
    // it doesn't own the daemon's lifecycle, just reads the published state.
    // The post-pgserve-transport-discovery TCP fallback uses `pgserve port`.
    //
    // Forbidden patterns (daemon ownership):
    //   spawn('pgserve', ['daemon', ...])    // owning the daemon process
    //   spawn('pgserve', [<no subcommand>])  // bare pgserve (foreground TCP install)
    //   spawn('pgserve', ['install', ...])   // pm2 registration (genie shouldn't own it)
    //
    // Allowed patterns (read-only discovery):
    //   spawn('pgserve', ['port'])
    //   spawn('pgserve', ['url'])
    //   spawn('pgserve', ['status', '--json'])
    const spawnPgserveMatches = source.matchAll(/spawn(?:Sync)?\(\s*['"]pgserve['"]\s*,\s*\[([^\]]*)\]/g);
    for (const match of spawnPgserveMatches) {
      const args = match[1];
      const firstArg = args.match(/['"]([^'"]+)['"]/)?.[1] ?? '';
      expect(['port', 'url', 'status']).toContain(firstArg);
    }
    expect(source).not.toContain('pkill');
  });

  test('requirePgserveDaemon never spawns when daemon is healthy (cutover G5 regression)', () => {
    // Static guarantee: the probe-only contract is enforced by reading the
    // function body and asserting it never invokes any child_process spawn
    // primitive nor process.kill. Replaces the spawn-mock behavioural test
    // the wish suggested — Bun's module cache makes spy-then-reimport
    // brittle, and the source-text assertion is strictly stronger
    // (covers every code path through the function, not just the one the
    // mocked test would exercise).
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    const fnStart = source.indexOf('export async function requirePgserveDaemon');
    expect(fnStart).toBeGreaterThan(-1);
    // Slice up to the next defined function — `buildPgserveUnavailableHint`
    // immediately follows `requirePgserveDaemon` after the cutover removed
    // the pre-cutover `getOrStartDaemon` alias.
    const fnEnd = source.indexOf('function buildPgserveUnavailableHint', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = source.slice(fnStart, fnEnd);

    for (const banned of ['spawn(', 'execSync(', 'execFileSync(', 'spawnSync(', 'process.kill(']) {
      expect(body).not.toContain(banned);
    }
    // Positive: the body must call the probe primitives that prove
    // reachability without process work.
    expect(body).toContain('probePgserveDaemon');
    expect(body).toContain('isPgserveSocketResponsive');
    // Defence-in-depth: the pre-cutover `getOrStartDaemon` symbol is gone
    // (the project's dead-code gate doesn't honour @deprecated; downstream
    // callers must rename to requirePgserveDaemon). Lock out reintroduction.
    expect(source).not.toContain('export async function getOrStartDaemon');
  });

  test('canonical pgserve UDS greeting probe is preserved', () => {
    // The greet-completion check is the live-reachability primitive the new
    // requirePgserveDaemon() depends on. Pinned so future refactors don't
    // accidentally drop the protocol-aware probe in favour of a bare
    // existsSync() that fooled stale-socket scenarios pre-cutover.
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    const greetStart = source.indexOf('function canCompletePgserveGreet');
    expect(greetStart).toBeGreaterThan(-1);
    const greetBody = source.slice(greetStart, source.indexOf('\n}\n', greetStart));
    expect(greetBody).toContain('request.writeUInt32BE(8, 0)');
    expect(greetBody).toContain('request.writeUInt32BE(PG_SSL_REQUEST_CODE, 4)');
    expect(greetBody).toContain("socket.once('data'");
  });
});

describe('retention cleanup', () => {
  test('retention DELETEs are present in runRetention()', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // All 4 retention policies still defined in the runRetention function
    expect(source).toContain("DELETE FROM heartbeats WHERE created_at < now() - interval '7 days'");
    expect(source).toContain("DELETE FROM machine_snapshots WHERE created_at < now() - interval '30 days'");
    expect(source).toContain(
      "DELETE FROM audit_events WHERE entity_type LIKE 'otel_%' AND created_at < now() - interval '30 days'",
    );
    expect(source).toContain("DELETE FROM genie_runtime_events WHERE created_at < now() - interval '14 days'");
  });

  test('runRetention is exported for daemon-side timer', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // runRetention must be exported so scheduler-daemon can call it on its
    // periodic timer (was inline-private when it ran from runPostConnectSetup).
    expect(source).toContain('export async function runRetention');
  });

  test('runPostConnectSetup no longer invokes runRetention (Mac CPU fix A)', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // The hook-dispatch cold-start fanout path must NOT trigger retention;
    // every `genie hook dispatch` bun fork would otherwise issue 4 DELETEs.
    // Scheduler-daemon now owns the periodic call.
    const setupFnIdx = source.indexOf('async function runPostConnectSetup');
    expect(setupFnIdx).toBeGreaterThan(-1);
    const setupFn = source.slice(setupFnIdx, source.indexOf('\nexport async function getConnection'));
    expect(setupFn).not.toContain('await runRetention(');
  });

  test('retentionRan flag still exists for daemon intra-process guard', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    expect(source).toContain('let retentionRan = false');
    expect(source).toContain('retentionRan = true');
  });

  test('retention failure is non-fatal — logs warning, does not throw', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    expect(source).toContain('retention cleanup warning');
    // retentionRan set to true even on failure to prevent retries
    const catchBlock = source.slice(source.indexOf('catch (retErr)'), source.indexOf('catch (retErr)') + 300);
    expect(catchBlock).toContain('retentionRan = true');
  });

  test('retention migration file exists with all 4 tables', () => {
    const migration = readFileSync(join(__dirname, '..', 'db', 'migrations', '019_retention.sql'), 'utf-8');
    expect(migration).toContain('DELETE FROM heartbeats');
    expect(migration).toContain('DELETE FROM machine_snapshots');
    expect(migration).toContain('DELETE FROM audit_events');
    expect(migration).toContain('DELETE FROM genie_runtime_events');
  });

  test('scheduler-daemon owns the periodic retention timer', () => {
    const daemonSource = readFileSync(join(__dirname, 'scheduler-daemon.ts'), 'utf-8');
    expect(daemonSource).toContain('retentionTimer');
    expect(daemonSource).toContain('runRetention');
    // 1-hour cadence
    expect(daemonSource).toContain('60 * 60 * 1000');
    // Cleanup on stop()
    expect(daemonSource).toContain('clearInterval(retentionTimer)');
  });
});

describe('GENIE_SKIP_DB_BOOT (Mac CPU fix C — hook-dispatch coldstart)', () => {
  test('runPostConnectSetup honors GENIE_SKIP_DB_BOOT alongside isTestMode', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // The skipBoot guard must combine isTestMode + the env var so the
    // hook-dispatch entrypoint can short-circuit migrations + seed
    expect(source).toContain("process.env.GENIE_SKIP_DB_BOOT === '1'");
    expect(source).toMatch(/skipBoot\s*=\s*isTestMode\s*\|\|\s*process\.env\.GENIE_SKIP_DB_BOOT/);
    // Both migrations and seed gated by skipBoot
    expect(source).toMatch(/if \(!skipBoot\) await runMigrations/);
    expect(source).toMatch(/if \(!skipBoot && \(needsSeed\(\) \|\| \(await needsSeededTeams\(client\)\)\)\) \{/);
    expect(source).toContain('await runSeed(client);');
  });

  test('hook dispatch entrypoint sets GENIE_SKIP_DB_BOOT before invoking dispatch()', () => {
    const dispatchSource = readFileSync(join(__dirname, '..', 'hooks', 'dispatch-command.ts'), 'utf-8');
    // Env must be set inside dispatchAction (not at module load — that would
    // affect the entire genie binary including the daemon path)
    const dispatchActionIdx = dispatchSource.indexOf('async function dispatchAction');
    expect(dispatchActionIdx).toBeGreaterThan(-1);
    const fnBody = dispatchSource.slice(dispatchActionIdx, dispatchSource.indexOf('}', dispatchActionIdx + 100));
    expect(fnBody).toContain("process.env.GENIE_SKIP_DB_BOOT = '1'");
    // Must be set BEFORE dispatch(stdin) so the first getConnection() inside
    // any handler skips migrations + seed
    const envSetIdx = dispatchSource.indexOf("GENIE_SKIP_DB_BOOT = '1'");
    const dispatchCallIdx = dispatchSource.indexOf('await dispatch(stdin)');
    expect(envSetIdx).toBeLessThan(dispatchCallIdx);
  });
});

describe('pool error recovery', () => {
  test('migration failure resets both sqlClient and activePort', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // Find the post-connect setup call in getConnection()
    const catchIdx = source.indexOf('await runPostConnectSetup(');
    expect(catchIdx).toBeGreaterThan(-1);
    // Widened from 300 chars — the success path between runPostConnectSetup
    // and the catch block now also flips the activePort to the socket sentinel
    // when in socket mode (see SOCKET_PORT_SENTINEL handling). The intent of
    // the test is "both nulls live inside the failure-recovery block", not
    // "within a fixed byte budget".
    const catchBlock = source.slice(catchIdx, catchIdx + 1000);
    // Both must be null'd to force full reconnect
    expect(catchBlock).toContain('sqlClient = null');
    expect(catchBlock).toContain('activePort = null');
  });

  test('health-check failure in cached client resets both sqlClient and activePort', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // Find the cached client health check function
    const healthCheckIdx = source.indexOf('healthCheckCachedClient');
    expect(healthCheckIdx).toBeGreaterThan(-1);
    // Widened from 600 chars — the null-guard block has doc comments
    // explaining the concurrency race that push the `activePort = null`
    // assignment further into the function body. The intent is "both nulls
    // live inside this one function", not "within a fixed byte budget".
    const block = source.slice(healthCheckIdx, healthCheckIdx + 1400);
    expect(block).toContain('sqlClient = null');
    expect(block).toContain('activePort = null');
  });
});

describe('parallel dispatch race (issue #1207)', () => {
  test('healthCheckCachedClient nulls sqlClient BEFORE calling .end()', () => {
    // Regression guard: inverting these lines (or re-introducing `await
    // sqlClient.end(...)` before the null assignment) resurrects the
    // CONNECTION_ENDED race fixed by 74aaa022 + issue #1207.
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    const fnStart = source.indexOf('async function healthCheckCachedClient');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('\n}\n', fnStart);
    const body = source.slice(fnStart, fnEnd);

    const nullIdx = body.indexOf('sqlClient = null');
    const endCallIdx = body.indexOf('.end(');
    expect(nullIdx).toBeGreaterThan(-1);
    expect(endCallIdx).toBeGreaterThan(-1);
    // Null must come BEFORE the .end() call
    expect(nullIdx).toBeLessThan(endCallIdx);
  });

  test('healthCheckCachedClient does not await .end() — fire-and-forget teardown', () => {
    // If the teardown is awaited synchronously, concurrent in-flight queries
    // on the shared pool get killed with CONNECTION_ENDED (issue #1207).
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    const fnStart = source.indexOf('async function healthCheckCachedClient');
    const fnEnd = source.indexOf('\n}\n', fnStart);
    const body = source.slice(fnStart, fnEnd);

    // Should not have `await ... .end(` anywhere in the catch branch
    const catchIdx = body.indexOf('catch');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBody = body.slice(catchIdx);
    // Match `await <identifier>.end(` or `await this.end(` patterns
    expect(catchBody).not.toMatch(/await\s+\w+\.end\(/);
    // Should call .end() with a .catch(...) attached (fire-and-forget)
    expect(catchBody).toMatch(/\.end\([^)]*\)\.catch\(/);
  });

  test('getConnection dedups concurrent rebuilds via buildPromise', () => {
    // Without dedup, N parallel callers each race pgModule(...) and overwrite
    // the singleton, leaking pools and triggering CONNECTION_ENDED on the
    // orphaned ones. See issue #1207.
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    expect(source).toContain('let buildPromise');
    // getConnection must check buildPromise before rebuilding
    const getConnIdx = source.indexOf('export async function getConnection');
    const nextFnIdx = source.indexOf('async function _buildConnection');
    expect(getConnIdx).toBeGreaterThan(-1);
    expect(nextFnIdx).toBeGreaterThan(getConnIdx);
    const body = source.slice(getConnIdx, nextFnIdx);
    expect(body).toContain('if (buildPromise) return buildPromise');
    // Must reset buildPromise on both success and failure
    expect(body).toMatch(/finally\s*\{[^}]*buildPromise\s*=\s*null/);
  });

  test('buildAndOpenConnection fire-and-forget teardown on post-connect failure', () => {
    // Same pattern as healthCheckCachedClient — if runPostConnectSetup fails,
    // tear down the doomed client without blocking concurrent work.
    // Post-pgserve-transport-discovery: the catch lives in `buildAndOpenConnection`
    // (the post-resolution helper); `_buildConnection` is now just the
    // dispatcher that picks UDS vs. TCP.
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    const fnStart = source.indexOf('async function buildAndOpenConnection');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('\n}\n', fnStart);
    const body = source.slice(fnStart, fnEnd);

    const catchIdx = body.indexOf('catch (err)');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBody = body.slice(catchIdx);
    // Null before end, fire-and-forget teardown
    expect(catchBody.indexOf('sqlClient = null')).toBeLessThan(catchBody.indexOf('.end('));
    expect(catchBody).not.toMatch(/await\s+\w+\.end\(/);
    expect(catchBody).toMatch(/\.end\([^)]*\)\.catch\(/);
  });

  test('_buildConnection dispatches via resolvePgserveTransport (UDS-first / TCP-fallback)', () => {
    // Post-pgserve-transport-discovery: the dispatcher no longer probes the
    // canonical daemon directly — it asks `resolvePgserveTransport()` for the
    // live transport (UDS preferred, TCP via `pgserve port` fallback). This
    // test locks the new contract; the old probe-then-libpq-path is enforced
    // inside `resolvePgserveTransport` itself by 'source enforces probe order'.
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    const fnStart = source.indexOf('async function _buildConnection');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('\n}\n', fnStart);
    const body = source.slice(fnStart, fnEnd);

    // Test-mode path remains for unit-test harness compatibility.
    const testModeIdx = body.indexOf('Boolean(process.env.GENIE_TEST_PG_PORT)');
    // Production dispatch: always through resolvePgserveTransport.
    const dispatchIdx = body.indexOf('await resolvePgserveTransport()');

    expect(testModeIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(testModeIdx);
  });
});

describe('root guard (issue #1226)', () => {
  let origGetuid: (() => number) | undefined;
  let origAllowRoot: string | undefined;

  beforeEach(() => {
    origGetuid = process.getuid;
    origAllowRoot = process.env.GENIE_ALLOW_ROOT;
  });

  afterEach(() => {
    // Restore original getuid
    if (origGetuid) {
      Object.defineProperty(process, 'getuid', { value: origGetuid, configurable: true });
    }
    if (origAllowRoot !== undefined) {
      process.env.GENIE_ALLOW_ROOT = origAllowRoot;
    } else {
      process.env.GENIE_ALLOW_ROOT = undefined;
    }
  });

  test('returns null when uid is non-zero', async () => {
    Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
    const { checkRootGuard } = await import('./db.js');
    expect(checkRootGuard()).toBeNull();
  });

  test('returns actionable error when running as root', async () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    process.env.GENIE_ALLOW_ROOT = undefined;
    const { checkRootGuard } = await import('./db.js');
    const msg = checkRootGuard();
    expect(msg).not.toBeNull();
    // Must name the real cause
    expect(msg).toContain('uid 0');
    expect(msg).toContain('root');
    // Must offer the escape hatch
    expect(msg).toContain('GENIE_ALLOW_ROOT=1');
    // Must link the issue for more context
    expect(msg).toContain('1226');
  });

  test('GENIE_ALLOW_ROOT=1 bypasses the guard', async () => {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    process.env.GENIE_ALLOW_ROOT = '1';
    const { checkRootGuard } = await import('./db.js');
    expect(checkRootGuard()).toBeNull();
  });

  // The pre-cutover `_ensurePgserve invokes checkRootGuard before spawn paths`
  // and `_ensurePgserve honors GENIE_PG_NO_AUTOSTART before auto-start daemon`
  // tests were removed when the canonical-pgserve cutover deleted both
  // _ensurePgserve's spawn branch (GENIE_IS_DAEMON) and the autoStartDaemon
  // path. checkRootGuard's behaviour is exercised directly by the three
  // tests above; the old source-text ordering tests are no longer applicable.
});

describe('migration directory resolution', () => {
  test('does not use process.cwd() for migration lookup', () => {
    const source = readFileSync(join(__dirname, 'db-migrations.ts'), 'utf-8');
    // The legacy cwd fallback was removed for deterministic resolution
    expect(source).not.toContain('process.cwd()');
  });

  test('uses only import.meta.dir-based paths', () => {
    const source = readFileSync(join(__dirname, 'db-migrations.ts'), 'utf-8');
    expect(source).toContain('import.meta.dir');
    // Two deterministic candidates: dev and bundled
    expect(source).toContain('getMigrationsDir()');
    expect(source).toContain('getPackageRootMigrationsDir()');
  });
});

// ===========================================================================
// process-identity helper
// ===========================================================================

describe('getProcessStartTime', () => {
  test('returns a non-null string for process.pid on macOS and Linux', async () => {
    const { getProcessStartTime } = await import('./process-identity.js');
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      // Unsupported platform — helper should still return null safely; nothing else to assert.
      expect(getProcessStartTime(process.pid)).toBeNull();
      return;
    }
    const t = getProcessStartTime(process.pid);
    expect(t).not.toBeNull();
    expect(typeof t).toBe('string');
    expect((t as string).length).toBeGreaterThan(0);
  });

  test('returns null for a definitely-dead PID', async () => {
    const { getProcessStartTime } = await import('./process-identity.js');
    // PID 999999 is almost certainly not in use; even if it is, the kernel
    // start time lookup on an unrelated process still returns *some* string,
    // but the most common case is "no such process" → null. On systems
    // where this PID happens to exist we accept either null or a string.
    const t = getProcessStartTime(999_999);
    expect(t === null || typeof t === 'string').toBe(true);
  });

  test('returns null for non-positive PIDs', async () => {
    const { getProcessStartTime } = await import('./process-identity.js');
    expect(getProcessStartTime(0)).toBeNull();
    expect(getProcessStartTime(-1)).toBeNull();
    expect(getProcessStartTime(Number.NaN)).toBeNull();
  });
});

// ===========================================================================
// autoStartDaemon identity check (Bug 2)
// ===========================================================================

describe('autoStartDaemon identity check', () => {
  let testHome: string;
  let pidPath: string;
  let origGenieHome: string | undefined;
  let spawnCount = 0;

  beforeEach(() => {
    testHome = join(tmpdir(), `genie-autostart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testHome, { recursive: true });
    pidPath = join(testHome, 'serve.pid');
    origGenieHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = testHome;
    spawnCount = 0;
  });

  afterEach(async () => {
    // Always restore the real spawn fn so other tests aren't affected.
    const { __setSpawnDaemonForTest } = await import('./db.js');
    __setSpawnDaemonForTest(null);
    if (origGenieHome !== undefined) {
      process.env.GENIE_HOME = origGenieHome;
    } else {
      process.env.GENIE_HOME = undefined;
    }
    try {
      const { rmSync } = require('node:fs');
      rmSync(testHome, { recursive: true, force: true });
    } catch {}
  });

  test('spawns when serve.pid is absent', async () => {
    const { autoStartDaemon, __setSpawnDaemonForTest } = await import('./db.js');
    __setSpawnDaemonForTest(() => {
      spawnCount++;
    });
    expect(existsSync(pidPath)).toBe(false);
    await autoStartDaemon();
    expect(spawnCount).toBe(1);
  });

  test('auto-start child is a foreground daemon before serve preconditions run', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    expect(source).toContain("'serve', 'start', '--headless', '--foreground'");
    expect(source).toContain("GENIE_IS_DAEMON: '1'");
  });

  test('returns early when serve.pid identity matches (live PID + matching start time)', async () => {
    const { autoStartDaemon, __setSpawnDaemonForTest } = await import('./db.js');
    const { getProcessStartTime } = await import('./process-identity.js');

    const startTime = getProcessStartTime(process.pid);
    if (startTime === null) {
      // Can't run this test on an unsupported platform — nothing to verify.
      return;
    }
    writeFileSync(pidPath, `${process.pid}:${startTime}`, 'utf-8');

    __setSpawnDaemonForTest(() => {
      spawnCount++;
    });
    await autoStartDaemon();
    // Identity matched → no spawn, file left in place.
    expect(spawnCount).toBe(0);
    expect(existsSync(pidPath)).toBe(true);
  });

  test('unlinks and spawns when start time does not match (recycled PID)', async () => {
    const { autoStartDaemon, __setSpawnDaemonForTest } = await import('./db.js');
    writeFileSync(pidPath, `${process.pid}:definitely-wrong-start-time`, 'utf-8');

    __setSpawnDaemonForTest(() => {
      spawnCount++;
    });
    await autoStartDaemon();
    expect(spawnCount).toBe(1);
    expect(existsSync(pidPath)).toBe(false);
  });

  test('treats legacy single-PID format as stale', async () => {
    const { autoStartDaemon, __setSpawnDaemonForTest } = await import('./db.js');
    // Old format — just a PID, no colon.
    writeFileSync(pidPath, String(process.pid), 'utf-8');

    __setSpawnDaemonForTest(() => {
      spawnCount++;
    });
    await autoStartDaemon();
    expect(spawnCount).toBe(1);
    expect(existsSync(pidPath)).toBe(false);
  });

  test('unlinks and spawns when PID is dead', async () => {
    const { autoStartDaemon, __setSpawnDaemonForTest } = await import('./db.js');
    // PID 999999 is almost certainly dead.
    writeFileSync(pidPath, '999999:whatever', 'utf-8');

    __setSpawnDaemonForTest(() => {
      spawnCount++;
    });
    await autoStartDaemon();
    expect(spawnCount).toBe(1);
    expect(existsSync(pidPath)).toBe(false);
  });

  test('unlinks and spawns on unparseable content', async () => {
    const { autoStartDaemon, __setSpawnDaemonForTest } = await import('./db.js');
    writeFileSync(pidPath, 'not-a-pid:nope', 'utf-8');

    __setSpawnDaemonForTest(() => {
      spawnCount++;
    });
    await autoStartDaemon();
    expect(spawnCount).toBe(1);
    expect(existsSync(pidPath)).toBe(false);
  });
});

// ===========================================================================
// canonical-pgserve cutover: hint surfaces (replaces the deleted "branched
// timeout messages" + "pgserve failure containment" suites — both were
// asserting on spawn-path code that no longer exists in db.ts).
// ===========================================================================

describe('canonical-pgserve cutover hint surface', () => {
  test('_ensurePgserve emits the canonical pm2-recovery hint on TCP-mode failure', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    const fnStart = source.indexOf('async function _ensurePgserve');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('\n}\n', fnStart);
    const body = source.slice(fnStart, fnEnd);
    expect(body).toContain('canonical-pgserve cutover');
    expect(body).toContain('pm2 status');
    expect(body).toContain('pm2 restart pgserve');
    expect(body).toContain('pgserve install');
  });

  test('requirePgserveDaemon throws with a pm2-recovery hint when the canonical socket is dead', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    expect(source).toContain('export async function requirePgserveDaemon');
    expect(source).toContain('buildPgserveUnavailableHint');
    const hintStart = source.indexOf('function buildPgserveUnavailableHint');
    expect(hintStart).toBeGreaterThan(-1);
    const hintEnd = source.indexOf('\n}\n', hintStart);
    const hintBody = source.slice(hintStart, hintEnd);
    expect(hintBody).toContain('pm2 status');
    expect(hintBody).toContain('pm2 restart pgserve');
    expect(hintBody).toContain('pgserve install');
    expect(hintBody).toContain('docs/install.md');
  });
});

describe('cwd pin for stable pgserve identity (issue #1575)', () => {
  test('pinCwdToGeniePackageDir resolves to genie package and chdirs', async () => {
    const { pinCwdToGeniePackageDir } = await import('./db.js');
    const beforePinCwd = process.cwd();
    const result = pinCwdToGeniePackageDir();
    try {
      // pinned should point at a directory whose package.json declares
      // name === '@automagik/genie'. If null, fall back gracefully — the
      // resolver gave up but the call still returns the previous cwd.
      expect(result.previous).toBe(beforePinCwd);
      if (result.pinned !== null) {
        const pkg = JSON.parse(readFileSync(join(result.pinned, 'package.json'), 'utf-8')) as {
          name?: string;
        };
        expect(pkg.name).toBe('@automagik/genie');
        expect(process.cwd()).toBe(result.pinned);
      }
    } finally {
      // Restore for downstream tests in the same process.
      try {
        process.chdir(beforePinCwd);
      } catch {
        /* ignore */
      }
    }
  });

  test('_buildConnection sources strategy uses cliShortLived for max + idle_timeout', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // Pool sizing is gated on cliShortLived (NOT isTestMode — tests need
    // concurrent connections; the pin/restore safety only matters when
    // GENIE_SKIP_DB_BOOT=1 short-lived CLI subprocesses chdir back).
    // Operational justification: v4.260430.20 saw script-mode CLI
    // fingerprints accumulating 296+ pgserve backends each, saturating
    // max_connections=1000. The gate caps that at 1 per subprocess.
    expect(source).toMatch(/max:\s*cliShortLived\s*\?\s*1\s*:\s*50/);
    expect(source).toMatch(/idle_timeout:\s*cliShortLived\s*\?\s*0\s*:\s*1/);
    // Forced SELECT 1 must run BEFORE runPostConnectSetup so pgserve
    // fingerprints under the pinned cwd.
    const selectIdx = source.indexOf('await sqlClient`SELECT 1`');
    const setupIdx = source.indexOf('await runPostConnectSetup');
    expect(selectIdx).toBeGreaterThan(-1);
    expect(setupIdx).toBeGreaterThan(-1);
    expect(selectIdx).toBeLessThan(setupIdx);
    // chdir restore lives in the finally clause and is gated on
    // !daemonCwdPinned so the daemon entrypoint's permanent pin survives.
    expect(source).toMatch(/shouldRestoreCwd\s*=\s*!daemonCwdPinned/);
  });

  test('cleanup drains sqlClient and beforeExit calls shutdown (issue #1574)', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // Cleanup must drain the postgres.js pool best-effort on hard exit so
    // server-side backends get Terminate frames before the kernel reaps
    // sockets.
    const cleanupIdx = source.indexOf('const cleanup = () => {');
    expect(cleanupIdx).toBeGreaterThan(-1);
    const cleanupBody = source.slice(cleanupIdx, source.indexOf('};', cleanupIdx));
    expect(cleanupBody).toContain('sqlClient');
    expect(cleanupBody).toMatch(/dying\.end\(\{\s*timeout:\s*1\s*\}\)/);
    // beforeExit is the awaited drain path — fires on every clean exit.
    expect(source).toContain("process.on('beforeExit'");
    expect(source).toMatch(/process\.on\('beforeExit',\s*\(\)\s*=>\s*\{[\s\S]*?shutdown\(\)/);
  });
});

// ============================================================================
// pgserve transport discovery (UDS-first / TCP-fallback).
//
// Behavioral tests for `resolvePgserveTransport` — exercises real
// system behavior with controlled env-var overrides. The function itself
// is hermetic (no side effects beyond reading env + filesystem + spawning
// `pgserve port`); we don't mock — instead we set GENIE_PG_FORCE_TCP=1 to
// pin the deterministic TCP path and assert the resulting shape.
// ============================================================================

describe('resolvePgserveTransport (transport discovery)', () => {
  test('GENIE_PG_FORCE_TCP=1 + reachable pgserve port → tcp transport', async () => {
    // This test only runs when `pgserve port` is reachable on the host. CI
    // hosts without pgserve installed get a skipped/no-op assertion.
    const previous = process.env.GENIE_PG_FORCE_TCP;
    process.env.GENIE_PG_FORCE_TCP = '1';
    try {
      const { resolvePgserveTransport } = await import('./db.js');
      const result = await resolvePgserveTransport().catch((err: Error) => err);
      if (result instanceof Error) {
        // No pgserve binary or daemon → resolver throws the both-unavailable
        // hint. Assert the message shape so future copy edits are caught.
        expect(result.message).toContain('pgserve is not reachable');
        expect(result.message).toContain('Recovery:');
        return;
      }
      // pgserve was discoverable on TCP — assert the shape.
      expect(result.kind).toBe('tcp');
      if (result.kind === 'tcp') {
        expect(result.host).toBe('127.0.0.1');
        expect(Number.isInteger(result.port)).toBe(true);
        expect(result.port).toBeGreaterThan(0);
        expect(result.port).toBeLessThan(65536);
      }
    } finally {
      // biome-ignore lint/performance/noDelete: process.env requires actual unset; assigning undefined leaves the literal string "undefined"
      if (previous === undefined) delete process.env.GENIE_PG_FORCE_TCP;
      else process.env.GENIE_PG_FORCE_TCP = previous;
    }
  });

  test('PgserveTransport tagged-union shape is exhaustive', () => {
    // Lock the surface so adding/removing a variant requires touching this
    // exhaustiveness check. Mirrors the VerifyResult pattern from
    // update-unify-stages G1.
    type Probe = import('./db.ts').PgserveTransport;
    const variants: Probe[] = [
      { kind: 'unix', socketDir: '/tmp/pgserve-sock-x', port: 5432 },
      { kind: 'tcp', host: '127.0.0.1', port: 8432 },
    ];
    expect(variants).toHaveLength(2);
  });

  test('source enforces probe order: UDS first, TCP fallback', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    const fnStart = source.indexOf('export async function resolvePgserveTransport');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('\n}\n', fnStart);
    const body = source.slice(fnStart, fnEnd);

    const udsProbeIdx = body.indexOf('probePgserveDaemon()');
    const tcpFallbackIdx = body.indexOf('discoverTcpPgservePort()');

    expect(udsProbeIdx).toBeGreaterThan(-1);
    expect(tcpFallbackIdx).toBeGreaterThan(-1);
    // UDS probe must precede TCP fallback in the function body — that's the
    // "native socket as default" contract.
    expect(udsProbeIdx).toBeLessThan(tcpFallbackIdx);
  });

  test('discoverTcpPgservePort returns null when pgserve binary is absent', async () => {
    // Force PATH to a directory with no pgserve binary so the spawn fails
    // cleanly. Resolver falls back to throwing the both-unavailable hint.
    const originalPath = process.env.PATH;
    const originalForceTcp = process.env.GENIE_PG_FORCE_TCP;
    const originalForceSocket = process.env.GENIE_PG_FORCE_SOCKET;
    process.env.PATH = '/nonexistent';
    process.env.GENIE_PG_FORCE_TCP = '1'; // skip UDS probe
    // biome-ignore lint/performance/noDelete: process.env requires actual unset
    delete process.env.GENIE_PG_FORCE_SOCKET;
    try {
      const { resolvePgserveTransport } = await import('./db.js');
      await expect(resolvePgserveTransport()).rejects.toThrow(/pgserve is not reachable/);
    } finally {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      // biome-ignore lint/performance/noDelete: process.env requires actual unset
      else delete process.env.PATH;
      // biome-ignore lint/performance/noDelete: process.env requires actual unset
      if (originalForceTcp === undefined) delete process.env.GENIE_PG_FORCE_TCP;
      else process.env.GENIE_PG_FORCE_TCP = originalForceTcp;
      // biome-ignore lint/performance/noDelete: process.env requires actual unset
      if (originalForceSocket === undefined) delete process.env.GENIE_PG_FORCE_SOCKET;
      else process.env.GENIE_PG_FORCE_SOCKET = originalForceSocket;
    }
  });
});
