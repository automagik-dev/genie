"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyDefaults = exports.prepareDirectories = exports.resolvePaths = exports.loadConfig = exports.buildDefaultConfig = exports.clearStartupWarnings = exports.getStartupWarnings = exports.recordStartupWarning = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const utils_1 = require("./utils");
const paths_1 = require("./paths");
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
        const root = (0, paths_1.findWorkspaceRoot)();
        const projectConfig = path_1.default.join(root, '.genie', 'config.yaml');
        if (fs_1.default.existsSync(projectConfig))
            return projectConfig;
    }
    catch (_) { }
    return path_1.default.join(path_1.default.dirname(__dirname), 'config.yaml');
}
const CONFIG_PATH = resolveConfigPath();
const startupWarnings = [];
function recordStartupWarning(message) {
    startupWarnings.push(message);
}
exports.recordStartupWarning = recordStartupWarning;
function getStartupWarnings() {
    return [...startupWarnings];
}
exports.getStartupWarnings = getStartupWarnings;
function clearStartupWarnings() {
    startupWarnings.length = 0;
}
exports.clearStartupWarnings = clearStartupWarnings;
function buildDefaultConfig() {
    return (0, utils_1.deepClone)(BASE_CONFIG);
}
exports.buildDefaultConfig = buildDefaultConfig;
function loadConfig() {
    let config = (0, utils_1.deepClone)(buildDefaultConfig());
    const configFilePath = fs_1.default.existsSync(CONFIG_PATH) ? CONFIG_PATH : null;
    if (configFilePath) {
        try {
            const raw = fs_1.default.readFileSync(configFilePath, 'utf8');
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
                config = (0, utils_1.mergeDeep)(config, parsed);
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
exports.loadConfig = loadConfig;
function resolvePaths(paths) {
    const baseDir = paths.baseDir ? path_1.default.resolve(paths.baseDir) : (0, paths_1.findWorkspaceRoot)();
    return {
        baseDir,
        sessionsFile: paths.sessionsFile || path_1.default.join(baseDir, '.genie/state/agents/sessions.json'),
        logsDir: paths.logsDir || path_1.default.join(baseDir, '.genie/state/agents/logs'),
        backgroundDir: paths.backgroundDir || path_1.default.join(baseDir, '.genie/state/agents/background')
    };
}
exports.resolvePaths = resolvePaths;
function prepareDirectories(paths) {
    [paths.logsDir, paths.backgroundDir, path_1.default.dirname(paths.sessionsFile)].forEach((dir) => {
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
    });
}
exports.prepareDirectories = prepareDirectories;
function applyDefaults(options, defaults) {
    if (!options.backgroundExplicit) {
        options.background = Boolean(defaults?.background);
    }
}
exports.applyDefaults = applyDefaults;
