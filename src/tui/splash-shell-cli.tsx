/** @jsxImportSource @opentui/react */
/**
 * Demo runner for `<GenieAppShell>`. Mounts a fake "genie boot" app
 * underneath the splash so the overlay/handoff pattern can be previewed
 * end-to-end today, even while the real `<App>` is missing dependencies.
 *
 *   Run: bun run src/tui/splash-shell-cli.tsx
 *        bun run src/tui/splash-shell-cli.tsx --duration 4000
 *        bun run src/tui/splash-shell-cli.tsx --skip-splash    # bypass overlay
 */

import type { CliRendererConfig } from '@opentui/core';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { type ReactNode, useEffect, useState } from 'react';
import { GenieAppShell } from './components/GenieAppShell.js';

interface CliArgs {
  duration?: number;
  skipSplash?: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--duration' || flag === '-d') {
      args.duration = Number.parseInt(value ?? '', 10);
      i++;
    } else if (flag === '--skip-splash') {
      args.skipSplash = true;
    }
  }
  return args;
}

function buildRendererConfig(): CliRendererConfig {
  const isDarwin = process.platform === 'darwin';
  return {
    exitOnCtrlC: true,
    useThread: !isDarwin,
    targetFps: isDarwin ? 8 : 30,
    maxFps: isDarwin ? 12 : 60,
    consoleMode: 'disabled',
    openConsoleOnError: false,
  };
}

/**
 * Stand-in for the real `<App>`. Simulates async genie boot (db init,
 * tmux scan, registry load, etc.) by accumulating "✓ done" lines on a
 * timer. Mirrors what the actual app would be doing during the splash
 * window so the handoff feels realistic in the demo.
 */
function FakeApp(): ReactNode {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const steps = [
      { delay: 80, text: 'pgserve socket bound' },
      { delay: 220, text: 'sqlite migrations applied (3 pending → 0)' },
      { delay: 380, text: 'tmux topology — 1 session, 2 panes' },
      { delay: 540, text: 'agent registry loaded (4 directory entries)' },
      { delay: 700, text: 'mailbox synced (2 unread)' },
      { delay: 880, text: 'OTel receiver listening on :43012' },
      { delay: 1080, text: 'keymap installed' },
      { delay: 1280, text: 'wishes scanned (1 active)' },
      { delay: 1500, text: 'workspace ready' },
    ];
    const timers = steps.map((step) =>
      setTimeout(() => {
        setLines((prev) => [...prev, step.text]);
      }, step.delay),
    );
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  return (
    <box width="100%" height="100%" flexDirection="column" padding={2} backgroundColor="#0a1d2a">
      <text>
        <span fg="#9eddc1">genie</span>
        <span fg="#5e6e74"> · </span>
        <span fg="#c9cfd4">workspace</span>
        <span fg="#5e6e74"> · </span>
        <span fg="#8a9499">/private/tmp/genie-version-fix</span>
      </text>
      <box marginTop={1} flexDirection="column">
        {lines.map((line) => (
          <text key={line}>
            <span fg="#7fc8a9">✓ </span>
            <span fg="#c9cfd4">{line}</span>
          </text>
        ))}
      </box>
      <box marginTop={1}>
        <text>
          <span fg="#5e6e74">─ </span>
          <span fg="#8a9499">{lines.length < 9 ? 'booting...' : 'ready · ^C to exit'}</span>
        </text>
      </box>
    </box>
  );
}

const args = parseArgs(process.argv.slice(2));
const duration = Number.isFinite(args.duration) ? args.duration : 2200;
const skipSplash = args.skipSplash === true;

const renderer = await createCliRenderer(buildRendererConfig());

createRoot(renderer).render(
  <GenieAppShell splashDuration={duration} skipSplash={skipSplash} status="initializing genie...">
    <FakeApp />
  </GenieAppShell>,
);

await new Promise<void>((resolve) => {
  (renderer as unknown as { once: (event: string, fn: () => void) => void }).once('destroy', () => {
    resolve();
  });
});
process.exit(0);
