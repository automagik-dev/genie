import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// @ts-ignore - compiled client shipped at project root
import { ForgeClient } from '../../../../forge.js';

export interface ForgeStartOptions {
  baseUrl?: string;
  token?: string;
  logDir: string;
}

const DEFAULT_BASE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8888';

export async function isForgeRunning(baseUrl: string = DEFAULT_BASE_URL): Promise<boolean> {
  try {
    const client = new ForgeClient(baseUrl, process.env.FORGE_TOKEN);
    const ok = await client.healthCheck();
    return Boolean(ok);
  } catch {
    return false;
  }
}

export async function waitForForgeReady(baseUrl: string = DEFAULT_BASE_URL, timeoutMs = 30000, intervalMs = 500, showProgress = false): Promise<boolean> {
  const start = Date.now();
  let lastDot = 0;

  while (Date.now() - start < timeoutMs) {
    if (await isForgeRunning(baseUrl)) {
      if (showProgress) process.stderr.write('\n');
      return true;
    }

    // Show progress dots every 2 seconds
    if (showProgress && Date.now() - lastDot > 2000) {
      process.stderr.write('.');
      lastDot = Date.now();
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  if (showProgress) process.stderr.write('\n');
  return false;
}

export function startForgeInBackground(opts: ForgeStartOptions): { childPid: number } {
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
  const logDir = opts.logDir;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'forge.log');
  const pidPath = path.join(logDir, 'forge.pid');

  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');

  // Use bundled automagik-forge binary directly (blazing fast - no extraction!)
  // Path works for both pnpm and npm installations
  const forgeBin = path.join(__dirname, '../../../../node_modules/.pnpm/automagik-forge@0.3.18/node_modules/automagik-forge/dist/linux-x64/automagik-forge');

  // Fallback to standard node_modules structure (npm)
  const forgeBinFallback = path.join(__dirname, '../../../../node_modules/automagik-forge/dist/linux-x64/automagik-forge');

  const binPath = fs.existsSync(forgeBin) ? forgeBin : forgeBinFallback;

  const child = spawn(binPath, ['start'], {
    env: { ...process.env },
    detached: true,
    stdio: ['ignore', out, err]
  });

  // Detach so it survives parent exit
  child.unref();

  try { fs.writeFileSync(pidPath, String(child.pid)); } catch {}

  return { childPid: child.pid ?? -1 };
}

export function stopForge(logDir: string): boolean {
  const pidPath = path.join(logDir, 'forge.pid');
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    if (!Number.isNaN(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        return true;
      } catch {
        return false;
      }
    }
  } catch {}
  return false;
}

export async function restartForge(opts: ForgeStartOptions): Promise<boolean> {
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
