/**
 * Task Command - Pure headless task execution
 *
 * Creates a Forge task and returns immediately with task ID.
 * No browser opening, no monitoring. Designed for automation and scripting.
 *
 * Behavior:
 * 1. Create Forge task with agent
 * 2. Return task ID and URL immediately
 * 3. Task runs in background
 * 4. Exit (fire and forget)
 *
 * This preserves the old `genie run` behavior for backward compatibility.
 */

import { getForgeConfig } from '../lib/service-config.js';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import { ensureForgeRunning } from '../lib/headless-helpers';
import { resolveAgentIdentifier, loadAgentSpec } from '../lib/agent-resolver';
import { createForgeExecutor } from '../lib/forge-executor';
import { describeForgeError, FORGE_RECOVERY_HINT } from '../lib/forge-helpers';
import { normalizeExecutorKeyOrDefault } from '../lib/executor-registry';
import { monitorTaskCompletion } from '../lib/task-monitor';
import { TaskService } from '../cli-core/task-service.js';

export async function runTask(
  parsed: ParsedCommand,
  config: GenieConfig,
  paths: Required<ConfigPaths>
): Promise<void> {
  const [subcommandOrAgent, ...restArgs] = parsed.commandArgs;

  if (!subcommandOrAgent) {
    console.error('Usage: genie task <agent> "<prompt>" OR genie task monitor <attempt-id>');
    process.exit(1);
  }

  if (subcommandOrAgent === 'monitor') {
    return runTaskMonitor(restArgs, config, paths);
  }

  const agentName = subcommandOrAgent;
  const promptParts = restArgs;
  const prompt = promptParts.join(' ').trim();
  if (!prompt) {
    console.error('Error: Prompt is required');
    console.error('Usage: genie task <agent> "<prompt>"');
    process.exit(1);
  }

  const resolvedAgentName = resolveAgentIdentifier(agentName);
  const agentSpec = loadAgentSpec(resolvedAgentName);
  const agentGenie = agentSpec.meta?.genie || {};

  // Resolve executor configuration (CLI flags override agent/config defaults)
  const executorKey = normalizeExecutorKeyOrDefault(
    parsed.options.executor || agentGenie.executor || config.defaults?.executor
  );
  const executorVariant = (
    agentGenie.executorVariant ||
    agentGenie.variant ||
    config.defaults?.executorVariant ||
    'DEFAULT'
  ).trim().toUpperCase();
  const model = parsed.options.model || agentGenie.model || config.defaults?.model;
  const sessionName = parsed.options.name;
  const raw = parsed.options.raw || false;

  // Ensure Forge is running (quiet mode)
  await ensureForgeRunning(true);

  const forgeExecutor = createForgeExecutor();

  let sessionResult;
  try {
    sessionResult = await forgeExecutor.createTask({
      agentName: resolvedAgentName,
      prompt,
      executorKey,
      executorVariant,
      executionMode: 'background',
      model,
      ...(sessionName && { name: sessionName })
    });
  } catch (error) {
    const reason = describeForgeError(error);
    console.error(JSON.stringify({
      error: `Failed to create task: ${reason}`,
      hint: FORGE_RECOVERY_HINT
    }, null, 2));
    process.exit(1);
  }

  const attemptId = sessionResult.attemptId;
  const taskUrl = sessionResult.forgeUrl;

  const sessionService = new TaskService({
    paths: { tasksFile: paths.tasksFile }
  });
  const store = sessionService.load();
  const now = new Date().toISOString();
  store.sessions[attemptId] = {
    agent: resolvedAgentName,
    taskId: sessionResult.taskId,
    projectId: sessionResult.projectId,
    executor: executorKey,
    executorVariant,
    model: model || undefined,
    status: 'running',
    created: now,
    lastUsed: now,
    lastPrompt: prompt.slice(0, 200),
    mode: 'background',
    forgeUrl: sessionResult.forgeUrl,
    background: true
  };
  await sessionService.save(store);

  // Output based on --raw flag
  if (raw) {
    console.log(attemptId);
  } else {
    const jsonOutput = {
      task_id: attemptId,
      task_url: taskUrl,
      agent: resolvedAgentName,
      executor: `${executorKey}:${executorVariant}`,
      ...(model && { model }),
      status: 'started',
      message: 'Task running in background'
    };

    console.log(JSON.stringify(jsonOutput, null, 2));
  }
  
  process.exitCode = 0;
}

async function runTaskMonitor(
  args: string[],
  _config: GenieConfig,
  _paths: Required<ConfigPaths>
): Promise<void> {
  const [attemptId] = args;

  if (!attemptId) {
    console.error('Usage: genie task monitor <attempt-id>');
    process.exit(1);
  }

  const { baseUrl, token } = getForgeConfig();

  console.log(`📡 Monitoring task attempt: ${attemptId}`);
  console.log('');

  try {
    const result = await monitorTaskCompletion({
      attemptId,
      baseUrl,
      token,
      onLog: (log) => {
        console.log(log);
      },
      onStatus: (status) => {
        if (status !== 'running') {
          console.log(`Status: ${status}`);
        }
      }
    });

    const jsonOutput = JSON.stringify({
      task_url: result.task_url,
      result: result.output,
      status: result.status,
      duration_ms: result.duration_ms,
      attempt_id: attemptId,
      ...(result.error && { error: result.error })
    }, null, 2);

    console.log('');
    console.log('━'.repeat(60));
    console.log(result.status === 'completed' ? '✅ Task Completed' : '❌ Task Failed');
    console.log('━'.repeat(60));
    console.log('');
    console.log(jsonOutput);
    console.log('');

    process.exitCode = result.status === 'completed' ? 0 : 1;
  } catch (error) {
    console.error('');
    console.error('❌ Monitoring failed:', error);
    console.error('');
    process.exitCode = 1;
  }
}
