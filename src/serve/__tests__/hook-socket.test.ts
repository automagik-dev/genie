/**
 * hook-socket smoke tests — listener lifecycle + roundtrip + frame protocol.
 *
 * These tests don't depend on PG. They verify:
 *   - The server starts on a fresh path and accepts a length-prefixed frame.
 *   - dispatch() runs in-process and the reply is framed back.
 *   - stop() unlinks the socket file.
 *   - A stale socket file (no listener) is auto-removed on next start.
 *   - A live socket cannot be re-claimed (refuses to start a second listener).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHookSocket } from '../hook-socket.js';

let socketPath: string;

beforeEach(() => {
  // Each test gets its own socket path; isolated even on parallel runs.
  socketPath = join(
    tmpdir(),
    `genie-hook-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
  );
  process.env.GENIE_HOOK_SOCK = socketPath;
});

afterEach(() => {
  process.env.GENIE_HOOK_SOCK = undefined;
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // best effort
    }
  }
});

function frame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function readFrame(socket: import('node:net').Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let length = -1;
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (length === -1 && received >= 4) {
        const buf = Buffer.concat(chunks, received);
        length = buf.readUInt32BE(0);
        if (length === 0) {
          resolve('');
          socket.destroy();
          return;
        }
      }
      if (length >= 0 && received >= 4 + length) {
        const buf = Buffer.concat(chunks, received);
        resolve(buf.subarray(4, 4 + length).toString('utf-8'));
        socket.destroy();
      }
    });
    socket.on('error', reject);
    socket.on('end', () => {
      if (length === -1) reject(new Error('socket closed before frame header'));
    });
  });
}

async function sendFrameAndReadReply(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    client.on('connect', () => {
      client.write(frame(payload));
      readFrame(client).then(resolve, reject);
    });
    client.on('error', reject);
  });
}

test('listener accepts a roundtrip and unlinks on stop', async () => {
  const handle = await startHookSocket();
  expect(handle.path).toBe(socketPath);
  expect(existsSync(socketPath)).toBe(true);

  // Send a payload that dispatch() will reject as missing hook_event_name —
  // contract guarantees an empty reply (allow) for malformed payloads, so we
  // just verify the framing roundtrip works end-to-end.
  const reply = await sendFrameAndReadReply(JSON.stringify({ malformed: true }));
  expect(reply).toBe('');

  await handle.stop();
  expect(existsSync(socketPath)).toBe(false);
});

test('stop() is idempotent', async () => {
  const handle = await startHookSocket();
  await handle.stop();
  await handle.stop(); // must not throw
  expect(existsSync(socketPath)).toBe(false);
});

test('stale socket file is removed on start', async () => {
  // Simulate a leftover from an unclean shutdown: a regular file at the path
  // (not a real listening socket).
  writeFileSync(socketPath, '');
  expect(existsSync(socketPath)).toBe(true);

  const handle = await startHookSocket();
  expect(existsSync(socketPath)).toBe(true);
  await handle.stop();
  expect(existsSync(socketPath)).toBe(false);
});

test('refuses to start when a live listener already owns the socket', async () => {
  const first = await startHookSocket();
  await expect(startHookSocket()).rejects.toThrow(/already live/);
  await first.stop();
});

test('zero-length frame is replied to with zero-length frame', async () => {
  const handle = await startHookSocket();
  // Empty payload — dispatch() returns empty for invalid JSON.
  const reply = await sendFrameAndReadReply('');
  expect(reply).toBe('');
  await handle.stop();
});
