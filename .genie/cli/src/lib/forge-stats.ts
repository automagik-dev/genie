/**
 * Forge Statistics Collection
 *
 * Aggregates statistics from Forge backend for dashboard display:
 * - Project counts
 * - Task counts (by status)
 * - Task attempt counts (total + running)
 * - Active execution processes
 */

// @ts-ignore - compiled client shipped at project root
import { ForgeClient } from '../../../../forge.js';

export interface ForgeStats {
  projects: {
    total: number;
  };
  tasks: {
    total: number;
    byStatus: {
      todo: number;
      inprogress: number;
      inreview: number;
      done: number;
      cancelled: number;
    };
  };
  attempts: {
    total: number;
    running: number;
    paused: number;
    completed: number;
    failed: number;
  };
  hasRunningWork: boolean;
}

export async function collectForgeStats(baseUrl: string = 'http://localhost:8887'): Promise<ForgeStats | null> {
  try {
    const client = new ForgeClient(baseUrl, process.env.FORGE_TOKEN);

    // Initialize stats
    const stats: ForgeStats = {
      projects: { total: 0 },
      tasks: {
        total: 0,
        byStatus: {
          todo: 0,
          inprogress: 0,
          inreview: 0,
          done: 0,
          cancelled: 0,
        },
      },
      attempts: {
        total: 0,
        running: 0,
        paused: 0,
        completed: 0,
        failed: 0,
      },
      hasRunningWork: false,
    };

    // Fetch all projects
    const projects = await client.listProjects();
    stats.projects.total = projects.length;

    // Get all task attempts and derive task count
    // Note: Forge 0.3.18 doesn't have project tasks endpoint, derive from attempts
    try {
      const allAttempts = await client.listTaskAttempts();
      stats.attempts.total = allAttempts.length;

      // Derive unique task count from attempts (group by task_id)
      const uniqueTaskIds = new Set(allAttempts.map((a: any) => a.task_id));
      stats.tasks.total = uniqueTaskIds.size;

      // For live status, only check the most recent 5 attempts (keeps dashboard fast)
      const recentAttempts = allAttempts.slice(0, 5);

      for (const attempt of recentAttempts) {
        try {
          // Query execution processes for this attempt
          const processes = await client.listExecutionProcesses(attempt.id, false);

          if (processes && processes.length > 0) {
            // Find the most recent process
            const latestProcess = processes[processes.length - 1];

            // Note: Forge uses 'status' not 'state'
            if (latestProcess.status === 'running') {
              stats.attempts.running++;
              stats.hasRunningWork = true;
            } else if (latestProcess.status === 'paused') {
              stats.attempts.paused++;
            } else if (latestProcess.status === 'failed' || latestProcess.status === 'stopped') {
              stats.attempts.failed++;
            } else if (latestProcess.status === 'completed') {
              stats.attempts.completed++;
            }
          }
        } catch {
          // Skip this attempt if we can't query its processes
        }
      }
    } catch {
      // Failed to fetch attempts - API may not support it in this version
    }

    return stats;
  } catch (error) {
    // Forge is not available or errored
    return null;
  }
}

/**
 * Format stats for dashboard display
 */
export function formatStatsForDashboard(stats: ForgeStats | null): string {
  if (!stats) {
    return '   (Unable to fetch stats)';
  }

  const lines: string[] = [];

  // Projects & Tasks
  lines.push(`   Projects: ${stats.projects.total}`);
  lines.push(`   Tasks: ${stats.tasks.total}`);

  // Attempts breakdown with live indicators
  const attemptParts: string[] = [];

  if (stats.attempts.running > 0) {
    attemptParts.push(`🔴 ${stats.attempts.running} running`);
  }
  if (stats.attempts.paused > 0) {
    attemptParts.push(`⏸️  ${stats.attempts.paused} paused`);
  }
  if (stats.attempts.failed > 0) {
    attemptParts.push(`❌ ${stats.attempts.failed} failed`);
  }
  if (stats.attempts.completed > 0 && stats.attempts.total > 0) {
    attemptParts.push(`✅ ${stats.attempts.completed} done`);
  }

  if (stats.attempts.total > 0) {
    lines.push(`   Attempts: ${stats.attempts.total} total`);
    if (attemptParts.length > 0) {
      attemptParts.forEach(part => lines.push(`      ${part}`));
    }
  } else {
    lines.push(`   Attempts: None active`);
  }

  return lines.join('\n');
}
