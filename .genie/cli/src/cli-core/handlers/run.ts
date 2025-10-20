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
  executeRun
} from './shared';
import { handleForgeBackgroundLaunch } from '../../lib/forge-executor';

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
    const explicitExecutor = typeof parsed.options.executor === 'string' && parsed.options.executor.trim().length
      ? parsed.options.executor.trim()
      : null;
    const executorKey = (explicitExecutor || agentGenie.executor || resolveExecutorKey(ctx, modeName)).trim();
    const rawVariant =
      agentGenie.executorProfile ??
      agentGenie.executor_variant ??
      agentGenie.executorVariant ??
      agentGenie.variant ??
      agentGenie.profile;
    const executorVariant =
      typeof rawVariant === 'string' && rawVariant.trim().length ? rawVariant.trim() : 'DEFAULT';
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

    // Import generateSessionName and generate/reuse UUID
    const { generateSessionName } = require('../../session-store');
    const uuidv4 = () => {
      try {
        const { randomUUID } = require('crypto');
        if (typeof randomUUID === 'function') return randomUUID();
      } catch {}
      const { randomBytes } = require('crypto');
      return randomBytes(16).toString('hex');
    };
    const { INTERNAL_SESSION_ID_ENV } = require('../../lib/constants');

    // If running as background runner, reuse propagated sessionId to avoid duplicates
    const envSessionId = process.env[INTERNAL_SESSION_ID_ENV];
    const sessionId = (parsed.options.backgroundRunner && typeof envSessionId === 'string' && envSessionId.trim().length)
      ? envSessionId.trim()
      : uuidv4();

    const entry: SessionEntry = {
      agent: resolvedAgentName,
      name: parsed.options.name || generateSessionName(resolvedAgentName),
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
      executorVariant,
      executorPid: null,
      exitCode: null,
      signal: null,
      startTime: new Date(startTime).toISOString(),
      sessionId: sessionId // UUID assigned immediately
    };

    // Don't persist yet - wait for sessionId extraction

    // Check if background launch requested (and not already background runner)
    if (parsed.options.background && !parsed.options.backgroundRunner && !parsed.options.legacy) {
      const handledBackground = await handleForgeBackgroundLaunch({
        agentName: resolvedAgentName,
        prompt,
        config: ctx.config,
        paths: ctx.paths,
        store,
        entry,
        executorKey,
        executorVariant,
        executionMode: modeName,
        startTime
      });

      if (handledBackground) {
        return;
      }
    }

    if (!agentSpec.filePath) {
      throw new Error(`❌ Agent '${resolvedAgentName}' is missing a source file path`);
    }
    const agentPath = path.relative(process.cwd(), agentSpec.filePath);
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
