/** @jsxImportSource @opentui/react */
/** OpenTUI React renderer — separated from index.ts to isolate JSX */

import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { App } from './app.js';

export async function renderNav(): Promise<void> {
  const rightPane = process.env.GENIE_TUI_RIGHT || undefined;

  // OpenTUI handles SIGTERM/SIGHUP/SIGINT cleanup automatically
  const renderer = await createCliRenderer({
    exitOnCtrlC: false, // We handle Ctrl+C ourselves via useKeyboard
    useMouse: true,
  });

  createRoot(renderer).render(<App rightPane={rightPane} />);
}
