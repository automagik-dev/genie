#!/usr/bin/env node
/**
 * postinstall-tmux.js — Download tmux static binary if not on PATH.
 *
 * Runs during `bun add -g @automagik/genie` and from smart-install.js.
 * Downloads from the official tmux-builds repository:
 *   https://github.com/tmux/tmux-builds
 *
 * Standalone — no imports outside node builtins.
 */

import { execSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

const TMUX_VERSION = '3.6a';
const GENIE_HOME = process.env.GENIE_HOME || join(homedir(), '.genie');
const BIN_DIR = join(GENIE_HOME, 'bin');
const TMUX_PATH = join(BIN_DIR, 'tmux');

function getPlatformAsset() {
  const os = platform();
  const cpu = arch();
  const map = {
    'linux-x64': `tmux-${TMUX_VERSION}-linux-x86_64.tar.gz`,
    'linux-arm64': `tmux-${TMUX_VERSION}-linux-arm64.tar.gz`,
    'darwin-arm64': `tmux-${TMUX_VERSION}-macos-arm64.tar.gz`,
    'darwin-x64': `tmux-${TMUX_VERSION}-macos-x86_64.tar.gz`,
  };
  return map[`${os}-${cpu}`] || null;
}

function isTmuxOnPath() {
  try {
    const r = spawnSync('tmux', ['-V'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return r.status === 0;
  } catch {
    return false;
  }
}

function isTmuxCached() {
  if (!existsSync(TMUX_PATH)) return false;
  try {
    const r = spawnSync(TMUX_PATH, ['-V'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return r.status === 0;
  } catch {
    return false;
  }
}

async function downloadTmux() {
  const asset = getPlatformAsset();
  if (!asset) {
    const key = `${platform()}-${arch()}`;
    console.error(`[genie] tmux: no prebuilt binary for ${key}. Install tmux manually.`);
    return false;
  }

  const url =
    process.env.GENIE_TMUX_URL || `https://github.com/tmux/tmux-builds/releases/download/v${TMUX_VERSION}/${asset}`;

  const tempDir = join(tmpdir(), `genie-tmux-${Date.now()}`);

  console.error(`[genie] tmux not found — downloading ${asset}...`);

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);
    console.error(`[genie] Downloaded ${sizeMB} MB`);

    mkdirSync(tempDir, { recursive: true });
    const tarball = join(tempDir, asset);
    writeFileSync(tarball, buffer);

    execSync(`tar -xzf '${tarball}' -C '${tempDir}'`, { stdio: 'ignore' });

    const extracted = join(tempDir, 'tmux');
    if (!existsSync(extracted)) throw new Error('Tarball did not contain tmux binary');

    mkdirSync(BIN_DIR, { recursive: true });
    copyFileSync(extracted, TMUX_PATH);
    chmodSync(TMUX_PATH, 0o755);

    // Verify
    const r = spawnSync(TMUX_PATH, ['-V'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.status !== 0) throw new Error('Downloaded binary not executable on this system');

    console.error(`[genie] ${r.stdout.trim()} installed to ${TMUX_PATH}`);
    return true;
  } catch (err) {
    try {
      if (existsSync(TMUX_PATH)) unlinkSync(TMUX_PATH);
    } catch {}
    console.error(`[genie] tmux download failed: ${err.message}`);
    console.error('[genie] Install manually:');
    if (platform() === 'darwin') console.error('  brew install tmux');
    else console.error('  sudo apt install tmux');
    return false;
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

// Main
if (!isTmuxOnPath() && !isTmuxCached()) {
  downloadTmux().catch(() => {});
}
