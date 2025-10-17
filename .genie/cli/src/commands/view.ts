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
import { formatTranscriptMarkdown, type SessionMeta } from '../lib/markdown-formatter.js';
import {
  buildTranscriptFromEvents,
  sliceForLatest as sliceTranscriptForLatest,
  sliceForRecent as sliceTranscriptForRecent
} from '../executors/transcript-utils';
import { DEFAULT_EXECUTOR_KEY } from '../lib/executor-registry';
import { requireExecutor } from '../lib/executor-config';
import { DEFAULT_CONFIG } from '../lib/config-defaults';
import { formatPathRelative } from '../lib/utils';

export async function runView(
  parsed: ParsedCommand,
  config: GenieConfig,
  paths: Required<ConfigPaths>
): Promise<void> {
  const [sessionId] = parsed.commandArgs;
  if (!sessionId) {
    console.log('Usage: genie view <sessionId> [--full]');
    return;
  }

  const warnings: string[] = [];
  const store = loadSessions(
    paths as SessionPathsConfig,
    config as SessionLoadConfig,
    DEFAULT_CONFIG as any,
    { onWarning: (message) => warnings.push(message) }
  );

  let found = findSessionEntry(store, sessionId, paths);
  let orphanedSession = false;

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
        const sessionFilePath = executor.tryLocateSessionFileBySessionId(sessionId, sessionsDir);
        if (sessionFilePath && fs.existsSync(sessionFilePath)) {
          orphanedSession = true;
          warnings.push('⚠️  Session not tracked in CLI state. Displaying from session file.');

          const sessionFileContent = fs.readFileSync(sessionFilePath, 'utf8');
          const jsonl: Array<Record<string, any>> = [];
          const sourceLines = sessionFileContent.split(/\r?\n/);
          for (const line of sourceLines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('{')) continue;
            try { jsonl.push(JSON.parse(trimmed)); } catch { /* skip */ }
          }

          const transcript = buildTranscriptFromEvents(jsonl);

          // When --full flag is used, return complete transcript without slicing
          const displayTranscript = parsed.options.full
            ? transcript // Full transcript, no slicing
            : parsed.options.live
              ? sliceTranscriptForLatest(transcript)
              : sliceTranscriptForRecent(transcript);

          // Determine output mode from flags
          const mode = parsed.options.full ? 'full' : parsed.options.live ? 'final' : 'recent';

          const meta: SessionMeta = {
            sessionId: sessionId,
            agent: 'unknown',
            status: 'orphaned'
          };

          const markdown = formatTranscriptMarkdown(displayTranscript, meta, mode);
          console.log(markdown);

          if (warnings.length) {
            console.log('\n⚠️  Warnings:');
            warnings.forEach(w => console.log(`  ${w}`));
          }
          return;
        }
      }
    }

    console.error(`Error: No run found with session id '${sessionId}'`);
    process.exitCode = 1;
    return;
  }
  const { entry } = found;
  const executorKey = entry.executor || config.defaults?.executor || DEFAULT_EXECUTOR_KEY;
  const executor = requireExecutor(executorKey);
  const logViewer = executor.logViewer;
  const logFile = entry.logFile;
  if (!logFile || !fs.existsSync(logFile)) {
    console.error('Error: Log not found for this run');
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(logFile, 'utf8');
  const allLines = raw.split(/\r?\n/);

  if (!entry.sessionId && logViewer?.extractSessionIdFromContent) {
    const sessionFromLog = logViewer.extractSessionIdFromContent(allLines);
    if (sessionFromLog) {
      entry.sessionId = sessionFromLog;
      saveSessions(paths as SessionPathsConfig, store);
    }
  }

  let sessionFileContent: string | null = null;
  if (entry.sessionId && entry.startTime && executor.locateSessionFile) {
    const executorConfig = config.executors?.[executorKey] || {};
    const executorPaths = executor.resolvePaths({
      config: executorConfig,
      baseDir: paths.baseDir,
      resolvePath: (target: string, base?: string) =>
        path.isAbsolute(target) ? target : path.resolve(base || paths.baseDir || '.', target)
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
        }
      }
    }
  }

  const jsonl: Array<Record<string, any>> = [];
  const sourceLines = sessionFileContent ? sessionFileContent.split(/\r?\n/) : allLines;

  let hasFilteredFormat = false;
  for (const line of sourceLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[assistant]') || trimmed.startsWith('[tool]') ||
        trimmed.startsWith('[reasoning]') || trimmed.startsWith('[command]') ||
        trimmed.startsWith('[tool_result]')) {
      hasFilteredFormat = true;
      break;
    }
  }

  if (hasFilteredFormat) {
    let currentBlock: { type: string; content: string[] } | null = null;

    const flushBlock = () => {
      if (!currentBlock) return;
      jsonl.push(createFilteredEvent(currentBlock.type, currentBlock.content));
      currentBlock = null;
    };

    const appendToBlock = (type: string, line: string) => {
      if (!currentBlock || currentBlock.type !== type) {
        flushBlock();
        currentBlock = { type, content: [] };
      }
      if (line) currentBlock.content.push(line);
    };

    for (const line of sourceLines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('{')) {
        try {
          const event = JSON.parse(trimmed);
          if (event.type === 'system' || event.type === 'result') {
            jsonl.push(event);
          }
        } catch {
        }
        continue;
      }

      if (trimmed.startsWith('[assistant]')) {
        const contentAfterMarker = trimmed.substring('[assistant]'.length).trim();
        appendToBlock('assistant', contentAfterMarker);
      } else if (trimmed.startsWith('[tool]')) {
        const contentAfterMarker = trimmed.substring('[tool]'.length).trim();
        appendToBlock('tool', contentAfterMarker);
      } else if (trimmed.startsWith('[reasoning]')) {
        const contentAfterMarker = trimmed.substring('[reasoning]'.length).trim();
        appendToBlock('reasoning', contentAfterMarker);
      } else if (trimmed.startsWith('[command]')) {
        const contentAfterMarker = trimmed.substring('[command]'.length).trim();
        appendToBlock('command', contentAfterMarker);
      } else if (trimmed.startsWith('[tool_result]')) {
        const contentAfterMarker = trimmed.substring('[tool_result]'.length).trim();
        appendToBlock('tool_result', contentAfterMarker);
      } else if (trimmed) {
        appendToBlock('assistant', trimmed);
      }
    }

    flushBlock();
  } else {
    for (const line of sourceLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith('{')) continue;
      try { jsonl.push(JSON.parse(trimmed)); } catch { /* skip */ }
    }
  }

  function createFilteredEvent(type: string, content: string[]): Record<string, any> {
    const text = content.join('\n').trim();

    if (type === 'assistant') {
      return {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text }]
        }
      };
    } else if (type === 'reasoning') {
      return {
        type: 'reasoning',
        message: {
          content: [{ type: 'text', text }]
        }
      };
    } else if (type === 'tool') {
      return {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: `[Tool Call]\n${text}` }]
        }
      };
    } else if (type === 'tool_result') {
      return {
        type: 'user',
        message: {
          content: [{ type: 'text', text: `[Tool Result]\n${text}` }]
        }
      };
    } else if (type === 'command') {
      return {
        type: 'user',
        message: {
          content: [{ type: 'text', text: `[Command]\n${text}` }]
        }
      };
    }

    return {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text }]
      }
    };
  }

  // NOTE: Executor-specific buildJsonlView disabled during Ink removal
  // TODO: Restore or convert to markdown if needed
  // if (logViewer?.buildJsonlView) {
  //   ... (commented out)
  // }

  const transcript = buildTranscriptFromEvents(jsonl);

  if (!parsed.options.full && !parsed.options.live) {
    const lastMessage = transcript.length > 0 ? transcript[transcript.length - 1] : null;
    const lastMessageText = lastMessage
      ? `${lastMessage.title ? lastMessage.title + ': ' : ''}${lastMessage.body.join(' ').substring(0, 200)}`
      : 'No messages yet';

    const conciseOutput = JSON.stringify({
      session: entry.sessionId ?? 'pending',
      status: entry.status ?? 'unknown',
      executor: entry.executor ?? 'unknown',
      lastMessage: lastMessageText
    }, null, 2);

    process.stdout.write(conciseOutput + '\n');
    return;
  }

  // When --full flag is used, return complete transcript without slicing
  // Otherwise apply mode-specific slicing
  const displayTranscript = parsed.options.full
    ? transcript // Full transcript, no slicing
    : parsed.options.live
      ? sliceTranscriptForLatest(transcript)
      : sliceTranscriptForRecent(transcript);

  // Determine output mode from flags
  const mode = parsed.options.full ? 'full' : parsed.options.live ? 'final' : 'recent';

  const meta: SessionMeta = {
    sessionId: entry.sessionId ?? null,
    agent: entry.agent ?? 'unknown',
    status: entry.status ?? null,
    executor: entry.executor ? String(entry.executor) : undefined
  };

  const markdown = formatTranscriptMarkdown(displayTranscript, meta, mode);
  console.log(markdown);

  if (warnings.length) {
    console.log('\n⚠️  Warnings:');
    warnings.forEach(w => console.log(`  ${w}`));
  }
}
