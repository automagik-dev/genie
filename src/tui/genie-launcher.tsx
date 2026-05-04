/** @jsxImportSource @opentui/react */
/**
 * Launcher: shows the splash, then execs the real `genie` binary.
 *
 *   bun run src/tui/genie-launcher.tsx          # splash → genie (no args)
 *   bun run src/tui/genie-launcher.tsx ls       # splash → genie ls
 *   bun run src/tui/genie-launcher.tsx --duration 1500 -- ls
 *
 * Notes:
 *   - This is a stop-gap. The proper integration wraps `<App>` in
 *     `<GenieAppShell>` inside `src/tui/render.tsx` so the splash
 *     overlays opentui from frame 0 and dismisses when the TUI is
 *     truly ready. That cleanly hides ALL of genie's boot. This
 *     launcher only hides the very first ~2 s; genie's later boot
 *     work is still visible after exec.
 *   - When the splash unmounts, opentui restores the main terminal,
 *     then `genie` opens its own alternate screen. There may be a
 *     brief frame of "main terminal" between the two.
 *   - Set GENIE_NO_SPLASH=1 to skip the splash entirely (drops to a
 *     direct exec of genie).
 *
 * Suggested alias for daily use:
 *
 *   alias genie='bun run /private/tmp/genie-version-fix/src/tui/genie-launcher.tsx --'
 */

import { spawn } from 'node:child_process';
import type { CliRendererConfig } from '@opentui/core';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { GenieSplash } from './components/GenieSplash.js';

interface LauncherArgs {
  duration: number;
  passthroughArgs: string[];
  skipSplash: boolean;
}

function parseLauncherArgs(argv: readonly string[]): LauncherArgs {
  let duration = 1800;
  let skipSplash = process.env.GENIE_NO_SPLASH === '1';
  const passthroughArgs: string[] = [];
  let inPassthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (inPassthrough) {
      if (flag !== undefined) passthroughArgs.push(flag);
      continue;
    }
    if (flag === '--') {
      inPassthrough = true;
      continue;
    }
    if (flag === '--duration' || flag === '-d') {
      const value = argv[i + 1];
      const parsed = Number.parseInt(value ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) duration = parsed;
      i++;
      continue;
    }
    if (flag === '--no-splash') {
      skipSplash = true;
      continue;
    }
    // Treat anything we don't recognize as a passthrough arg.
    if (flag !== undefined) passthroughArgs.push(flag);
  }
  return { duration, passthroughArgs, skipSplash };
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

async function showSplash(duration: number): Promise<void> {
  const renderer = await createCliRenderer(buildRendererConfig());
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
    createRoot(renderer).render(
      <GenieSplash
        duration={duration}
        status="initializing genie..."
        onComplete={() => {
          // No hold — exec genie immediately so the visible gap between
          // splash teardown and genie boot is as short as possible.
          finish();
        }}
      />,
    );
  });
}

function execGenie(args: readonly string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn('genie', args, {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      process.stderr.write(`genie launcher: failed to exec genie — ${err.message}\n`);
      resolve(127);
    });
  });
}

const args = parseLauncherArgs(process.argv.slice(2));

if (!args.skipSplash) {
  await showSplash(args.duration);
}

const exitCode = await execGenie(args.passthroughArgs);
process.exit(exitCode);
