import fs from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { Executor, ExecutorCommand, ExecutorDefaults } from './types';
import * as logViewer from './claude-log-viewer';

const defaults: ExecutorDefaults = {
  binary: 'claude',
  packageSpec: undefined,
  sessionsDir: undefined,
  exec: {
    model: 'sonnet',
    permissionMode: 'default',
    outputFormat: 'stream-json',
    allowedTools: [],
    disallowedTools: []
  },
  resume: {
    outputFormat: 'stream-json'
  },
  sessionExtractionDelayMs: 1000
};

function buildRunCommand({ config = {}, instructions, agentPath, prompt }: { config?: Record<string, any>; instructions?: string; agentPath?: string; prompt?: string }): ExecutorCommand {
  const execConfig = mergeExecConfig(config) as Record<string, any>;
  const command = config.binary || defaults.binary!;
  const args: string[] = ['-p', '--verbose', '--output-format', 'stream-json'];

  // Debug: log exec config
  console.error(`[DEBUG] execConfig.permissionMode = ${execConfig.permissionMode}`);

  if (execConfig.model) {
    args.push('--model', String(execConfig.model));
  }

  if (execConfig.permissionMode) {
    // For bypassPermissions, use --dangerously-skip-permissions instead
    // This flag bypasses ALL permission checks, including Edit operations
    // (--permission-mode bypassPermissions doesn't bypass Edit prompts)
    if (execConfig.permissionMode === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
      console.error(`[DEBUG] Added --dangerously-skip-permissions (for bypassPermissions mode)`);
    } else {
      args.push('--permission-mode', String(execConfig.permissionMode));
      console.error(`[DEBUG] Added --permission-mode ${execConfig.permissionMode}`);
    }
  } else {
    console.error(`[DEBUG] permissionMode is falsy, not adding flag`);
  }

  if (Array.isArray(execConfig.allowedTools) && execConfig.allowedTools.length > 0) {
    args.push('--allowed-tools', execConfig.allowedTools.join(','));
  }

  if (Array.isArray(execConfig.disallowedTools) && execConfig.disallowedTools.length > 0) {
    args.push('--disallowed-tools', execConfig.disallowedTools.join(','));
  }

  // Prefer instructions (already loaded) over agentPath (requires file read)
  if (instructions) {
    args.push('--append-system-prompt', instructions);
  } else if (agentPath) {
    const instructionsFile = path.isAbsolute(agentPath) ? agentPath : path.resolve(agentPath);
    try {
      const content = fs.readFileSync(instructionsFile, 'utf-8');
      args.push('--append-system-prompt', content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[genie] Failed to read agent file at ${instructionsFile}: ${message}`);
    }
  }

  if (prompt) {
    args.push(prompt);
  }

  return {
    command,
    args,
    spawnOptions: {
      cwd: process.cwd()  // Use user's project directory, not npm package directory
    }
  };
}

function buildResumeCommand({ config = {}, sessionId, prompt }: { config?: Record<string, any>; sessionId?: string; prompt?: string }): ExecutorCommand {
  const resumeConfig = mergeResumeConfig(config.resume) as Record<string, any>;
  const command = config.binary || defaults.binary!;
  const args: string[] = ['-p', '--verbose', '--output-format', 'stream-json'];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  if (prompt) {
    args.push(prompt);
  }

  return { command, args };
}

function resolvePaths({ config = {}, baseDir, resolvePath }: { config?: Record<string, any>; baseDir?: string; resolvePath?: (target: string, base?: string) => string }) {
  return {};
}

function extractSessionId({ startTime, paths = {} }: { startTime?: number; paths?: Record<string, any> }): string | null {
  return null;
}

function getSessionExtractionDelay({ config = {}, defaultDelay }: { config?: Record<string, any>; defaultDelay: number }): number {
  if (typeof config.sessionExtractionDelayMs === 'number') {
    return config.sessionExtractionDelayMs;
  }
  if (typeof defaults.sessionExtractionDelayMs === 'number') {
    return defaults.sessionExtractionDelayMs;
  }
  return defaultDelay;
}

function mergeExecConfig(execConfig: Record<string, any> = {}) {
  return {
    ...defaults.exec,
    ...execConfig,
    allowedTools: Array.isArray(execConfig.allowedTools)
      ? execConfig.allowedTools.slice()
      : (defaults.exec as any).allowedTools.slice(),
    disallowedTools: Array.isArray(execConfig.disallowedTools)
      ? execConfig.disallowedTools.slice()
      : (defaults.exec as any).disallowedTools.slice()
  };
}

function mergeResumeConfig(resume: Record<string, any> = {}) {
  return {
    ...defaults.resume,
    ...resume
  };
}

function createOutputFilter(destination: NodeJS.WritableStream): NodeJS.ReadWriteStream {
  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) {
      const text = chunk.toString('utf8');
      const lines = text.split('\n');
      const output: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('{')) {
          output.push(line);
          continue;
        }

        try {
          const event = JSON.parse(trimmed);
          const type = event.type;

          if (type === 'system' && event.subtype === 'init') {
            const minimal = JSON.stringify({
              type: 'system',
              subtype: 'init',
              session_id: event.session_id,
              model: event.model
            });
            output.push(minimal);
          } else if (type === 'assistant' && event.message?.content) {
            const content = event.message.content;

            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text?.trim()) {
                  output.push(`\n[assistant] ${block.text}`);
                } else if (block.type === 'tool_use') {
                  output.push(`[tool] ${block.name}`);
                }
              }
            }
          } else if (type === 'user' && event.message?.content) {
            // Tool results
            const content = event.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'tool_result') {
                  const resultText = typeof block.content === 'string'
                    ? block.content.slice(0, 100)
                    : JSON.stringify(block.content).slice(0, 100);
                  output.push(`[tool_result] ${resultText}...`);
                }
              }
            }
          } else if (type === 'result' && event.subtype === 'success') {
            const summary = JSON.stringify({
              type: 'result',
              success: true,
              duration_ms: event.duration_ms,
              session_id: event.session_id,
              tokens: {
                input: event.usage?.input_tokens || 0,
                output: event.usage?.output_tokens || 0
              },
              cost_usd: event.total_cost_usd
            });
            output.push(summary);
          }
        } catch {
          output.push(line);
        }
      }

      const filtered = output.join('\n') + '\n';
      this.push(filtered);
      destination.write(filtered);
      callback();
    }
  });
}

const claudeExecutor: Executor = {
  defaults,
  buildRunCommand,
  buildResumeCommand,
  resolvePaths,
  extractSessionId,
  getSessionExtractionDelay,
  createOutputFilter,
  logViewer
};

export default claudeExecutor;