import fs from 'fs';
import path from 'path';
import { deepClone, mergeDeep } from './utils';
import { findWorkspaceRoot } from './paths';
let YAML = null;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    YAML = require('yaml');
}
catch (_) {
    // yaml module optional
}
const BASE_CONFIG = {
    defaults: {
        executor: 'opencode',
        executorVariant: 'DEFAULT',
        background: true
    },
    paths: {
        baseDir: undefined,
        sessionsFile: '.genie/state/agents/sessions.json',
        logsDir: '.genie/state/agents/logs',
        backgroundDir: '.genie/state/agents/background'
    },
    forge: {
        executors: {}
    },
    executionModes: {}
};
function resolveConfigPath() {
    try {
        const root = findWorkspaceRoot();
        const projectConfig = path.join(root, '.genie', 'config.yaml');
        if (fs.existsSync(projectConfig))
            return projectConfig;
    }
    catch (_) { }
    return path.join(path.dirname(__dirname), 'config.yaml');
}
const CONFIG_PATH = resolveConfigPath();
const startupWarnings = [];
export function recordStartupWarning(message) {
    startupWarnings.push(message);
}
export function getStartupWarnings() {
    return [...startupWarnings];
}
export function clearStartupWarnings() {
    startupWarnings.length = 0;
}
export function buildDefaultConfig() {
    return deepClone(BASE_CONFIG);
}
export function loadConfig() {
    let config = deepClone(buildDefaultConfig());
    const configFilePath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : null;
    if (configFilePath) {
        try {
            const raw = fs.readFileSync(configFilePath, 'utf8');
            if (raw.trim().length) {
                let parsed = {};
                if (YAML) {
                    parsed = YAML.parse(raw) || {};
                }
                else if (raw.trim().startsWith('{')) {
                    try {
                        parsed = JSON.parse(raw);
                    }
                    catch {
                        parsed = {};
                    }
                }
                else {
                    recordStartupWarning('[genie] YAML module unavailable; ignoring config overrides. Install "yaml" to enable parsing.');
                    parsed = {};
                }
                config = mergeDeep(config, parsed);
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to parse ${configFilePath}: ${message}`);
        }
        config.__configPath = configFilePath;
    }
    else {
        config.__configPath = CONFIG_PATH;
    }
    // Ensure defaults exist
    config.defaults = config.defaults || {};
    if (!config.defaults.executor)
        config.defaults.executor = 'opencode';
    if (!config.defaults.executorVariant)
        config.defaults.executorVariant = 'DEFAULT';
    config.defaults.background = config.defaults.background ?? true;
    config.forge = config.forge || { executors: {} };
    config.forge.executors = config.forge.executors || {};
    config.executionModes = config.executionModes || {};
    return config;
}
export function resolvePaths(paths) {
    const baseDir = paths.baseDir ? path.resolve(paths.baseDir) : findWorkspaceRoot();
    return {
        baseDir,
        sessionsFile: paths.sessionsFile || path.join(baseDir, '.genie/state/agents/sessions.json'),
        logsDir: paths.logsDir || path.join(baseDir, '.genie/state/agents/logs'),
        backgroundDir: paths.backgroundDir || path.join(baseDir, '.genie/state/agents/background')
    };
}
export function prepareDirectories(paths) {
    [paths.logsDir, paths.backgroundDir, path.dirname(paths.sessionsFile)].forEach((dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}
export function applyDefaults(options, defaults) {
    if (!options.backgroundExplicit) {
        options.background = Boolean(defaults?.background);
    }
}
