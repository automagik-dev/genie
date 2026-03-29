/**
 * Genie App Backend — Bun sidecar entry point.
 *
 * Starts PG connection, initializes PTY manager, sets up LISTEN/NOTIFY
 * listeners, and exposes IPC command handlers. Handles graceful shutdown.
 */

import { getConnection } from '../../../src/lib/db.js';
import { commands } from './ipc.js';
import * as pgBridge from './pg-bridge.js';
import * as pty from './pty.js';

// ============================================================================
// Lifecycle
// ============================================================================

let shutdownRequested = false;

async function start(): Promise<void> {
  console.log('[genie-app] Starting backend sidecar...');

  // 1. Connect to PG
  await getConnection();
  console.log('[genie-app] PG connected');

  // 2. Set up LISTEN/NOTIFY for real-time updates
  await pgBridge.startListening();
  console.log('[genie-app] PG LISTEN active (executor_state, task_stage, runtime_event)');

  // 3. Wire PTY events to IPC emit
  pty.onPtyData((sessionId, data) => {
    emitToFrontend('pty-data', { sessionId, data });
  });

  pty.onPtyExit((sessionId, code) => {
    emitToFrontend('pty-exit', { sessionId, code });
  });

  // 4. Wire PG bridge events to IPC emit
  pgBridge.onBridgeEvent((event) => {
    emitToFrontend(event.type, event.payload);
  });

  // 5. Listen for IPC commands from stdin (Tauri sidecar protocol)
  listenForCommands();

  console.log('[genie-app] Backend ready');
}

// ============================================================================
// IPC Protocol (stdin/stdout JSON-RPC)
// ============================================================================

/**
 * Emit an event to the Tauri frontend via stdout.
 * Events are JSON-encoded, one per line.
 */
function emitToFrontend(type: string, payload: Record<string, unknown>): void {
  const message = JSON.stringify({ type: 'event', event: type, payload });
  process.stdout.write(`${message}\n`);
}

/**
 * Listen for IPC commands on stdin.
 * Each line is a JSON command: { id, command, params }
 */
function listenForCommands(): void {
  let buffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      void handleCommand(line);
    }
  });

  process.stdin.on('end', () => {
    void shutdown();
  });
}

async function handleCommand(line: string): Promise<void> {
  let id: string | number | undefined;
  try {
    const msg = JSON.parse(line) as { id?: string | number; command: string; params?: unknown };
    id = msg.id;

    const handler = commands[msg.command];
    if (!handler) {
      respond(id, null, `Unknown command: ${msg.command}`);
      return;
    }

    const result = await handler(msg.params as never);
    respond(id, result, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    respond(id, null, message);
  }
}

function respond(id: string | number | undefined, result: unknown, error: string | null): void {
  const message = JSON.stringify({ type: 'response', id, result, error });
  process.stdout.write(`${message}\n`);
}

// ============================================================================
// Shutdown
// ============================================================================

async function shutdown(): Promise<void> {
  if (shutdownRequested) return;
  shutdownRequested = true;

  console.log('[genie-app] Shutting down...');

  // Kill all PTY sessions
  await pty.killAll();

  // Stop PG listeners
  await pgBridge.stopListening();

  console.log('[genie-app] Shutdown complete');
  process.exit(0);
}

// Signal handlers
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

// ============================================================================
// Boot
// ============================================================================

void start().catch((err) => {
  console.error('[genie-app] Fatal error:', err);
  process.exit(1);
});
