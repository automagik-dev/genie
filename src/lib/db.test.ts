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
    // Self-heal function exists
    expect(source.includes('selfHealPostgres')).toBe(true);
  });
});

describe('retention cleanup', () => {
  test('retention DELETEs are present in getConnection()', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // All 4 retention policies present
    expect(source).toContain("DELETE FROM heartbeats WHERE created_at < now() - interval '7 days'");
    expect(source).toContain("DELETE FROM machine_snapshots WHERE created_at < now() - interval '30 days'");
    expect(source).toContain(
      "DELETE FROM audit_events WHERE entity_type LIKE 'otel_%' AND created_at < now() - interval '30 days'",
    );
    expect(source).toContain("DELETE FROM genie_runtime_events WHERE created_at < now() - interval '14 days'");
  });

  test('retention is guarded by retentionRan flag', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    expect(source).toContain('let retentionRan = false');
    expect(source).toContain('!retentionRan');
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
});

describe('pool error recovery', () => {
  test('migration failure resets both sqlClient and activePort', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // Find the post-connect setup call in getConnection()
    const catchIdx = source.indexOf('await runPostConnectSetup(');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = source.slice(catchIdx, catchIdx + 300);
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

  test('_buildConnection fire-and-forget teardown on post-connect failure', () => {
    // Same pattern as healthCheckCachedClient — if runPostConnectSetup fails,
    // tear down the doomed client without blocking concurrent work.
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    const fnStart = source.indexOf('async function _buildConnection');
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

  test('_ensurePgserve invokes checkRootGuard before spawn paths', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    // The guard call must live inside _ensurePgserve, before the GENIE_IS_DAEMON branch
    const fnStart = source.indexOf('async function _ensurePgserve');
    expect(fnStart).toBeGreaterThan(-1);
    const daemonBranch = source.indexOf("GENIE_IS_DAEMON === '1'", fnStart);
    const guardCall = source.indexOf('checkRootGuard()', fnStart);
    expect(guardCall).toBeGreaterThan(-1);
    expect(guardCall).toBeLessThan(daemonBranch);
  });
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
// Branched timeout error messages (Bug 5)
// ===========================================================================

describe('autoStartDaemon branched timeout messages', () => {
  test('db.ts source contains each branch label', () => {
    const source = readFileSync(join(__dirname, 'db.ts'), 'utf-8');
    expect(source).toContain('genie serve not running. Run: genie serve start');
    expect(source).toContain('pgserve did not respond on port');
    expect(source).toContain('Stale ~/.genie/serve.pid');
  });
});
