/**
 * IPC Client — Frontend bridge to the Bun sidecar backend via Tauri.
 *
 * Uses Tauri's native invoke() for commands and listen() for events.
 * The Rust layer proxies all calls to the Bun sidecar over stdin/stdout.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * Invoke a sidecar IPC command and return the result.
 * Proxied through Tauri's ipc_invoke command to the Bun backend.
 */
export async function invoke<T = unknown>(command: string, params?: Record<string, unknown>): Promise<T> {
  return tauriInvoke<T>('ipc_invoke', {
    command,
    params: params ?? {},
  });
}

/**
 * Subscribe to backend events by type. Returns unsubscribe function.
 * Events are emitted by the Rust bridge when the sidecar sends event messages.
 */
export function onEvent(eventType: string, handler: (payload: Record<string, unknown>) => void): () => void {
  let unlistenFn: (() => void) | null = null;
  let cancelled = false;

  listen<Record<string, unknown>>(eventType, (event) => {
    handler(event.payload);
  }).then((fn) => {
    if (cancelled) {
      fn();
    } else {
      unlistenFn = fn;
    }
  });

  return () => {
    cancelled = true;
    unlistenFn?.();
  };
}
