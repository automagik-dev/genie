import path from 'path';
import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import type { SessionEntry } from '../../session-store';
import {
  resolveAgentIdentifier,
  loadAgentSpec,
  resolveExecutorKey,
  requireExecutor,
  extractExecutorOverrides,
  buildExecutorConfig,
  resolveExecutorPaths,
  deriveStartTime,
  deriveLogFile,
  persistStore,
  maybeHandleBackgroundLaunch,
  executeRun
} from './shared';

export function createRunHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
    const [agentName, ...promptParts] = parsed.commandArgs;
    if (!agentName) {
      throw new Error('Usage: genie run <agent> "<prompt>"');
    }

    const prompt = promptParts.join(' ').trim();
    const resolvedAgentName = resolveAgentIdentifier(agentName);
    const agentSpec = loadAgentSpec(ctx, resolvedAgentName);
    const agentMeta = agentSpec.meta || {};
    const agentGenie = agentMeta.genie || {};

    if (!parsed.options.backgroundExplicit && typeof agentGenie.background === 'boolean') {
      parsed.options.background = agentGenie.background;
    }

    const defaultMode = ctx.config.defaults?.executionMode || ctx.config.defaults?.preset || 'default';
    const agentMode = agentGenie.mode || agentGenie.executionMode || agentGenie.preset;
    const modeName = typeof agentMode === 'string' && agentMode.trim().length ? agentMode.trim() : defaultMode;
    const executorKey = agentGenie.executor || resolveExecutorKey(ctx, modeName);
    const executor = requireExecutor(ctx, executorKey);
    const executorOverrides = extractExecutorOverrides(ctx, agentGenie, executorKey);
    const executorConfig = buildExecutorConfig(ctx, modeName, executorKey, executorOverrides);

    // Debug: log executor config
    console.error(`[DEBUG run.ts] agentGenie:`, JSON.stringify(agentGenie));
    console.error(`[DEBUG run.ts] executorOverrides:`, JSON.stringify(executorOverrides));
    console.error(`[DEBUG run.ts] executorConfig:`, JSON.stringify(executorConfig));

    const executorPaths = resolveExecutorPaths(ctx.paths, executorKey);
    const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });

    const startTime = deriveStartTime();
    const logFile = deriveLogFile(resolvedAgentName, startTime, ctx.paths);

    // Generate temporary session ID for tracking (will be updated with real sessionId later)
    const tempSessionId = `temp-${resolvedAgentName}-${startTime}`;

    const entry: SessionEntry = {
      agent: resolvedAgentName,
      preset: modeName,
      mode: modeName,
      logFile,
      lastPrompt: prompt.slice(0, 200),
      created: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      status: 'starting',
      background: parsed.options.background,
      runnerPid: parsed.options.backgroundRunner ? process.pid : null,
      executor: executorKey,
      executorPid: null,
      exitCode: null,
      signal: null,
      startTime: new Date(startTime).toISOString(),
      sessionId: tempSessionId // Will be updated with real sessionId from executor
    };

    store.sessions[tempSessionId] = entry;
    await persistStore(ctx, store);

    const handledBackground = await maybeHandleBackgroundLaunch(ctx, {
      parsed,
      config: ctx.config,
      paths: ctx.paths,
      store,
      entry,
      agentName: resolvedAgentName,
      executorKey,
      executionMode: modeName,
      startTime,
      logFile,
      allowResume: true
    });

    if (handledBackground) {
      return;
    }

    const agentPath = path.join('.genie', 'agents', `${resolvedAgentName}.md`);
    const command = executor.buildRunCommand({
      config: executorConfig,
      agentPath,
      prompt
    });

    await executeRun(ctx, {
      agentName,
      command,
      executorKey,
      executor,
      executorConfig,
      executorPaths,
      prompt,
      store,
      entry,
      paths: ctx.paths,
      config: ctx.config,
      startTime,
      logFile,
      background: parsed.options.background,
      runnerPid: parsed.options.backgroundRunner ? process.pid : null,
      cliOptions: parsed.options,
      executionMode: modeName
    });
  };
}
