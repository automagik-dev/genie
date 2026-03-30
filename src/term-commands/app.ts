/**
 * genie app — Launch Genie desktop app or backend sidecar.
 *
 * Searches for Tauri binary in PATH and known install locations.
 * Falls back to starting the backend sidecar in IPC mode.
 */

import type { Command } from 'commander';

export function registerAppCommand(program: Command): void {
  program
    .command('app')
    .description('Launch Genie desktop app (backend sidecar + views)')
    .option('--backend-only', 'Start only the backend sidecar (IPC on stdin/stdout)')
    .option('--tui', 'Fall back to terminal UI mode')
    .option('--dev', 'Development mode')
    .action(async (options: { backendOnly?: boolean; tui?: boolean; dev?: boolean }) => {
      if (options.tui) {
        const { isServeRunning, autoStartServe } = await import('./serve.js');
        if (!isServeRunning()) {
          console.log('Starting genie serve...');
          await autoStartServe();
        }
        const { attachTuiSession } = await import('../tui/tmux.js');
        attachTuiSession();
        return;
      }

      if (options.backendOnly) {
        await import('../../packages/genie-app/src-backend/index.js');
        return;
      }

      // Default: try Tauri binary, fallback to sidecar mode
      const { existsSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { execFileSync, execSync } = await import('node:child_process');

      const appName = 'genie-desktop';
      const rootDir = join(dirname(new URL(import.meta.url).pathname), '..', '..');
      const searchPaths = [
        join(rootDir, 'packages', 'genie-app', 'src-tauri', 'target', 'release', appName),
        join(rootDir, 'packages', 'genie-app', 'src-tauri', 'target', 'debug', appName),
        join(rootDir, 'dist', 'app', appName),
        `/usr/local/bin/${appName}`,
      ];

      // Also check PATH
      let inPath = false;
      try {
        execSync(`which ${appName}`, { stdio: 'ignore' });
        inPath = true;
      } catch {
        // Not in PATH
      }

      const tauriBin = searchPaths.find((p) => existsSync(p));

      if (tauriBin || inPath) {
        console.log('\x1b[35m\u25c6 Genie App\x1b[0m Launching desktop...');
        try {
          execFileSync(tauriBin ?? appName, [], { stdio: 'inherit' });
        } catch {
          // Tauri exited or was closed — normal
        }
        return;
      }

      // Fallback: start backend sidecar
      console.log('\x1b[35m\u25c6 Genie App\x1b[0m Starting backend sidecar...');
      console.log('\x1b[2mDesktop binary not found \u2014 running in sidecar mode.\x1b[0m');
      console.log('\x1b[2mPG bridge + PTY manager + IPC on stdin/stdout\x1b[0m');
      console.log('\x1b[2mUse --tui for terminal UI, or pipe to a frontend shell.\x1b[0m\n');
      await import('../../packages/genie-app/src-backend/index.js');
    });
}
