import fs from 'fs';
import path from 'path';
import type { GenieConfig, ConfigPaths, CLIOptions } from './types';
import { deepClone, mergeDeep } from './utils';
import { findWorkspaceRoot } from './paths';

let YAML: typeof import('yaml') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  YAML = require('yaml');
} catch (_) {
  // yaml module optional
}

const BASE_CONFIG: GenieConfig = {
  defaults: {
    executor: 'OPENCODE',
    executorVariant: 'DEFAULT',
    background: false
  },
  paths: {
    baseDir: undefined,
    tasksFile: '.genie/state/tasks.json',
    logsDir: '.genie/state/agents/logs',
    backgroundDir: '.genie/state/agents/background'
  },
  forge: {
    executors: {}
  },
  executionModes: {}
};

function resolveConfigPath(): string {
  try {
    const root = findWorkspaceRoot();
    const projectConfig = path.join(root, '.genie', 'config.yaml');
    if (fs.existsSync(projectConfig)) return projectConfig;
  } catch (_) {}
  return path.join(path.dirname(__dirname), 'config.yaml');
}

const CONFIG_PATH = resolveConfigPath();

const startupWarnings: string[] = [];

export function recordStartupWarning(message: string): void {
  startupWarnings.push(message);
}

export function getStartupWarnings(): string[] {
  return [...startupWarnings];
}

export function clearStartupWarnings(): void {
  startupWarnings.length = 0;
}

export function buildDefaultConfig(): GenieConfig {
  return deepClone(BASE_CONFIG);
}

export function loadConfig(): GenieConfig {
  let config = deepClone(buildDefaultConfig());
  const configFilePath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : null;

  if (configFilePath) {
    try {
      const raw = fs.readFileSync(configFilePath, 'utf8');
      if (raw.trim().length) {
        let parsed: any = {};
        if (YAML) {
          parsed = YAML.parse(raw) || {};
        } else if (raw.trim().startsWith('{')) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = {};
          }
        } else {
          recordStartupWarning('[genie] YAML module unavailable; ignoring config overrides. Install "yaml" to enable parsing.');
          parsed = {};
        }
        config = mergeDeep(config, parsed);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse ${configFilePath}: ${message}`);
    }
    config.__configPath = configFilePath;
  } else {
    config.__configPath = CONFIG_PATH;
  }

  // Ensure defaults exist
  config.defaults = config.defaults || {};
  if (!config.defaults.executor) config.defaults.executor = 'OPENCODE';
  if (!config.defaults.executorVariant) config.defaults.executorVariant = 'DEFAULT';
  config.defaults.background = config.defaults.background ?? false;

  config.forge = config.forge || { executors: {} };
  config.forge.executors = config.forge.executors || {};

  config.executionModes = config.executionModes || {};

  return config;
}

export function resolvePaths(paths: ConfigPaths): Required<ConfigPaths> {
  const baseDir = paths.baseDir ? path.resolve(paths.baseDir) : findWorkspaceRoot();
  const configuredTasksFile = paths.tasksFile || paths.sessionsFile;
  const tasksFile = configuredTasksFile
    ? path.resolve(baseDir, configuredTasksFile)
    : path.join(baseDir, '.genie/state/tasks.json');
  return {
    baseDir,
    tasksFile,
    sessionsFile: tasksFile,
    logsDir: paths.logsDir || path.join(baseDir, '.genie/state/agents/logs'),
    backgroundDir: paths.backgroundDir || path.join(baseDir, '.genie/state/agents/background')
  };
}

export function prepareDirectories(paths: Required<ConfigPaths>): void {
  [paths.logsDir, paths.backgroundDir, path.dirname(paths.tasksFile)].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

export function applyDefaults(options: CLIOptions, defaults?: GenieConfig['defaults']): void {
  // Only apply config defaults if user hasn't explicitly set --background or --no-background
  // The run command defaults to foreground (interactive) mode, so we don't force background: true
  // Users can still pass --background to enable headless mode
  if (!options.backgroundExplicit && defaults?.background !== undefined) {
    // Respect explicit config override, but don't force background: true by default
    // This allows the run command to default to foreground (interactive) mode
    options.background = defaults.background;
  }
  // Note: if backgroundExplicit is false and defaults.background is undefined,
  // options.background stays as initialized (false), enabling foreground mode
}
