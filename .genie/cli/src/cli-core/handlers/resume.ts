import path from 'path';
import fs from 'fs';
import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import type { SessionEntry } from '../../session-store';
import { findSessionEntry } from '../../lib/session-helpers';
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
      throw new Error('Usage: genie resume <session-name> "<prompt>"');
    }

    const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
    const sessionName = cmdArgs[0];
    const prompt = cmdArgs.slice(1).join(' ').trim();
    const found = findSessionEntry(store, sessionName, ctx.paths);

    if (!found) {
      // CRITICAL: Do NOT access filesystem directly - this violates Forge worktree isolation
      // See: .genie/discovery/filesystem-restrictions-audit.md (Violation #3)
      //
      // OLD CODE (filesystem violation - REMOVED):
      //   - executor.tryLocateSessionFileBySessionId()
      //   - fs.existsSync(sessionFilePath)
      //
      // TODO (Wish #120-A): Use Forge MCP to check if session exists
      // Proposed implementation:
      //   try {
      //     const task = await mcp__automagik_forge__get_task({ task_id: sessionName });
      //     if (task) {
      //       throw new Error(
      //         `❌ Session '${sessionName}' is not tracked in CLI state.\n\n` +
      //         `Forge task exists: ${task.id}\n` +
      //         `Status: ${task.status}\n\n` +
      //         `This session cannot be resumed because CLI tracking information is missing.\n` +
      //         `This may happen if sessions.json was corrupted or deleted.\n\n` +
      //         `Options:\n` +
      //         `  1. View the session: npx automagik-genie view ${sessionName}\n` +
      //         `  2. Start a new session: npx automagik-genie run <agent> "<prompt>"\n` +
      //         `  3. (Advanced) Manually restore sessions.json entry`
      //       );
      //     }
      //   } catch (error) {
      //     // Session doesn't exist in Forge either
      //   }
      //
      // For now: Simply throw error (no filesystem violations)
      throw new Error(`❌ No session found with name '${sessionName}'`);
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
