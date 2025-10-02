import { SpawnOptionsWithoutStdio } from 'child_process';
import { SessionStore } from '../session-store';
import type { ViewEnvelope, ViewStyle } from '../view';

export interface ExecutorCommand {
  command: string;
  args: string[];
  spawnOptions?: SpawnOptionsWithoutStdio;
}

export interface ExecutorLogViewerRenderArgs {
  entry: Record<string, any>;
  jsonl: Array<Record<string, any>>;
  raw: string;
}

export interface ExecutorLogViewer {
  readSessionIdFromLog?(logFile: string): string | null;
  extractSessionIdFromContent?(content: string | string[]): string | null;
  renderJsonlView?(
    source: ExecutorLogViewerRenderArgs,
    parsed: any,
    paths: any,
    store: SessionStore,
    saveSessions: typeof import('../session-store').saveSessions,
    formatPathRelative: (targetPath: string, baseDir: string) => string
  ): void;
  buildJsonlView?(
    context: {
      render: ExecutorLogViewerRenderArgs;
      parsed: any;
      paths: any;
      store: SessionStore;
      save: typeof import('../session-store').saveSessions;
      formatPathRelative: (targetPath: string, baseDir: string) => string;
      style: ViewStyle;
    }
  ): ViewEnvelope;
}

export interface ExecutorDefaults {
  binary?: string;
  packageSpec?: string;
  sessionsDir?: string;
  exec?: Record<string, unknown>;
  resume?: Record<string, unknown>;
  sessionExtractionDelayMs?: number | null;
}

export interface ExecutorBuildRunArgs {
  config?: Record<string, any>;
  instructions?: string;
  prompt?: string;
  agentPath?: string;
}

export interface ExecutorBuildResumeArgs {
  config?: Record<string, any>;
  sessionId?: string;
  prompt?: string;
}

export interface ExecutorResolvePathsArgs {
  config?: Record<string, any>;
  baseDir?: string;
  resolvePath?: (target: string, baseDir?: string) => string;
}

export interface ExecutorExtractSessionArgs {
  startTime?: number;
  config?: Record<string, any>;
  paths?: Record<string, any>;
}

export interface ExecutorSessionDelayArgs {
  config?: Record<string, any>;
  defaultDelay: number;
}

export interface ExecutorLocateSessionFileArgs {
  sessionId: string;
  startTime: number;
  sessionsDir: string;
}

export interface Executor {
  defaults: ExecutorDefaults;
  buildRunCommand(args: ExecutorBuildRunArgs): ExecutorCommand;
  buildResumeCommand(args: ExecutorBuildResumeArgs): ExecutorCommand;
  resolvePaths(args: ExecutorResolvePathsArgs): Record<string, any>;
  extractSessionId?(args: ExecutorExtractSessionArgs): string | null;
  getSessionExtractionDelay?(args: ExecutorSessionDelayArgs): number;
  locateSessionFile?(args: ExecutorLocateSessionFileArgs): string | null;
  tryLocateSessionFileBySessionId?(sessionId: string, sessionsDir: string): string | null;
  createOutputFilter?(destination: NodeJS.WritableStream): NodeJS.ReadWriteStream;
  logViewer?: ExecutorLogViewer;
}
