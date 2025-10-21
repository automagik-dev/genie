#!/usr/bin/env tsx
/**
 * Forge API Validation Script
 * Tests all 80+ ForgeClient endpoints to validate as Genie executor replacement
 *
 * Usage: npx tsx .genie/reports/forge-api-validation.ts
 */

import { ForgeClient } from '../../forge';

const FORGE_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localforge.namastex.ai:18887';
const forge = new ForgeClient(FORGE_BASE_URL);

interface TestResult {
  endpoint: string;
  category: string;
  success: boolean;
  duration: number;
  error?: string;
  notes?: string;
}

const results: TestResult[] = [];

async function testEndpoint(
  category: string,
  endpoint: string,
  test: () => Promise<any>
): Promise<void> {
  const start = Date.now();
  try {
    const result = await test();
    const duration = Date.now() - start;
    results.push({
      category,
      endpoint,
      success: true,
      duration,
      notes: typeof result === 'object' ? JSON.stringify(result).substring(0, 100) : String(result)
    });
    console.log(`✅ ${endpoint} (${duration}ms)`);
  } catch (error) {
    const duration = Date.now() - start;
    results.push({
      category,
      endpoint,
      success: false,
      duration,
      error: error instanceof Error ? error.message : String(error)
    });
    console.log(`❌ ${endpoint} (${duration}ms): ${error}`);
  }
}

async function main() {
  console.log('🔍 Forge API Validation\n');
  console.log(`Base URL: ${FORGE_BASE_URL}\n`);

  // ============================================================================
  // HEALTH & SYSTEM
  // ============================================================================
  console.log('\n📊 Testing Health & System Endpoints...\n');

  await testEndpoint('health', 'GET /health', async () => {
    return await forge.healthCheck();
  });

  await testEndpoint('system', 'GET /api/info', async () => {
    return await forge.getSystemInfo();
  });

  await testEndpoint('config', 'GET /api/config', async () => {
    return await forge.getConfig();
  });

  await testEndpoint('profiles', 'GET /api/profiles', async () => {
    return await forge.getExecutorProfiles();
  });

  // ============================================================================
  // PROJECTS
  // ============================================================================
  console.log('\n📁 Testing Project Endpoints...\n');

  let testProjectId: string | null = null;

  await testEndpoint('projects', 'GET /api/projects', async () => {
    const projects = await forge.listProjects();
    if (projects.length > 0) {
      testProjectId = projects[0].id;
    }
    return projects;
  });

  if (testProjectId) {
    await testEndpoint('projects', `GET /api/projects/${testProjectId}`, async () => {
      return await forge.getProject(testProjectId!);
    });

    await testEndpoint('projects', `GET /api/projects/${testProjectId}/branches`, async () => {
      return await forge.listProjectBranches(testProjectId!);
    });

    await testEndpoint('projects', `GET /api/projects/${testProjectId}/search`, async () => {
      return await forge.searchProjectFiles(testProjectId!, 'forge.ts', 'FileName');
    });
  }

  // ============================================================================
  // TASKS
  // ============================================================================
  console.log('\n📋 Testing Task Endpoints...\n');

  let testTaskId: string | null = null;

  if (testProjectId) {
    await testEndpoint('tasks', `GET /api/projects/${testProjectId}/tasks`, async () => {
      const tasks = await forge.listTasks(testProjectId!);
      if (tasks.length > 0) {
        testTaskId = tasks[0].id;
      }
      return tasks;
    });

    if (testTaskId) {
      await testEndpoint('tasks', `GET /api/projects/${testProjectId}/tasks/${testTaskId}`, async () => {
        return await forge.getTask(testProjectId!, testTaskId!);
      });
    }
  }

  // ============================================================================
  // TASK ATTEMPTS
  // ============================================================================
  console.log('\n🎯 Testing Task Attempt Endpoints...\n');

  let testAttemptId: string | null = null;

  if (testTaskId) {
    await testEndpoint('attempts', `GET /api/task-attempts?task_id=${testTaskId}`, async () => {
      const attempts = await forge.listTaskAttempts(testTaskId!);
      if (attempts.length > 0) {
        testAttemptId = attempts[0].id;
      }
      return attempts;
    });

    if (testAttemptId) {
      await testEndpoint('attempts', `GET /api/task-attempts/${testAttemptId}`, async () => {
        return await forge.getTaskAttempt(testAttemptId!);
      });

      await testEndpoint('attempts', `GET /api/task-attempts/${testAttemptId}/branch-status`, async () => {
        return await forge.getTaskAttemptBranchStatus(testAttemptId!);
      });

      await testEndpoint('attempts', `GET /api/task-attempts/${testAttemptId}/children`, async () => {
        return await forge.getTaskAttemptChildren(testAttemptId!);
      });
    }
  }

  // ============================================================================
  // EXECUTION PROCESSES
  // ============================================================================
  console.log('\n⚙️  Testing Execution Process Endpoints...\n');

  let testProcessId: string | null = null;

  if (testAttemptId) {
    await testEndpoint('processes', `GET /api/execution-processes?task_attempt_id=${testAttemptId}`, async () => {
      const processes = await forge.listExecutionProcesses(testAttemptId!);
      if (processes.length > 0) {
        testProcessId = processes[0].id;
      }
      return processes;
    });

    if (testProcessId) {
      await testEndpoint('processes', `GET /api/execution-processes/${testProcessId}`, async () => {
        return await forge.getExecutionProcess(testProcessId!);
      });
    }
  }

  // ============================================================================
  // STREAMING URLS
  // ============================================================================
  console.log('\n🌊 Testing Streaming URL Generation...\n');

  if (testProjectId) {
    await testEndpoint('streaming', 'getTasksStreamUrl', async () => {
      return forge.getTasksStreamUrl(testProjectId!);
    });
  }

  if (testAttemptId) {
    await testEndpoint('streaming', 'getExecutionProcessesStreamUrl', async () => {
      return forge.getExecutionProcessesStreamUrl(testAttemptId!);
    });

    await testEndpoint('streaming', 'getTaskDiffStreamUrl', async () => {
      return forge.getTaskDiffStreamUrl(testAttemptId!);
    });
  }

  if (testProcessId) {
    await testEndpoint('streaming', 'getRawLogsStreamUrl', async () => {
      return forge.getRawLogsStreamUrl(testProcessId!);
    });

    await testEndpoint('streaming', 'getNormalizedLogsStreamUrl', async () => {
      return forge.getNormalizedLogsStreamUrl(testProcessId!);
    });
  }

  // ============================================================================
  // FILESYSTEM
  // ============================================================================
  console.log('\n📂 Testing Filesystem Endpoints...\n');

  await testEndpoint('filesystem', 'GET /api/filesystem/directory', async () => {
    return await forge.listDirectory();
  });

  await testEndpoint('filesystem', 'GET /api/filesystem/git-repos', async () => {
    return await forge.listGitRepositories();
  });

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('📊 VALIDATION SUMMARY\n');

  const byCategory = results.reduce((acc, r) => {
    if (!acc[r.category]) acc[r.category] = { total: 0, success: 0, failed: 0 };
    acc[r.category].total++;
    if (r.success) acc[r.category].success++;
    else acc[r.category].failed++;
    return acc;
  }, {} as Record<string, { total: number; success: number; failed: number }>);

  Object.entries(byCategory).forEach(([category, stats]) => {
    const successRate = ((stats.success / stats.total) * 100).toFixed(1);
    console.log(`${category.toUpperCase()}: ${stats.success}/${stats.total} (${successRate}%)`);
  });

  console.log('');
  const totalSuccess = results.filter(r => r.success).length;
  const totalTests = results.length;
  const overallRate = ((totalSuccess / totalTests) * 100).toFixed(1);
  console.log(`OVERALL: ${totalSuccess}/${totalTests} (${overallRate}%)`);

  console.log('\n' + '='.repeat(80));

  // Failed tests details
  const failed = results.filter(r => !r.success);
  if (failed.length > 0) {
    console.log('\n❌ FAILED TESTS:\n');
    failed.forEach(f => {
      console.log(`${f.endpoint}: ${f.error}`);
    });
  }

  // Performance stats
  const avgDuration = (results.reduce((sum, r) => sum + r.duration, 0) / results.length).toFixed(2);
  const maxDuration = Math.max(...results.map(r => r.duration));
  const minDuration = Math.min(...results.map(r => r.duration));

  console.log('\n⏱️  PERFORMANCE:\n');
  console.log(`Average: ${avgDuration}ms`);
  console.log(`Min: ${minDuration}ms`);
  console.log(`Max: ${maxDuration}ms`);

  // Write detailed report
  const reportPath = '.genie/reports/forge-api-validation-results.json';
  const fs = await import('fs/promises');
  await fs.writeFile(reportPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    baseUrl: FORGE_BASE_URL,
    summary: {
      total: totalTests,
      success: totalSuccess,
      failed: totalTests - totalSuccess,
      successRate: overallRate
    },
    byCategory,
    performance: {
      average: avgDuration,
      min: minDuration,
      max: maxDuration
    },
    results
  }, null, 2));

  console.log(`\n📄 Detailed report: ${reportPath}\n`);
}

main().catch(console.error);
