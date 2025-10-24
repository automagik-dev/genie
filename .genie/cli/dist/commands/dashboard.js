"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDashboard = runDashboard;
const dashboard_live_1 = require("./dashboard-live");
/**
 * Dashboard command entry point
 * Delegates to dashboard-live for full feature implementation
 */
async function runDashboard(parsed, config, paths) {
    await (0, dashboard_live_1.runDashboardLive)(parsed, config, paths);
}
