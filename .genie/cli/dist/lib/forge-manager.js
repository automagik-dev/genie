"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isForgeRunning = isForgeRunning;
exports.waitForForgeReady = waitForForgeReady;
exports.startForgeInBackground = startForgeInBackground;
exports.stopForge = stopForge;
exports.restartForge = restartForge;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// @ts-ignore - compiled client shipped at project root
const forge_js_1 = require("../../../../forge.js");
const DEFAULT_BASE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8888';
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
async function waitForForgeReady(baseUrl = DEFAULT_BASE_URL, timeoutMs = 30000, intervalMs = 500, showProgress = false) {
    const start = Date.now();
    let lastDot = 0;
    while (Date.now() - start < timeoutMs) {
        if (await isForgeRunning(baseUrl)) {
            if (showProgress)
                process.stderr.write('\n');
            return true;
        }
        // Show progress dots every 2 seconds
        if (showProgress && Date.now() - lastDot > 2000) {
            process.stderr.write('.');
            lastDot = Date.now();
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    if (showProgress)
        process.stderr.write('\n');
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
    // Extract port from baseUrl (e.g., http://localhost:8888 -> 8888)
    const port = new URL(baseUrl).port || '8888';
    // Use bundled automagik-forge binary directly (blazing fast - no extraction!)
    // Path works for both pnpm and npm installations
    const forgeBin = path_1.default.join(__dirname, '../../../../node_modules/.pnpm/automagik-forge@0.3.18/node_modules/automagik-forge/dist/linux-x64/automagik-forge');
    // Fallback to standard node_modules structure (npm)
    const forgeBinFallback = path_1.default.join(__dirname, '../../../../node_modules/automagik-forge/dist/linux-x64/automagik-forge');
    const binPath = fs_1.default.existsSync(forgeBin) ? forgeBin : forgeBinFallback;
    const child = (0, child_process_1.spawn)(binPath, [], {
        env: {
            ...process.env,
            PORT: port,
            FORGE_PORT: port,
            HOST: '0.0.0.0'
        },
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
async function restartForge(opts) {
    const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    const logDir = opts.logDir;
    const wasRunning = await isForgeRunning(baseUrl);
    if (wasRunning) {
        stopForge(logDir);
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    startForgeInBackground({ baseUrl, token: opts.token, logDir });
    return waitForForgeReady(baseUrl, 20000, 500);
}
