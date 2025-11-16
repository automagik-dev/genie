export interface CLIOptions {
  rawArgs: string[];
  background?: boolean;
  backgroundExplicit: boolean;
  backgroundRunner: boolean;
  requestHelp?: boolean;
  full: boolean;
  live: boolean;
  executor?: string;
  model?: string;
  name?: string;  // Friendly session name for run command
  raw?: boolean;  // Output raw text only (no JSON)
  quiet?: boolean;  // Suppress startup messages
  forgePort?: string;  // Custom Forge backend port
  geniePort?: string;  // Custom Genie MCP server port (alias: mcpPort)
}

export interface ParsedCommand {
  command?: string;
  commandArgs: string[];
  options: CLIOptions;
}

export interface ConfigPaths {
  baseDir?: string;
  tasksFile?: string;
  /**
   * @deprecated Legacy override for old taxonomy configs.
   * Prefer tasksFile moving forward.
   */
  sessionsFile?: string;
  logsDir?: string;
  backgroundDir?: string;
}

export interface GenieConfig {
  defaults?: {
    executionMode?: string;
    preset?: string;
    background?: boolean;
    executor?: string;
    executorVariant?: string;
    model?: string;
  };
  paths?: ConfigPaths;
  forge?: {
    executors?: Record<string, any>;
    agentProfiles?: Record<string, { executor: string; variant?: string }>;
  };
  executionModes?: Record<string, {
    description?: string;
    executor?: string;
    executorVariant?: string;
  }>;
  __configPath?: string;
}

export interface AgentSpec {
  meta?: Record<string, any>;
  instructions: string;
  filePath?: string;
}
