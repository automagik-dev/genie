"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isForgeRunning = isForgeRunning;
exports.waitForForgeReady = waitForForgeReady;
exports.startForgeInBackground = startForgeInBackground;
exports.stopForge = stopForge;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// @ts-ignore - compiled client shipped at project root
const forge_js_1 = require("../../../../forge.js");
const DEFAULT_BASE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
async function isForgeRunning(baseUrl = DEFAULT_BASE_URL) {
    try {
        const client = new forge_js_1.ForgeClient(baseUrl, process.env.FORGE_TOKEN);
        const ok = await client.healthCheck();
        return Boolean(ok);
    }
    catch {
        return false;
    }
}
async function waitForForgeReady(baseUrl = DEFAULT_BASE_URL, timeoutMs = 15000, intervalMs = 500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isForgeRunning(baseUrl))
            return true;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
}
function startForgeInBackground(opts) {
    const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    const logDir = opts.logDir;
    fs_1.default.mkdirSync(logDir, { recursive: true });
    const logPath = path_1.default.join(logDir, 'forge.log');
    const pidPath = path_1.default.join(logDir, 'forge.pid');
    const out = fs_1.default.openSync(logPath, 'a');
    const err = fs_1.default.openSync(logPath, 'a');
    // Prefer explicit start subcommand; fall back to default
    const child = (0, child_process_1.spawn)('npx', ['--yes', 'automagik-forge', 'start'], {
        env: { ...process.env, npm_config_yes: 'true', NPM_CONFIG_YES: 'true', CI: '1' },
        detached: true,
        stdio: ['ignore', out, err]
    });
    // Detach so it survives parent exit
    child.unref();
    try {
        fs_1.default.writeFileSync(pidPath, String(child.pid));
    }
    catch { }
    return { childPid: child.pid ?? -1 };
}
function stopForge(logDir) {
    const pidPath = path_1.default.join(logDir, 'forge.pid');
    try {
        const pid = parseInt(fs_1.default.readFileSync(pidPath, 'utf8').trim(), 10);
        if (!Number.isNaN(pid)) {
            try {
                process.kill(pid, 'SIGTERM');
                return true;
            }
            catch {
                return false;
            }
        }
    }
    catch { }
    return false;
}
