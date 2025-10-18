#!/usr/bin/env tsx
/**
 * ForgeClient API Validation Script
 * Tests all critical endpoints to validate executor replacement feasibility
 */

import { ForgeClient } from './forge';

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function section(title: string) {
  console.log();
  log(`${'='.repeat(80)}`, 'blue');
  log(`  ${title}`, 'blue');
  log(`${'='.repeat(80)}`, 'blue');
  console.log();
}

async function test<T>(
  description: string,
  fn: () => Promise<T>
): Promise<{ success: boolean; data?: T; error?: Error }> {
  process.stdout.write(`${colors.gray}Testing: ${description}... ${colors.reset}`);
  try {
    const data = await fn();
    log('✅ PASS', 'green');
    return { success: true, data };
  } catch (error) {
    log(`❌ FAIL: ${error instanceof Error ? error.message : String(error)}`, 'red');
    return { success: false, error: error as Error };
  }
}

async function main() {
  const baseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:18887';
  log(`ForgeClient API Validation`, 'blue');
  log(`Base URL: ${baseUrl}`, 'gray');
  log(`Date: ${new Date().toISOString()}`, 'gray');

  const client = new ForgeClient(baseUrl);

  // Track results
  const results = {
    total: 0,
    passed: 0,
    failed: 0,
  };

  function updateResults(success: boolean) {
    results.total++;
    if (success) results.passed++;
    else results.failed++;
  }

  // ==========================================================================
  // PHASE 1: HEALTH & SYSTEM
  // ==========================================================================
  section('Phase 1: Health & System');

  const healthResult = await test('Health check', () => client.healthCheck());
  updateResults(healthResult.success);

  const infoResult = await test('Get system info', () => client.getSystemInfo());
  updateResults(infoResult.success);

  if (infoResult.data) {
    log(`  Config user: ${infoResult.data.config.github_user || 'N/A'}`, 'gray');
    log(`  Executors available: ${infoResult.data.executor_profiles.length}`, 'gray');
  }

  const configResult = await test('Get config', () => client.getConfig());
  updateResults(configResult.success);

  // ==========================================================================
  // PHASE 2: PROJECTS
  // ==========================================================================
  section('Phase 2: Projects');

  const projectsResult = await test('List projects', () => client.listProjects());
  updateResults(projectsResult.success);

  if (projectsResult.data) {
    log(`  Projects found: ${projectsResult.data.length}`, 'gray');
    if (projectsResult.data.length > 0) {
      const firstProject = projectsResult.data[0];
      log(`  First project: ${firstProject.name} (${firstProject.id})`, 'gray');

      // Test getting project details
      const projectResult = await test(
        `Get project details (${firstProject.id})`,
        () => client.getProject(firstProject.id)
      );
      updateResults(projectResult.success);

      // Test listing branches
      const branchesResult = await test(
        `List project branches (${firstProject.id})`,
        () => client.listProjectBranches(firstProject.id)
      );
      updateResults(branchesResult.success);

      if (branchesResult.data) {
        log(`  Branches found: ${branchesResult.data.length}`, 'gray');
      }

      // ==========================================================================
      // PHASE 3: TASKS
      // ==========================================================================
      section('Phase 3: Tasks');

      const tasksResult = await test(
        `List tasks in project (${firstProject.id})`,
        () => client.listTasks(firstProject.id)
      );
      updateResults(tasksResult.success);

      if (tasksResult.data) {
        log(`  Tasks found: ${tasksResult.data.length}`, 'gray');

        if (tasksResult.data.length > 0) {
          const firstTask = tasksResult.data[0];
          log(`  First task: ${firstTask.title} (${firstTask.id})`, 'gray');

          // Test getting task details
          const taskResult = await test(
            `Get task details (${firstTask.id})`,
            () => client.getTask(firstProject.id, firstTask.id)
          );
          updateResults(taskResult.success);

          // ==========================================================================
          // PHASE 4: TASK ATTEMPTS
          // ==========================================================================
          section('Phase 4: Task Attempts');

          const attemptsResult = await test(
            `List task attempts for task (${firstTask.id})`,
            () => client.listTaskAttempts(firstTask.id)
          );
          updateResults(attemptsResult.success);

          if (attemptsResult.data && attemptsResult.data.length > 0) {
            const firstAttempt = attemptsResult.data[0];
            log(`  Attempts found: ${attemptsResult.data.length}`, 'gray');
            log(`  First attempt: ${firstAttempt.id}`, 'gray');

            // Test getting attempt details
            const attemptResult = await test(
              `Get task attempt details (${firstAttempt.id})`,
              () => client.getTaskAttempt(firstAttempt.id)
            );
            updateResults(attemptResult.success);

            // Test getting branch status
            const branchStatusResult = await test(
              `Get branch status (${firstAttempt.id})`,
              () => client.getTaskAttemptBranchStatus(firstAttempt.id)
            );
            updateResults(branchStatusResult.success);

            if (branchStatusResult.data) {
              log(`  Ahead: ${branchStatusResult.data.ahead}, Behind: ${branchStatusResult.data.behind}`, 'gray');
            }

            // ==========================================================================
            // PHASE 5: EXECUTION PROCESSES
            // ==========================================================================
            section('Phase 5: Execution Processes');

            const processesResult = await test(
              `List execution processes (${firstAttempt.id})`,
              () => client.listExecutionProcesses(firstAttempt.id)
            );
            updateResults(processesResult.success);

            if (processesResult.data && processesResult.data.length > 0) {
              const firstProcess = processesResult.data[0];
              log(`  Processes found: ${processesResult.data.length}`, 'gray');
              log(`  First process: ${firstProcess.id}`, 'gray');

              // Test getting process details
              const processResult = await test(
                `Get execution process details (${firstProcess.id})`,
                () => client.getExecutionProcess(firstProcess.id)
              );
              updateResults(processResult.success);

              // ==========================================================================
              // PHASE 6: WEBSOCKET URLS
              // ==========================================================================
              section('Phase 6: WebSocket Streaming URLs');

              log(`Testing WebSocket URL generation...`, 'gray');

              const rawLogsUrl = client.getRawLogsStreamUrl(firstProcess.id);
              log(`  ✅ Raw logs URL: ${rawLogsUrl}`, 'green');
              updateResults(true);

              const normalizedLogsUrl = client.getNormalizedLogsStreamUrl(firstProcess.id);
              log(`  ✅ Normalized logs URL: ${normalizedLogsUrl}`, 'green');
              updateResults(true);

              const diffUrl = client.getTaskDiffStreamUrl(firstAttempt.id);
              log(`  ✅ Task diff URL: ${diffUrl}`, 'green');
              updateResults(true);

              const processesStreamUrl = client.getExecutionProcessesStreamUrl(firstAttempt.id);
              log(`  ✅ Processes stream URL: ${processesStreamUrl}`, 'green');
              updateResults(true);
            } else {
              log(`  No execution processes found to test streaming`, 'yellow');
            }
          } else {
            log(`  No task attempts found to test`, 'yellow');
          }
        } else {
          log(`  No tasks found to test`, 'yellow');
        }
      }

      // ==========================================================================
      // PHASE 7: EVENT SUBSCRIPTION
      // ==========================================================================
      section('Phase 7: Event Subscription');

      log(`Testing Server-Sent Events subscription...`, 'gray');
      try {
        const eventSource = client.subscribeToEvents();
        log(`  ✅ EventSource created: ${eventSource.url}`, 'green');
        eventSource.close();
        updateResults(true);
      } catch (error) {
        log(`  ❌ Failed to create EventSource: ${error}`, 'red');
        updateResults(false);
      }
    } else {
      log(`  ⚠️  No projects found. Cannot test task/attempt/process endpoints.`, 'yellow');
    }
  }

  // ==========================================================================
  // SUMMARY
  // ==========================================================================
  section('Test Summary');

  log(`Total tests: ${results.total}`, 'blue');
  log(`Passed: ${results.passed}`, 'green');
  log(`Failed: ${results.failed}`, results.failed > 0 ? 'red' : 'green');
  log(`Success rate: ${((results.passed / results.total) * 100).toFixed(1)}%`,
    results.failed === 0 ? 'green' : 'yellow');

  console.log();

  if (results.failed === 0) {
    log('🎉 All tests passed! Forge executor replacement is FEASIBLE.', 'green');
    process.exit(0);
  } else {
    log(`⚠️  ${results.failed} test(s) failed. Review errors above.`, 'yellow');
    process.exit(1);
  }
}

main().catch((error) => {
  log(`Fatal error: ${error}`, 'red');
  console.error(error);
  process.exit(1);
});
