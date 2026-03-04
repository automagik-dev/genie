#!/usr/bin/env bun
/**
 * Watchdog entry point — run in a background tmux pane.
 *
 * Usage: bun src/scripts/watchdog.ts
 */

import { runWatchdogLoop } from '../lib/idle-timeout.js';

console.log('[watchdog] Starting idle timeout watchdog...');
runWatchdogLoop().catch((err) => {
  console.error('[watchdog] Fatal error:', err);
  process.exit(1);
});
