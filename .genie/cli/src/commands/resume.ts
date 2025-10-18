import fs from 'fs';
import path from 'path';
import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import {
  loadSessions,
  saveSessions,
  SessionLoadConfig,
  SessionPathsConfig
} from '../session-store';
import { findSessionEntry } from '../lib/session-helpers';
import { executeRun } from './run';
import { maybeHandleBackgroundLaunch } from '../lib/background-launcher';
import {
  resolveExecutorKey,
  requireExecutor,
  buildExecutorConfig,
  resolveExecutorPaths,
  extractExecutorOverrides
} from '../lib/executor-config';
import { deriveStartTime, deriveLogFile } from '../lib/utils';
import { DEFAULT_CONFIG } from '../lib/config-defaults';
import { loadAgentSpec } from '../lib/agent-resolver';
import { DEFAULT_EXECUTOR_KEY } from '../lib/executor-registry';

export async function runContinue(
  parsed: ParsedCommand,
  config: GenieConfig,
  paths: Required<ConfigPaths>
): Promise<void> {
  const cmdArgs = parsed.commandArgs;
  if (cmdArgs.length < 2) {
    throw new Error('Usage: genie resume <sessionId> "<prompt>"');
  }

  const store = loadSessions(paths as SessionPathsConfig, config as SessionLoadConfig, DEFAULT_CONFIG as any);
  const sessionIdArg = cmdArgs[0];
  const prompt = cmdArgs.slice(1).join(' ').trim();
  const found = findSessionEntry(store, sessionIdArg, paths);

  if (!found) {
    const executorKey = config.defaults?.executor || DEFAULT_EXECUTOR_KEY;
    const executor = requireExecutor(executorKey);

    if (executor.tryLocateSessionFileBySessionId && executor.resolvePaths) {
      const executorConfig = config.executors?.[executorKey] || {};
      const executorPaths = executor.resolvePaths({
        config: executorConfig,
        baseDir: paths.baseDir,
        resolvePath: (target: string, base?: string) =>
          path.isAbsolute(target) ? target : path.resolve(base || paths.baseDir || '.', target)
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
            `  1. View the session: npx automagik-genie view ${sessionIdArg}\n` +
            `  2. Start a new session: npx automagik-genie run <agent> "<prompt>"\n` +
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

  const agentSpec = loadAgentSpec(agentName);
  const agentMeta = agentSpec.meta || {};
  const agentGenie = agentMeta.genie || {};
  if (!parsed.options.backgroundExplicit && typeof agentGenie.background === 'boolean') {
    parsed.options.background = agentGenie.background;
  }
  const defaultMode = config.defaults?.executionMode || config.defaults?.preset || 'default';
  const storedMode = session.mode || session.preset;
  const agentMode = agentGenie.mode || agentGenie.executionMode || agentGenie.preset;
  const modeName = typeof storedMode === 'string' && storedMode.trim().length
    ? storedMode.trim()
    : typeof agentMode === 'string' && agentMode.trim().length
      ? agentMode.trim()
      : defaultMode;
  session.mode = modeName;
  session.preset = modeName;

  const executorKey = session.executor || agentGenie.executor || resolveExecutorKey(config, modeName);
  const executor = requireExecutor(executorKey);
  const executorOverrides = extractExecutorOverrides(agentGenie, executorKey);
  const executorConfig = buildExecutorConfig(config, modeName, executorKey, executorOverrides);
  const executorPaths = resolveExecutorPaths(paths, executorKey);
  const command = executor.buildResumeCommand({
    config: executorConfig,
    sessionId: session.sessionId || undefined,
    prompt
  });

  const startTime = deriveStartTime();
  const logFile = deriveLogFile(agentName, startTime, paths);

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
  saveSessions(paths as SessionPathsConfig, store);

  const handledBackground = await maybeHandleBackgroundLaunch({
    parsed,
    config,
    paths,
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

  await executeRun({
    agentName,
    command,
    executorKey,
    executor,
    executorConfig,
    executorPaths,
    prompt,
    store,
    entry: session,
    paths,
    config,
    startTime,
    logFile,
    background: parsed.options.background,
    runnerPid: parsed.options.backgroundRunner ? process.pid : null,
    cliOptions: parsed.options,
    executionMode: modeName
  });
}
