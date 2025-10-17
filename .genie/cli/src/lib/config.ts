import fs from 'fs';
import path from 'path';
import type { GenieConfig, ConfigPaths, CLIOptions } from './types';
import { loadExecutors, DEFAULT_EXECUTOR_KEY } from '../executors';
import { deepClone, mergeDeep } from './utils';
import { findWorkspaceRoot } from './paths';

let YAML: typeof import('yaml') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  YAML = require('yaml');
} catch (_) {
  // yaml module optional
}

const EXECUTORS = loadExecutors();

const BASE_CONFIG: GenieConfig = {
  defaults: {
    background: true,
    executor: DEFAULT_EXECUTOR_KEY
  },
  paths: {
    baseDir: undefined,  // Triggers findWorkspaceRoot() in resolvePaths()
    sessionsFile: '.genie/state/agents/sessions.json',
    logsDir: '.genie/state/agents/logs',
    backgroundDir: '.genie/state/agents/background'
  },
  executors: {},
  executionModes: {
    default: {
      description: 'Workspace-write automation with GPT-5 Codex.',
      executor: DEFAULT_EXECUTOR_KEY,
      overrides: {
        exec: {
          model: 'gpt-5-codex',
          sandbox: 'workspace-write',
          fullAuto: true
        }
      }
    },
    careful: {
      description: 'Read-only approval-aware agent run.',
      overrides: {
        exec: {
          sandbox: 'read-only'
        }
      }
    },
    danger: {
      description: 'Full access execution for externally sandboxed environments only.',
      overrides: {
        exec: {
          sandbox: 'danger-full-access',
          fullAuto: false,
          additionalArgs: ['--dangerously-bypass-approvals-and-sandbox']
        }
      }
    },
    debug: {
      description: 'Enable plan tool and web search for architecture/deep analysis sessions.',
      overrides: {
        exec: {
          includePlanTool: true,
          search: true
        }
      }
    }
  },
  background: {
    enabled: true,
    detach: false,
    pollIntervalMs: 1500,
    sessionExtractionDelayMs: 5000
  }
};

const CONFIG_PATH = path.join(path.dirname(__dirname), 'config.yaml');

const PROVIDER_EXECUTOR: Record<string, string> = {
  codex: 'codex',
  claude: 'claude'
};

const PROVIDER_MODEL: Record<string, string> = {
  codex: 'gpt-5-codex',
  claude: 'sonnet-4.5'
};

const DEFAULT_MODE_DESCRIPTION: Record<string, string> = {
  codex: 'Workspace-write automation with GPT-5 Codex.',
  claude: 'Workspace automation with Claude Sonnet 4.5.'
};

const CLAUDE_EXEC_MODEL: Record<string, string> = {
  codex: 'sonnet',
  claude: 'sonnet-4.5'
};

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
  const config = deepClone(BASE_CONFIG);
  config.executors = config.executors || {};
  Object.entries(EXECUTORS).forEach(([key, executor]) => {
    config.executors![key] = executor.defaults || {};
  });
  return config;
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

  const provider = loadWorkspaceProvider();
  if (provider) {
    applyProviderOverrides(config, provider);
  }

  return config;
}


export function resolvePaths(paths: ConfigPaths): Required<ConfigPaths> {
  // Use findWorkspaceRoot() to detect actual workspace, not process.cwd()
  const baseDir = paths.baseDir ? path.resolve(paths.baseDir) : findWorkspaceRoot();
  return {
    baseDir,
    sessionsFile: paths.sessionsFile || path.join(baseDir, '.genie/state/agents/sessions.json'),
    logsDir: paths.logsDir || path.join(baseDir, '.genie/state/agents/logs'),
    backgroundDir: paths.backgroundDir || path.join(baseDir, '.genie/state/agents/background'),
    executors: paths.executors || {}
  };
}

export function prepareDirectories(paths: Required<ConfigPaths>): void {
  [paths.logsDir, paths.backgroundDir, path.dirname(paths.sessionsFile)].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

export function applyDefaults(options: CLIOptions, defaults?: GenieConfig['defaults']): void {
  if (!options.backgroundExplicit) {
    options.background = Boolean(defaults?.background);
  }
}

function loadWorkspaceProvider(): string | null {
  try {
    const providerPath = path.join(process.cwd(), '.genie', 'state', 'provider.json');
    if (!fs.existsSync(providerPath)) {
      return null;
    }
    const raw = fs.readFileSync(providerPath, 'utf8');
    if (!raw.trim().length) return null;
    const parsed = JSON.parse(raw);
    const value: unknown = parsed?.provider;
    if (typeof value !== 'string') return null;
    const normalized = value.toLowerCase();
    if (normalized.startsWith('claude')) return 'claude';
    return 'codex';
  } catch {
    return null;
  }
}

function applyProviderOverrides(config: GenieConfig, provider: string): void {
  const normalized = provider === 'claude' ? 'claude' : 'codex';
  const executor = PROVIDER_EXECUTOR[normalized];
  const model = PROVIDER_MODEL[normalized];

  if (!config.defaults) config.defaults = {};
  config.defaults.executor = executor;

  const executionModes = (config.executionModes = config.executionModes || {});
  const defaultMode = (executionModes.default = executionModes.default || {});
  defaultMode.description = DEFAULT_MODE_DESCRIPTION[normalized];
  defaultMode.executor = executor;
  defaultMode.overrides = defaultMode.overrides || {};
  defaultMode.overrides.exec = defaultMode.overrides.exec || {};
  defaultMode.overrides.exec.model = model;

  if (config.executors && config.executors.codex) {
    config.executors.codex.exec = config.executors.codex.exec || {};
  }

  if (config.executors && config.executors.claude) {
    config.executors.claude.exec = config.executors.claude.exec || {};
    config.executors.claude.exec.model = CLAUDE_EXEC_MODEL[normalized];
  }
}
