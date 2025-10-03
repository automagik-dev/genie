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
        baseDir: '.',
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
        detach: true,
        pollIntervalMs: 1500,
        sessionExtractionDelayMs: 5000
    }
};
const CONFIG_PATH = path_1.default.join(path_1.default.dirname(__dirname), 'config.yaml');
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
    return config;
}
function resolvePaths(paths) {
    const baseDir = paths.baseDir || '.';
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
