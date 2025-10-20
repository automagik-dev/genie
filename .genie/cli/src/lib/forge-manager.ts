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

const DEFAULT_BASE_URL = process.env.FORGE_BASE_URL || 'http://localhost:8887';

export async function isForgeRunning(baseUrl: string = DEFAULT_BASE_URL): Promise<boolean> {
  try {
    const client = new ForgeClient(baseUrl, process.env.FORGE_TOKEN);
    const ok = await client.healthCheck();
    return Boolean(ok);
  } catch {
    return false;
  }
}

export async function waitForForgeReady(baseUrl: string = DEFAULT_BASE_URL, timeoutMs = 15000, intervalMs = 500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isForgeRunning(baseUrl)) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
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

  // Prefer explicit start subcommand; fall back to default
  const child = spawn('npx', ['--yes', 'automagik-forge', 'start'], {
    env: { ...process.env, npm_config_yes: 'true', NPM_CONFIG_YES: 'true', CI: '1' },
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
