#!/usr/bin/env node
/**
 * postinstall-tmux.js — Download tmux static binary if not on PATH.
 *
 * Runs during `bun add -g @automagik/genie` and callable from smart-install.js.
 * Downloads from the official tmux-builds repository:
 *   https://github.com/tmux/tmux-builds
 *
 * Standalone — no imports outside node builtins.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMUX_VERSION = '3.6a';
const GENIE_HOME = process.env.GENIE_HOME || join(homedir(), '.genie');
const BIN_DIR = join(GENIE_HOME, 'bin');
const TMUX_PATH = join(BIN_DIR, 'tmux');

// Resolve our own package.json so we can read the binarySha256 pin block.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_JSON_PATH = resolvePath(__dirname, '..', 'package.json');

/**
 * Look up the pinned SHA-256 for a downloaded asset. Returns:
 *   - { kind: 'pinned', sha256 }  — pin found, MUST verify
 *   - { kind: 'unpinned' }        — no pin block present (older install or local dev)
 *   - { kind: 'missing-key' }     — pin block present but this asset key is absent (treat as fail)
 *
 * Pinning is mandatory in the wished design: a missing key for a downloaded
 * asset is a hard failure, not a soft warning. The only soft case is when
 * binarySha256 is entirely absent (e.g. running this script standalone outside
 * the published package).
 */
function getPinnedSha(assetName) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(PKG_JSON_PATH, 'utf-8'));
  } catch (err) {
    return { kind: 'unpinned', reason: `cannot read ${PKG_JSON_PATH}: ${err.message}` };
  }
  const block = pkg?.binarySha256;
  if (!block || typeof block !== 'object') return { kind: 'unpinned' };
  const sha = block[assetName];
  if (typeof sha === 'string' && /^[a-f0-9]{64}$/i.test(sha)) {
    return { kind: 'pinned', sha256: sha.toLowerCase() };
  }
  return { kind: 'missing-key' };
}

function sha256OfBuffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

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

    // SHA-256 verification BEFORE writing to disk and BEFORE chmod +x.
    // Pin-or-fail: a tampered tarball or a download corruption aborts the
    // install with a clear message. Same code path that produced empty
    // bin/bun on 2026-05-05 is the path a tarball-swap attack would exploit.
    const pin = getPinnedSha(asset);
    const actual = sha256OfBuffer(buffer);
    if (pin.kind === 'pinned') {
      if (actual.toLowerCase() !== pin.sha256) {
        console.error(
          `[genie] Error: ${asset} SHA-256 mismatch — expected ${pin.sha256}, got ${actual}. Aborting install.`,
        );
        return false;
      }
      console.error(`[genie] SHA-256 verified: ${actual.slice(0, 12)}…`);
    } else if (pin.kind === 'missing-key') {
      console.error(`[genie] Error: ${asset} has no SHA-256 pin in package.json#binarySha256. Aborting install.`);
      console.error(
        '[genie] Add the expected SHA-256 to the binarySha256 block. See .genie/wishes/dep-hygiene-and-resilience/binary-sha-bootstrap.md.',
      );
      return false;
    } else {
      // Unpinned (e.g. running this script outside a published package). Soft warning;
      // operators running from a clean clone may not have computed pins yet.
      console.error(
        `[genie] Warning: no binarySha256 block found in package.json — skipping SHA verification for ${asset}.`,
      );
      console.error('[genie] This path is for local-dev only; published installs must pin.');
    }

    mkdirSync(tempDir, { recursive: true });
    const tarball = join(tempDir, asset);
    writeFileSync(tarball, buffer);

    // Use spawnSync with args array to avoid shell injection with special path chars
    const tarResult = spawnSync('tar', ['-xzf', tarball, '-C', tempDir], { stdio: 'ignore' });
    if (tarResult.status !== 0) throw new Error('Failed to extract tmux tarball');

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

/**
 * Ensure tmux is available — download if missing.
 * Exported for use by smart-install.js and other callers.
 */
export async function ensureTmux() {
  if (isTmuxOnPath() || isTmuxCached()) return true;
  return downloadTmux();
}

// Run directly when invoked as a script (postinstall or CLI)
await ensureTmux();
