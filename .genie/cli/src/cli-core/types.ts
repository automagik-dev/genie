export interface CLIOptions {
  rawArgs: string[];
  background: boolean;
  backgroundExplicit: boolean;
  backgroundRunner: boolean;
  requestHelp?: boolean;
  full: boolean;
  live: boolean;
  name?: string;  // Friendly session name for run command
  executor?: string;  // Executor override
  mode?: string;  // Mode override
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
  executors?: Record<string, Record<string, unknown>>;
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
