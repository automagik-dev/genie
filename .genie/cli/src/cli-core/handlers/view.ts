import fs from 'fs';
import path from 'path';
import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { findSessionEntry } from '../../lib/session-helpers';

export function createViewHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
    const [sessionId] = parsed.commandArgs;
    if (!sessionId) {
      throw new Error('Usage: genie view <sessionId> [--full]');
    }

    const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });

    // Try sessions.json first
    let found: { agentName: string; entry: any } | null = findSessionEntry(store, sessionId, ctx.paths);
    let orphanedSession = false;

    // If not found in sessions.json, try direct session file lookup
    if (!found) {
      const executorKey = ctx.config.defaults?.executor || ctx.defaultExecutorKey;
      const executor = ctx.executors[executorKey];

      if (executor?.tryLocateSessionFileBySessionId && executor.resolvePaths) {
        const executorConfig = ctx.config.executors?.[executorKey] || {};
        const executorPaths = executor.resolvePaths({
          config: executorConfig,
          baseDir: ctx.paths.baseDir,
          resolvePath: (target: string, base?: string) =>
            path.isAbsolute(target) ? target : path.resolve(base || ctx.paths.baseDir || '.', target)
        });

        const sessionsDir = executorPaths.sessionsDir;
        if (sessionsDir) {
          const sessionFilePath = executor.tryLocateSessionFileBySessionId(sessionId, sessionsDir);
          if (sessionFilePath && fs.existsSync(sessionFilePath)) {
            orphanedSession = true;
            const sessionFileContent = fs.readFileSync(sessionFilePath, 'utf8');

            return {
              sessionId,
              agent: 'unknown',
              status: 'orphaned',
              transcript: sessionFileContent,
              source: 'orphaned session file',
              filePath: sessionFilePath
            };
          }
        }
      }

      throw new Error(`❌ No run found with session id '${sessionId}'`);
    }

    const { agentName, entry } = found;
    const executorKey = entry.executor || ctx.config.defaults?.executor || ctx.defaultExecutorKey;
    const executor = ctx.executors[executorKey];
    const logFile = entry.logFile;

    if (!logFile || !fs.existsSync(logFile)) {
      throw new Error('❌ Log not found for this run');
    }

    const raw = fs.readFileSync(logFile, 'utf8');
    const allLines = raw.split(/\r?\n/);

    // Try to locate and read from session file for full conversation history
    let sessionFileContent: string | null = null;
    if (entry.sessionId && entry.startTime && executor?.locateSessionFile) {
      const executorConfig = ctx.config.executors?.[executorKey] || {};
      const executorPaths = executor.resolvePaths({
        config: executorConfig,
        baseDir: ctx.paths.baseDir,
        resolvePath: (target: string, base?: string) =>
          path.isAbsolute(target) ? target : path.resolve(base || ctx.paths.baseDir || '.', target)
      });
      const sessionsDir = executorPaths.sessionsDir;
      const startTime = new Date(entry.startTime).getTime();

      if (sessionsDir && !Number.isNaN(startTime)) {
        const sessionFilePath = executor.locateSessionFile({
          sessionId: entry.sessionId,
          startTime,
          sessionsDir
        });

        if (sessionFilePath && fs.existsSync(sessionFilePath)) {
          try {
            sessionFileContent = fs.readFileSync(sessionFilePath, 'utf8');
          } catch {
            // Fall back to CLI log if session file read fails
          }
        }
      }
    }

    const transcript = sessionFileContent || raw;

    return {
      sessionId: entry.sessionId || sessionId,
      agent: agentName,
      status: entry.status || 'unknown',
      transcript,
      source: sessionFileContent ? 'session file' : 'CLI log',
      mode: entry.mode || entry.preset,
      created: entry.created,
      lastUsed: entry.lastUsed,
      logFile
    };
  };
}
