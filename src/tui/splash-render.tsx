/** @jsxImportSource @opentui/react */
/**
 * Standalone renderer for the install/startup splash. Self-contained —
 * no imports from the rest of the (currently broken) src/tui graph.
 *
 * Lifecycle / config rationale:
 *   - On macOS we set `useThread: false` + low FPS caps as a workaround
 *     for opentui 0.2.0's native render-loop hot-spin. Removing those
 *     pushes a CPU to 70%+.
 *   - `exitOnCtrlC: true` lets users ^C out without us implementing a
 *     keyboard handler in the splash.
 *   - Freeze mode further lowers FPS so a held static frame doesn't sit
 *     at 30 fps redrawing the same buffer.
 */

import type { CliRendererConfig } from '@opentui/core';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { GenieSplash } from './components/GenieSplash.js';

export interface RenderSplashOptions {
  /** Total animation duration in ms. Default 1600. */
  duration?: number;
  /** Hold the final frame this long before exiting. Default 400. */
  holdMs?: number;
  /** Pin progress to a single value (0..1) and skip the animation entirely. */
  freezeAt?: number;
}

function buildRendererConfig(isFrozen: boolean): CliRendererConfig {
  const isDarwin = process.platform === 'darwin';
  return {
    exitOnCtrlC: true,
    useThread: !isDarwin,
    targetFps: isFrozen ? 1 : isDarwin ? 8 : 30,
    maxFps: isFrozen ? 4 : isDarwin ? 12 : 60,
    consoleMode: 'disabled',
    openConsoleOnError: false,
  };
}

export async function renderSplash(options: RenderSplashOptions = {}): Promise<void> {
  const duration = options.duration ?? 1600;
  const holdMs = options.holdMs ?? 400;
  const freezeAt = options.freezeAt;
  const isFrozen = typeof freezeAt === 'number';

  const renderer = await createCliRenderer(buildRendererConfig(isFrozen));

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      renderer.destroy();
    };

    (renderer as unknown as { once: (event: string, fn: () => void) => void }).once('destroy', () => {
      resolve();
    });

    if (isFrozen) {
      createRoot(renderer).render(<GenieSplash progress={freezeAt} />);
      return;
    }

    createRoot(renderer).render(
      <GenieSplash
        duration={duration}
        onComplete={() => {
          setTimeout(finish, holdMs);
        }}
      />,
    );
  });
}
