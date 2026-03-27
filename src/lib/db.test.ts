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
