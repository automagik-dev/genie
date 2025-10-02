import type { GenieConfig, ConfigPaths } from './types';
import type { Executor } from '../executors/types';
import { EXECUTORS, DEFAULT_EXECUTOR_KEY } from './executor-registry';
import { deepClone, mergeDeep } from './utils';

/**
 * Resolve which executor key to use
 */
export function resolveExecutorKey(config: GenieConfig, modeName: string): string {
  const modeConfig = config.executionModes?.[modeName] || config.presets?.[modeName];
  if (modeConfig?.executor && modeConfig.executor !== DEFAULT_EXECUTOR_KEY) {
    return modeConfig.executor;
  }
  return config.defaults?.executor || DEFAULT_EXECUTOR_KEY;
}

/**
 * Get executor instance or throw if not found
 */
export function requireExecutor(executorKey: string): Executor {
  const executor = EXECUTORS[executorKey];
  if (!executor) {
    const available = Object.keys(EXECUTORS).join(', ');
    throw new Error(`Executor '${executorKey}' not found. Available: ${available}`);
  }
  return executor;
}

/**
 * Extract executor-specific overrides from agent metadata
 */
export function extractExecutorOverrides(agentGenie: any, executorKey: string): any {
  const overrides: any = {};

  // Common properties that map to executor config
  const directMappings: Record<string, string> = {
    model: 'model',
    reasoningEffort: 'reasoningEffort',
    reasoning_effort: 'reasoningEffort',
    permissionMode: 'permissionMode',
    permission_mode: 'permissionMode',
    sandbox: 'sandbox',
    allowedTools: 'allowedTools',
    allowed_tools: 'allowedTools',
    systemPrompt: 'systemPrompt',
    system_prompt: 'systemPrompt'
  };

  Object.entries(directMappings).forEach(([sourceKey, targetKey]) => {
    const value = agentGenie[sourceKey];
    if (value !== undefined && value !== null && value !== '') {
      overrides[targetKey] = value;
    }
  });

  return overrides;
}

/**
 * Build complete executor configuration from various sources
 */
export function buildExecutorConfig(
  config: GenieConfig,
  modeName: string,
  executorKey: string,
  overrides: any = {}
): any {
  const configBase = deepClone(config.executors?.[executorKey] || {});
  const modeConfig = config.executionModes?.[modeName] || config.presets?.[modeName] || {};
  const globalDefaults = config.defaults || {};

  // Start with base config
  let executorConfig = configBase;

  // Apply mode-specific executor config if exists
  if (modeConfig.executors && modeConfig.executors[executorKey]) {
    executorConfig = mergeDeep(executorConfig, modeConfig.executors[executorKey]);
  }

  // Apply global defaults (lower priority)
  if (globalDefaults) {
    const globalApplicable: any = {};
    ['model', 'permissionMode', 'sandbox', 'reasoningEffort'].forEach(key => {
      if (globalDefaults[key as keyof typeof globalDefaults] !== undefined) {
        globalApplicable[key] = globalDefaults[key as keyof typeof globalDefaults];
      }
    });
    executorConfig = mergeDeep(globalApplicable, executorConfig);
  }

  // Apply agent-specific overrides (highest priority)
  if (overrides && Object.keys(overrides).length > 0) {
    executorConfig = mergeDeep(executorConfig, overrides);
  }

  return executorConfig;
}

/**
 * Resolve executor-specific paths
 */
export function resolveExecutorPaths(paths: Required<ConfigPaths>, executorKey: string): Required<ConfigPaths> {
  return {
    ...paths
  };
}