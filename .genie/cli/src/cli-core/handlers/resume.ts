import path from 'path';
import fs from 'fs';
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

export function createResumeHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
    const cmdArgs = parsed.commandArgs;
    if (cmdArgs.length < 2) {
      throw new Error('Usage: genie resume <sessionId> "<prompt>"');
    }

    const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
    const sessionIdArg = cmdArgs[0];
    const prompt = cmdArgs.slice(1).join(' ').trim();
    const found = findSessionEntry(store, sessionIdArg, ctx.paths);

    if (!found) {
      // Check if session file exists but is orphaned
      const executorKey = ctx.config.defaults?.executor || ctx.defaultExecutorKey;
      const executor = requireExecutor(ctx, executorKey);

      if (executor.tryLocateSessionFileBySessionId && executor.resolvePaths) {
        const executorConfig = ctx.config.executors?.[executorKey] || {};
        const executorPaths = executor.resolvePaths({
          config: executorConfig,
          baseDir: ctx.paths.baseDir,
          resolvePath: (target: string, base?: string) =>
            path.isAbsolute(target) ? target : path.resolve(base || ctx.paths.baseDir || '.', target)
        });

        const sessionsDir = executorPaths.sessionsDir;
        if (sessionsDir) {
          const sessionFilePath = executor.tryLocateSessionFileBySessionId(sessionIdArg, sessionsDir);
          if (sessionFilePath && fs.existsSync(sessionFilePath)) {
            throw new Error(
              `❌ Session '${sessionIdArg}' is not tracked in CLI state.\n\n` +
              `Session file exists at:\n  ${sessionFilePath}\n\n` +
              `This session cannot be resumed because CLI tracking information is missing.\n` +
              `This may happen if sessions.json was corrupted or deleted.\n\n` +
              `Options:\n` +
              `  1. View the session: ./genie view ${sessionIdArg}\n` +
              `  2. Start a new session: ./genie run <agent> "<prompt>"\n` +
              `  3. (Advanced) Manually restore sessions.json entry`
            );
          }
        }
      }

      throw new Error(`❌ No run found with session id '${sessionIdArg}'`);
    }

    const { agentName, entry: session } = found;
    if (!session || !session.sessionId) {
      throw new Error(`❌ No active session for agent '${agentName}'`);
    }

    const agentSpec = loadAgentSpec(ctx, agentName);
    const agentMeta = agentSpec.meta || {};
    const agentGenie = agentMeta.genie || {};
    if (!parsed.options.backgroundExplicit && typeof agentGenie.background === 'boolean') {
      parsed.options.background = agentGenie.background;
    }
    const defaultMode = ctx.config.defaults?.executionMode || ctx.config.defaults?.preset || 'default';
    const storedMode = session.mode || session.preset;
    const agentMode = agentGenie.mode || agentGenie.executionMode || agentGenie.preset;
    const modeName = typeof storedMode === 'string' && storedMode.trim().length
      ? storedMode.trim()
      : typeof agentMode === 'string' && agentMode.trim().length
        ? agentMode.trim()
        : defaultMode;
    session.mode = modeName;
    session.preset = modeName;

    const executorKey = session.executor || agentGenie.executor || resolveExecutorKey(ctx, modeName);
    const executor = requireExecutor(ctx, executorKey);
    const executorOverrides = extractExecutorOverrides(ctx, agentGenie, executorKey);
    const executorConfig = buildExecutorConfig(ctx, modeName, executorKey, executorOverrides);
    const executorPaths = resolveExecutorPaths(ctx.paths, executorKey);
    const command = executor.buildResumeCommand({
      config: executorConfig,
      sessionId: session.sessionId || undefined,
      prompt
    });

    const startTime = deriveStartTime();
    const logFile = deriveLogFile(agentName, startTime, ctx.paths);

    session.lastPrompt = prompt ? prompt.slice(0, 200) : session.lastPrompt;
    session.lastUsed = new Date().toISOString();
    session.logFile = logFile;
    session.status = 'starting';
    session.background = parsed.options.background;
    session.runnerPid = parsed.options.backgroundRunner ? process.pid : null;
    session.executor = executorKey;
    session.executorPid = null;
    session.exitCode = null;
    session.signal = null;
    await persistStore(ctx, store);

    const handledBackground = await maybeHandleBackgroundLaunch(ctx, {
      parsed,
      config: ctx.config,
      paths: ctx.paths,
      store,
      entry: session,
      agentName,
      executorKey,
      executionMode: modeName,
      startTime,
      logFile,
      allowResume: false
    });

    if (handledBackground) {
      return;
    }

    await executeRun(ctx, {
      agentName,
      command,
      executorKey,
      executor,
      executorConfig,
      executorPaths,
      prompt,
      store,
      entry: session,
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

function findSessionEntry(
  store: any,
  sessionId: string,
  paths: any
): { agentName: string; entry: SessionEntry } | null {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const trimmed = sessionId.trim();
  if (!trimmed) return null;

  for (const [agentName, entry] of Object.entries(store.agents || {})) {
    if (entry && (entry as any).sessionId === trimmed) {
      return { agentName, entry: entry as SessionEntry };
    }
  }

  for (const [agentName, entry] of Object.entries(store.agents || {})) {
    const logFile = (entry as any).logFile;
    if (!logFile || !fs.existsSync(logFile)) continue;
    try {
      const content = fs.readFileSync(logFile, 'utf8');
      const marker = new RegExp(`"session_id":"${trimmed}"`);
      if (marker.test(content)) {
        (entry as any).sessionId = trimmed;
        (entry as any).lastUsed = new Date().toISOString();
        return { agentName, entry: entry as SessionEntry };
      }
    } catch {
      // skip
    }
  }
  return null;
}
