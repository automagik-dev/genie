"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackgroundManager = exports.INTERNAL_BACKGROUND_MARKER_ENV = exports.INTERNAL_SESSION_ID_ENV = exports.INTERNAL_LOG_PATH_ENV = exports.INTERNAL_START_TIME_ENV = exports.INTERNAL_BACKGROUND_ENV = void 0;
const child_process_1 = require("child_process");
const events_1 = __importDefault(require("events"));
exports.INTERNAL_BACKGROUND_ENV = 'GENIE_AGENT_BACKGROUND_RUNNER';
exports.INTERNAL_START_TIME_ENV = 'GENIE_AGENT_START_TIME';
exports.INTERNAL_LOG_PATH_ENV = 'GENIE_AGENT_LOG_FILE';
// Propagate the pre-assigned session ID to the background runner so it updates
// the same store entry instead of creating a duplicate.
exports.INTERNAL_SESSION_ID_ENV = 'GENIE_AGENT_SESSION_ID';
exports.INTERNAL_BACKGROUND_MARKER_ENV = 'GENIE_INTERNAL_BACKGROUND';
class BackgroundManager extends events_1.default {
    constructor(options = {}) {
        super();
        this.children = new Map();
        this.execPath = options.execPath || process.execPath;
    }
    launch(options = {}) {
        const { rawArgs = [], startTime = Date.now(), logFile, backgroundConfig = {}, scriptPath, env: extraEnv = {} } = options;
        if (!backgroundConfig || backgroundConfig.enabled === false) {
            throw new Error('Background execution is disabled in configuration.');
        }
        if (!scriptPath) {
            throw new Error('BackgroundManager.launch requires a scriptPath.');
        }
        const spawnEnv = {
            ...process.env,
            ...extraEnv,
            [exports.INTERNAL_BACKGROUND_ENV]: '1',
            [exports.INTERNAL_BACKGROUND_MARKER_ENV]: '1',
            [exports.INTERNAL_START_TIME_ENV]: String(startTime),
            [exports.INTERNAL_LOG_PATH_ENV]: logFile ?? ''
        };
        const spawnOptions = {
            detached: Boolean(backgroundConfig.detach),
            // TypeScript's Node types express stdio as tuples; cast keeps the intent clear.
            stdio: (backgroundConfig.detach ? 'ignore' : 'inherit'),
            env: spawnEnv
        };
        const child = (0, child_process_1.spawn)(this.execPath, [scriptPath, ...rawArgs], spawnOptions);
        if (!child.pid) {
            throw new Error('Failed to spawn background process.');
        }
        const metadata = {
            pid: child.pid,
            rawArgs: [...rawArgs],
            logFile,
            startTime,
            launchedAt: new Date(),
            detach: Boolean(backgroundConfig.detach)
        };
        this.children.set(child.pid, metadata);
        child.on('exit', (code, signal) => {
            metadata.exitCode = code;
            metadata.signal = signal;
            metadata.exitedAt = new Date();
            this.children.delete(child.pid);
            this.emit('exit', metadata);
        });
        child.on('error', (error) => {
            const errInstance = error ?? new Error('Unknown background error');
            metadata.error = errInstance;
            this.emit('error', metadata, errInstance);
        });
        if (backgroundConfig.detach) {
            child.unref();
        }
        return child.pid;
    }
    stop(pid, signal = 'SIGTERM') {
        if (!pid || typeof pid !== 'number')
            return false;
        try {
            process.kill(pid, signal);
            return true;
        }
        catch (error) {
            if (isErrnoException(error) && error.code === 'ESRCH')
                return false;
            throw error;
        }
    }
    isAlive(pid) {
        if (!pid || typeof pid !== 'number')
            return false;
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (error) {
            if (isErrnoException(error) && error.code === 'EPERM')
                return true;
            return false;
        }
    }
    get(pid) {
        return this.children.get(pid) ?? null;
    }
    list() {
        return Array.from(this.children.values());
    }
}
exports.BackgroundManager = BackgroundManager;
function isErrnoException(error) {
    return typeof error === 'object' && error !== null && 'code' in error;
}
exports.default = BackgroundManager;
