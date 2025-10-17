"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordStartupWarning = recordStartupWarning;
exports.getStartupWarnings = getStartupWarnings;
exports.clearStartupWarnings = clearStartupWarnings;
exports.buildDefaultConfig = buildDefaultConfig;
exports.loadConfig = loadConfig;
exports.resolvePaths = resolvePaths;
exports.prepareDirectories = prepareDirectories;
exports.applyDefaults = applyDefaults;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const executors_1 = require("../executors");
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
const EXECUTORS = (0, executors_1.loadExecutors)();
const BASE_CONFIG = {
    defaults: {
        background: true,
        executor: executors_1.DEFAULT_EXECUTOR_KEY
    },
    paths: {
        baseDir: undefined, // Triggers findWorkspaceRoot() in resolvePaths()
        sessionsFile: '.genie/state/agents/sessions.json',
        logsDir: '.genie/state/agents/logs',
        backgroundDir: '.genie/state/agents/background'
    },
    executors: {},
    executionModes: {
        default: {
            description: 'Workspace-write automation with GPT-5 Codex.',
            executor: executors_1.DEFAULT_EXECUTOR_KEY,
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
const CONFIG_PATH = path_1.default.join(path_1.default.dirname(__dirname), 'config.yaml');
const PROVIDER_EXECUTOR = {
    codex: 'codex',
    claude: 'claude'
};
const PROVIDER_MODEL = {
    codex: 'gpt-5-codex',
    claude: 'sonnet-4.5'
};
const DEFAULT_MODE_DESCRIPTION = {
    codex: 'Workspace-write automation with GPT-5 Codex.',
    claude: 'Workspace automation with Claude Sonnet 4.5.'
};
const CLAUDE_EXEC_MODEL = {
    codex: 'sonnet',
    claude: 'sonnet-4.5'
};
const startupWarnings = [];
function recordStartupWarning(message) {
    startupWarnings.push(message);
}
function getStartupWarnings() {
    return [...startupWarnings];
}
function clearStartupWarnings() {
    startupWarnings.length = 0;
}
function buildDefaultConfig() {
    const config = (0, utils_1.deepClone)(BASE_CONFIG);
    config.executors = config.executors || {};
    Object.entries(EXECUTORS).forEach(([key, executor]) => {
        config.executors[key] = executor.defaults || {};
    });
    return config;
}
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
    const provider = loadWorkspaceProvider();
    if (provider) {
        applyProviderOverrides(config, provider);
    }
    return config;
}
function resolvePaths(paths) {
    // Use findWorkspaceRoot() to detect actual workspace, not process.cwd()
    const baseDir = paths.baseDir ? path_1.default.resolve(paths.baseDir) : (0, paths_1.findWorkspaceRoot)();
    return {
        baseDir,
        sessionsFile: paths.sessionsFile || path_1.default.join(baseDir, '.genie/state/agents/sessions.json'),
        logsDir: paths.logsDir || path_1.default.join(baseDir, '.genie/state/agents/logs'),
        backgroundDir: paths.backgroundDir || path_1.default.join(baseDir, '.genie/state/agents/background'),
        executors: paths.executors || {}
    };
}
function prepareDirectories(paths) {
    [paths.logsDir, paths.backgroundDir, path_1.default.dirname(paths.sessionsFile)].forEach((dir) => {
        if (!fs_1.default.existsSync(dir)) {
            fs_1.default.mkdirSync(dir, { recursive: true });
        }
    });
}
function applyDefaults(options, defaults) {
    if (!options.backgroundExplicit) {
        options.background = Boolean(defaults?.background);
    }
}
function loadWorkspaceProvider() {
    try {
        const providerPath = path_1.default.join(process.cwd(), '.genie', 'state', 'provider.json');
        if (!fs_1.default.existsSync(providerPath)) {
            return null;
        }
        const raw = fs_1.default.readFileSync(providerPath, 'utf8');
        if (!raw.trim().length)
            return null;
        const parsed = JSON.parse(raw);
        const value = parsed?.provider;
        if (typeof value !== 'string')
            return null;
        const normalized = value.toLowerCase();
        if (normalized.startsWith('claude'))
            return 'claude';
        return 'codex';
    }
    catch {
        return null;
    }
}
function applyProviderOverrides(config, provider) {
    const normalized = provider === 'claude' ? 'claude' : 'codex';
    const executor = PROVIDER_EXECUTOR[normalized];
    const model = PROVIDER_MODEL[normalized];
    if (!config.defaults)
        config.defaults = {};
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
