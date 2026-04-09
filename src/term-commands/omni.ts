/**
 * Omni Commands — deprecated
 *
 * Legacy bridge management commands have been removed. The NATS bridge service
 * is now managed exclusively by `genie serve`. Query bridge health via `genie doctor`.
 */

import type { Command } from 'commander';

export function registerOmniCommands(program: Command): void {
  // Omni commands are deprecated and no longer registered.
  // Bridge is managed exclusively by genie serve.
}
