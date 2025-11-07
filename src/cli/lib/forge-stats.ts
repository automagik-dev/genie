/**
 * Forge Statistics Collection
 *
 * Aggregates statistics from Forge backend for dashboard display:
 * - Project counts
 * - Task counts (by status)
 * - Task attempt counts (total + running)
 * - Active execution processes
 * - Token usage metrics
 */

// @ts-ignore - compiled client shipped at project root
import { getForgeConfig, getMcpConfig } from './service-config.js';
import { ForgeClient } from '../../../src/lib/forge-client.js';
import { TokenMetrics, collectAllTokenMetrics } from './token-tracker.js';

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
  tokens: TokenMetrics;
  hasRunningWork: boolean;
}

export async function collectForgeStats(baseUrl: string = getForgeConfig().baseUrl): Promise<ForgeStats | null> {
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
      tokens: {
        input: 0,
        output: 0,
        cached: 0,
        total: 0,
        costUsd: 0,
        processCount: 0
      },
      hasRunningWork: false,
    };

    // Fetch all projects
    const projects = await client.listProjects();
    stats.projects.total = projects.length;

    // Fetch tasks for each project (proper task count)
    try {
      for (const project of projects) {
        try {
          const tasks = await client.listTasks(project.id);
          stats.tasks.total += tasks.length;

          // Aggregate by status
          for (const task of tasks) {
            const status = task.status?.toLowerCase();
            if (status && status in stats.tasks.byStatus) {
              stats.tasks.byStatus[status as keyof typeof stats.tasks.byStatus]++;
            }
          }
        } catch {
          // Skip project if we can't fetch tasks
        }
      }
    } catch {
      // Failed to fetch tasks
    }

    // Get all task attempts for execution status
    try {
      const allAttempts = await client.listTaskAttempts();
      stats.attempts.total = allAttempts.length;

      // For live status, check recent attempts (balance between accuracy and speed)
      // Check up to 15 attempts to get better distribution
      const recentAttempts = allAttempts.slice(0, 15);

      for (const attempt of recentAttempts) {
        try {
          // Query execution processes for this attempt
          const processes = await client.listExecutionProcesses(attempt.id, false);

          if (processes && processes.length > 0) {
            // Find the most recent process
            const latestProcess = processes[processes.length - 1];

            // Note: Forge uses 'status' not 'state'
            // Known statuses: running, paused, completed, failed, killed
            if (latestProcess.status === 'running') {
              stats.attempts.running++;
              stats.hasRunningWork = true;
            } else if (latestProcess.status === 'paused') {
              stats.attempts.paused++;
            } else if (latestProcess.status === 'failed' || latestProcess.status === 'killed') {
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

    // Collect token usage metrics
    try {
      stats.tokens = await collectAllTokenMetrics(baseUrl);
    } catch {
      // Failed to collect token metrics - keep defaults (zeros)
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

  // Token usage (compact format)
  if (stats.tokens && stats.tokens.total > 0) {
    const totalK = (stats.tokens.total / 1000).toFixed(1);
    const costDisplay = stats.tokens.costUsd > 0 ? ` ($${stats.tokens.costUsd.toFixed(3)})` : '';
    lines.push(`   Tokens: ${totalK}k total${costDisplay}`);
  }

  return lines.join('\n');
}
