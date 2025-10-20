import type { Executor, ExecutorCommand } from '../executors/types';
import type { SessionStore, SessionEntry } from '../session-store';

export interface CLIOptions {
  rawArgs: string[];
  background: boolean;
  backgroundExplicit: boolean;
  backgroundRunner: boolean;
  legacy?: boolean;
  requestHelp?: boolean;
  full: boolean;
  live: boolean;
  executor?: string;
  mode?: string;
  name?: string;  // Friendly session name for run command
}

export interface ParsedCommand {
  command?: string;
  commandArgs: string[];
  options: CLIOptions;
}

export interface ConfigPaths {
  baseDir?: string;
  sessionsFile?: string;
  logsDir?: string;
  backgroundDir?: string;
  executors?: Record<string, Record<string, any>>;
}

export interface GenieConfig {
  defaults?: {
    executionMode?: string;
    preset?: string;
    background?: boolean;
    executor?: string;
  };
  paths?: ConfigPaths;
  executors?: Record<string, any>;
  executionModes?: Record<string, any>;
  presets?: Record<string, any>;
  background?: {
    enabled?: boolean;
    detach?: boolean;
    pollIntervalMs?: number;
    sessionExtractionDelayMs?: number;
  };
  __configPath?: string;
}

export interface AgentSpec {
  meta?: Record<string, any>;
  instructions: string;
}

export interface ExecuteRunArgs {
  agentName: string;
  command: ExecutorCommand;
  executorKey: string;
  executor: Executor;
  executorConfig: any;
  executorPaths: any;
  prompt: string;
  store: SessionStore;
  entry: SessionEntry;
  paths: Required<ConfigPaths>;
  config: GenieConfig;
  startTime: number;
  logFile: string;
  background: boolean;
  runnerPid: number | null;
  cliOptions: CLIOptions;
  executionMode: string;
}
