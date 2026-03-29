/**
 * IPC Client — Frontend bridge to the Bun sidecar backend.
 *
 * Sends JSON-RPC commands via the khal-os sidecar channel and returns typed results.
 * Falls back to a global __GENIE_IPC__ bridge injected by the host shell.
 */

let nextId = 1;

interface IpcResponse {
  type: 'response';
  id: number;
  result: unknown;
  error: string | null;
}

type IpcSend = (message: string) => void;
type IpcOnMessage = (handler: (data: IpcResponse) => void) => () => void;

interface IpcBridge {
  send: IpcSend;
  onMessage: IpcOnMessage;
}

declare global {
  var __GENIE_IPC__: IpcBridge | undefined; // eslint-disable-line no-var
}

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

let bridgeInitialized = false;

function ensureBridge(): IpcBridge | null {
  const bridge = globalThis.__GENIE_IPC__;
  if (!bridge) return null;

  if (!bridgeInitialized) {
    bridgeInitialized = true;
    bridge.onMessage((data) => {
      if (data.type !== 'response') return;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.error) {
        entry.reject(new Error(data.error));
      } else {
        entry.resolve(data.result);
      }
    });
  }

  return bridge;
}

/**
 * Subscribe to backend events by type. Returns unsubscribe function.
 */
export function onEvent(eventType: string, handler: (payload: Record<string, unknown>) => void): () => void {
  const bridge = ensureBridge();
  if (!bridge) return () => {};

  return bridge.onMessage((data) => {
    const msg = data as unknown as { type: string; event?: string; payload?: Record<string, unknown> };
    if (msg.type === 'event' && msg.event === eventType && msg.payload) {
      handler(msg.payload);
    }
  });
}

/**
 * Invoke a sidecar IPC command and return the result.
 * Throws if the bridge is not available or the command fails.
 */
export async function invoke<T = unknown>(command: string, params?: Record<string, unknown>): Promise<T> {
  const bridge = ensureBridge();
  if (!bridge) {
    throw new Error(`IPC bridge not available (command: ${command})`);
  }

  const id = nextId++;
  const message = JSON.stringify({ id, command, params: params ?? {} });

  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    bridge.send(message);

    // Timeout after 10s to prevent dangling promises
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`IPC timeout: ${command} (id=${id})`));
      }
    }, 10_000);
  });
}
