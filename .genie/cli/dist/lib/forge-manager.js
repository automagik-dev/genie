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
exports.getForgeProcess = getForgeProcess;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// @ts-ignore - compiled client shipped at project root
const forge_js_1 = require("../../../../forge.js");
const DEFAULT_BASE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';
const HEALTH_CHECK_TIMEOUT = 3000; // 3s per health check
const MAX_HEALTH_RETRIES = 3;
/**
 * Health check with retry logic and exponential backoff
 */
async function isForgeRunning(baseUrl = DEFAULT_BASE_URL, retries = MAX_HEALTH_RETRIES) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const client = new forge_js_1.ForgeClient(baseUrl, process.env.FORGE_TOKEN);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);
            const ok = await client.healthCheck();
            clearTimeout(timeout);
            if (ok)
                return true;
        }
        catch (error) {
            // Exponential backoff: 100ms, 200ms, 400ms
            if (attempt < retries - 1) {
                await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
            }
        }
    }
    return false;
}
/**
 * Wait for Forge to become ready with progress indication
 */
async function waitForForgeReady(baseUrl = DEFAULT_BASE_URL, timeoutMs = 60000, intervalMs = 500, showProgress = false) {
    const start = Date.now();
    let lastDot = 0;
    let consecutiveFailures = 0;
    while (Date.now() - start < timeoutMs) {
        const isRunning = await isForgeRunning(baseUrl, 1); // Single attempt per poll
        if (isRunning) {
            if (showProgress)
                process.stderr.write('\n');
            return true;
        }
        consecutiveFailures++;
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
/**
 * Resolve automagik-forge binary path (version-agnostic)
 *
 * When installed via npm/pnpm/npx, automagik-forge is a sibling dependency in parent node_modules.
 * __dirname is .genie/cli/dist/lib/, so we go up 5 levels to reach parent node_modules/
 */
function resolveForgeBinary() {
    const baseDir = path_1.default.join(__dirname, '../../../../../');
    // Try standard npm/npx structure first (fastest)
    // automagik-forge is a sibling in node_modules/
    const npmPath = path_1.default.join(baseDir, 'automagik-forge/bin/cli.js');
    if (fs_1.default.existsSync(npmPath)) {
        return { ok: true, value: npmPath };
    }
    // Try pnpm structure with glob pattern (version-agnostic)
    try {
        const pnpmBase = path_1.default.join(baseDir, '.pnpm');
        if (fs_1.default.existsSync(pnpmBase)) {
            const entries = fs_1.default.readdirSync(pnpmBase);
            const forgeDir = entries.find(e => e.startsWith('automagik-forge@'));
            if (forgeDir) {
                const pnpmPath = path_1.default.join(pnpmBase, forgeDir, 'node_modules/automagik-forge/bin/cli.js');
                if (fs_1.default.existsSync(pnpmPath)) {
                    return { ok: true, value: pnpmPath };
                }
            }
        }
    }
    catch (error) {
        return {
            ok: false,
            error: new Error(`Failed to resolve pnpm structure: ${error}`)
        };
    }
    return {
        ok: false,
        error: new Error('automagik-forge binary not found in node_modules')
    };
}
/**
 * Parse port from URL with fallback
 */
function parsePort(baseUrl) {
    try {
        return new URL(baseUrl).port || '8887';
    }
    catch {
        return '8887';
    }
}
/**
 * Start Forge in background with comprehensive error handling
 */
function startForgeInBackground(opts) {
    const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    const logDir = opts.logDir;
    // Ensure log directory exists
    try {
        fs_1.default.mkdirSync(logDir, { recursive: true });
    }
    catch (error) {
        return {
            ok: false,
            error: new Error(`Failed to create log directory: ${error}`)
        };
    }
    const logPath = path_1.default.join(logDir, 'forge.log');
    const pidPath = path_1.default.join(logDir, 'forge.pid');
    // Resolve binary path
    const binaryResult = resolveForgeBinary();
    if (!binaryResult.ok) {
        return binaryResult;
    }
    const binPath = binaryResult.value;
    const port = parsePort(baseUrl);
    // Open log files (will be inherited by child)
    let logFd;
    try {
        logFd = fs_1.default.openSync(logPath, 'a');
    }
    catch (error) {
        return {
            ok: false,
            error: new Error(`Failed to open log file: ${error}`)
        };
    }
    // Spawn process with error handling
    let child;
    try {
        child = (0, child_process_1.spawn)('node', [binPath], {
            env: {
                ...process.env,
                PORT: port,
                FORGE_PORT: port,
                BACKEND_PORT: port,
                HOST: '0.0.0.0'
            },
            detached: true,
            stdio: ['ignore', logFd, logFd]
        });
    }
    catch (error) {
        fs_1.default.closeSync(logFd);
        return {
            ok: false,
            error: new Error(`Failed to spawn Forge process: ${error}`)
        };
    }
    // Handle spawn errors
    child.on('error', (error) => {
        fs_1.default.appendFileSync(logPath, `\n[SPAWN ERROR] ${error}\n`);
    });
    // Handle early exit (crash during startup)
    child.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
            fs_1.default.appendFileSync(logPath, `\n[EARLY EXIT] Process exited with code ${code}, signal ${signal}\n`);
        }
    });
    // Detach so it survives parent exit
    child.unref();
    // Close our handle to log file (child has inherited it)
    fs_1.default.closeSync(logFd);
    // Write PID file
    const pid = child.pid ?? -1;
    if (pid > 0) {
        try {
            fs_1.default.writeFileSync(pidPath, String(pid), 'utf8');
        }
        catch (error) {
            // Non-fatal: log but continue
            fs_1.default.appendFileSync(logPath, `\n[WARNING] Failed to write PID file: ${error}\n`);
        }
    }
    return {
        ok: true,
        value: {
            pid,
            startTime: Date.now(),
            binPath
        }
    };
}
/**
 * Stop Forge process with verification
 */
async function stopForge(logDir) {
    const pidPath = path_1.default.join(logDir, 'forge.pid');
    let pid;
    try {
        const pidStr = fs_1.default.readFileSync(pidPath, 'utf8').trim();
        pid = parseInt(pidStr, 10);
        if (Number.isNaN(pid) || pid <= 0) {
            return false;
        }
    }
    catch {
        return false;
    }
    // Send SIGTERM
    try {
        process.kill(pid, 'SIGTERM');
    }
    catch (error) {
        // Process might already be dead
        return false;
    }
    // Wait for process to exit (max 5 seconds)
    for (let i = 0; i < 50; i++) {
        try {
            // Check if process still exists (throws if dead)
            process.kill(pid, 0);
            await new Promise(r => setTimeout(r, 100));
        }
        catch {
            // Process is dead
            try {
                fs_1.default.unlinkSync(pidPath);
            }
            catch { }
            return true;
        }
    }
    // Force kill if still alive
    try {
        process.kill(pid, 'SIGKILL');
        fs_1.default.unlinkSync(pidPath);
    }
    catch { }
    return true;
}
/**
 * Restart Forge with proper shutdown and startup
 */
async function restartForge(opts) {
    const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    const logDir = opts.logDir;
    // Check if already running
    const wasRunning = await isForgeRunning(baseUrl);
    if (wasRunning) {
        const stopped = await stopForge(logDir);
        if (!stopped) {
            return {
                ok: false,
                error: new Error('Failed to stop existing Forge process')
            };
        }
        // Wait for port to be released
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    // Start new instance
    const startResult = startForgeInBackground(opts);
    if (!startResult.ok) {
        return startResult;
    }
    // Wait for ready
    const ready = await waitForForgeReady(baseUrl, 60000, 500);
    if (!ready) {
        return {
            ok: false,
            error: new Error('Forge did not become ready after restart')
        };
    }
    return startResult;
}
/**
 * Get Forge process info
 */
function getForgeProcess(logDir) {
    const pidPath = path_1.default.join(logDir, 'forge.pid');
    try {
        const pidStr = fs_1.default.readFileSync(pidPath, 'utf8').trim();
        const pid = parseInt(pidStr, 10);
        if (Number.isNaN(pid) || pid <= 0) {
            return null;
        }
        // Verify process is still running
        try {
            process.kill(pid, 0);
            return {
                pid,
                startTime: 0, // Unknown
                binPath: '' // Unknown
            };
        }
        catch {
            // Process is dead, clean up PID file
            fs_1.default.unlinkSync(pidPath);
            return null;
        }
    }
    catch {
        return null;
    }
}
