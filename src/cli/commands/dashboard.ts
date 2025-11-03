/**
 * Dashboard Command - Real-time terminal stats display
 *
 * MVP Feature Set (from Wish #241):
 * - Card 1: Current Session (live tokens, duration, tasks, project)
 * - Card 2: This Month Overview (tokens, time, tasks, wishes, comparison)
 * - Card 3: Streak & Records (current streak, longest, peak session/day)
 *
 * Features:
 * - Animated token counter
 * - Live session timer
 * - Milestone notifications
 * - Monthly comparison with % indicators
 * - Stats stored in git notes (commit metadata)
 */

import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { runDashboardLive } from './dashboard-live';

/**
 * Dashboard command entry point
 * Delegates to dashboard-live for full feature implementation
 */
export async function runDashboard(
  parsed: ParsedCommand,
  config: GenieConfig,
  paths: Required<ConfigPaths>
): Promise<void> {
  await runDashboardLive(parsed, config, paths);
}
