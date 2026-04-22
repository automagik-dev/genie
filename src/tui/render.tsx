/** @jsxImportSource @opentui/react */
/** OpenTUI React renderer — separated from index.ts to isolate JSX */

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { App } from './app.js';

export async function renderNav(): Promise<void> {
  const rightPane = process.env.GENIE_TUI_RIGHT || undefined;
  const workspaceRoot = process.env.GENIE_TUI_WORKSPACE || undefined;
  const initialAgent = process.env.GENIE_TUI_AGENT || undefined;

  // OpenTUI handles SIGTERM/SIGHUP/SIGINT cleanup automatically.
  // useThread:false on darwin — the native render pthread's __ulock_wait2 predicate
  // doesn't settle on local Warp ptys (spins at ~101% CPU; SIGTERM ignored because
  // the JS thread is blocked on the FFI lock). Linux already defaults to false.
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, // We handle Ctrl+C ourselves via useKeyboard
    useMouse: true,
    useThread: process.platform !== 'darwin',
  });

  createRoot(renderer).render(<App rightPane={rightPane} workspaceRoot={workspaceRoot} initialAgent={initialAgent} />);

  // Keep process alive until renderer is destroyed (Ctrl+Q, SIGTERM, etc.)
  // Without this, bun exits immediately after render() returns.
  await new Promise<void>((resolve) => {
    (renderer as unknown as { once: (event: string, fn: () => void) => void }).once('destroy', resolve);
  });
}
