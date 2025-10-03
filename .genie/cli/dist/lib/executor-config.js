"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveExecutorKey = resolveExecutorKey;
exports.requireExecutor = requireExecutor;
exports.extractExecutorOverrides = extractExecutorOverrides;
exports.buildExecutorConfig = buildExecutorConfig;
exports.resolveExecutorPaths = resolveExecutorPaths;
const executor_registry_1 = require("./executor-registry");
const utils_1 = require("./utils");
/**
 * Resolve which executor key to use
 */
function resolveExecutorKey(config, modeName) {
    const modeConfig = config.executionModes?.[modeName] || config.presets?.[modeName];
    if (modeConfig?.executor && modeConfig.executor !== executor_registry_1.DEFAULT_EXECUTOR_KEY) {
        return modeConfig.executor;
    }
    return config.defaults?.executor || executor_registry_1.DEFAULT_EXECUTOR_KEY;
}
/**
 * Get executor instance or throw if not found
 */
function requireExecutor(executorKey) {
    const executor = executor_registry_1.EXECUTORS[executorKey];
    if (!executor) {
        const available = Object.keys(executor_registry_1.EXECUTORS).join(', ');
        throw new Error(`Executor '${executorKey}' not found. Available: ${available}`);
    }
    return executor;
}
/**
 * Extract executor-specific overrides from agent metadata
 */
function extractExecutorOverrides(agentGenie, executorKey) {
    const overrides = {};
    // Common properties that map to executor config
    const directMappings = {
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
function buildExecutorConfig(config, modeName, executorKey, overrides = {}) {
    const configBase = (0, utils_1.deepClone)(config.executors?.[executorKey] || {});
    const modeConfig = config.executionModes?.[modeName] || config.presets?.[modeName] || {};
    const globalDefaults = config.defaults || {};
    // Start with base config
    let executorConfig = configBase;
    // Apply mode-specific executor config if exists
    if (modeConfig.executors && modeConfig.executors[executorKey]) {
        executorConfig = (0, utils_1.mergeDeep)(executorConfig, modeConfig.executors[executorKey]);
    }
    // Apply global defaults (lower priority)
    if (globalDefaults) {
        const globalApplicable = {};
        ['model', 'permissionMode', 'sandbox', 'reasoningEffort'].forEach(key => {
            if (globalDefaults[key] !== undefined) {
                globalApplicable[key] = globalDefaults[key];
            }
        });
        executorConfig = (0, utils_1.mergeDeep)(globalApplicable, executorConfig);
    }
    // Apply agent-specific overrides (highest priority)
    if (overrides && Object.keys(overrides).length > 0) {
        executorConfig = (0, utils_1.mergeDeep)(executorConfig, overrides);
    }
    return executorConfig;
}
/**
 * Resolve executor-specific paths
 */
function resolveExecutorPaths(paths, executorKey) {
    return {
        ...paths
    };
}
