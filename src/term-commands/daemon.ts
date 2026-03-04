/**
 * Daemon command - Manage beads daemon
 *
 * Usage:
 *   genie daemon start      - Start beads daemon (auto-commit, auto-sync)
 *   genie daemon stop       - Stop beads daemon
 *   genie daemon status     - Show daemon status
 *   genie daemon restart    - Restart daemon
 *
 * Options:
 *   --auto-commit         - Enable auto-commit (default: true for start)
 *   --auto-push           - Enable auto-push to remote
 *   --json                - Output as JSON
 */

import * as beadsRegistry from '../lib/beads-registry.js';

// ============================================================================
// Types
// ============================================================================

export interface DaemonStartOptions {
  autoCommit?: boolean;
  autoPush?: boolean;
}

export interface DaemonStatusOptions {
  json?: boolean;
}

// ============================================================================
// Commands
// ============================================================================

/**
 * Start the beads daemon
 */
export async function startCommand(options: DaemonStartOptions = {}): Promise<void> {
  try {
    // Check if already running
    const status = await beadsRegistry.checkDaemonStatus();
    if (status.running) {
      console.log('ℹ️  Daemon is already running');
      if (status.pid) {
        console.log(`   PID: ${status.pid}`);
      }
      return;
    }

    console.log('🚀 Starting beads daemon...');
    const started = await beadsRegistry.startDaemon({
      autoCommit: options.autoCommit !== false, // Default to true
      autoPush: options.autoPush,
    });

    if (started) {
      console.log('   ✅ Daemon started');

      // Show updated status
      const newStatus = await beadsRegistry.checkDaemonStatus();
      if (newStatus.pid) {
        console.log(`   PID: ${newStatus.pid}`);
      }
      if (newStatus.autoCommit) {
        console.log('   Auto-commit: enabled');
      }
      if (newStatus.autoPush) {
        console.log('   Auto-push: enabled');
      }
    } else {
      console.error('❌ Failed to start daemon');
      console.log('   Check `bd daemon status` for details');
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    process.exit(1);
  }
}

/**
 * Stop the beads daemon
 */
export async function stopCommand(): Promise<void> {
  try {
    // Check if running
    const status = await beadsRegistry.checkDaemonStatus();
    if (!status.running) {
      console.log('ℹ️  Daemon is not running');
      return;
    }

    console.log('🛑 Stopping beads daemon...');
    const stopped = await beadsRegistry.stopDaemon();

    if (stopped) {
      console.log('   ✅ Daemon stopped');
    } else {
      console.error('❌ Failed to stop daemon');
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    process.exit(1);
  }
}

/**
 * Show daemon status
 */
function printDaemonStatus(status: Awaited<ReturnType<typeof beadsRegistry.checkDaemonStatus>>): void {
  console.log('Beads Daemon Status');
  console.log('───────────────────');
  console.log(`Running: ${status.running ? '✅ yes' : '❌ no'}`);

  if (!status.running) {
    console.log('\nRun `genie daemon start` to start the daemon');
    return;
  }

  if (status.pid) console.log(`PID: ${status.pid}`);
  if (status.lastSync) console.log(`Last sync: ${status.lastSync}`);
  if (status.autoCommit !== undefined) console.log(`Auto-commit: ${status.autoCommit ? 'enabled' : 'disabled'}`);
  if (status.autoPush !== undefined) console.log(`Auto-push: ${status.autoPush ? 'enabled' : 'disabled'}`);
}

export async function statusCommand(options: DaemonStatusOptions = {}): Promise<void> {
  try {
    const status = await beadsRegistry.checkDaemonStatus();

    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }

    printDaemonStatus(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    process.exit(1);
  }
}

/**
 * Restart the beads daemon
 */
export async function restartCommand(options: DaemonStartOptions = {}): Promise<void> {
  try {
    // Check if running and stop
    const status = await beadsRegistry.checkDaemonStatus();
    if (status.running) {
      console.log('🛑 Stopping beads daemon...');
      await beadsRegistry.stopDaemon();
      console.log('   ✅ Stopped');
    }

    // Start with new options
    console.log('🚀 Starting beads daemon...');
    const started = await beadsRegistry.startDaemon({
      autoCommit: options.autoCommit !== false,
      autoPush: options.autoPush,
    });

    if (started) {
      console.log('   ✅ Daemon restarted');
    } else {
      console.error('❌ Failed to restart daemon');
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    process.exit(1);
  }
}
