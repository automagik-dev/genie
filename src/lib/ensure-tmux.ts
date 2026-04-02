/**
 * Ensure tmux is available — auto-provision from official builds if missing.
 *
 * Downloads prebuilt static binaries from the official tmux-builds repository
 * (https://github.com/tmux/tmux-builds) — same approach pgserve uses for
 * PostgreSQL binaries from @embedded-postgres.
 *
 * Supported platforms: linux-x64, linux-arm64, macos-arm64, macos-x64.
 *
 * Resolution order:
 *   1. System PATH (`which tmux`)
 *   2. Cached binary at `~/.genie/bin/tmux`
 *   3. Download from tmux/tmux-builds → extract → cache
 *
 * All tmux invocations should use `tmuxBin()` instead of bare `'tmux'`.
 */

import { execSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Pinned tmux version — bump when tmux-builds publishes a new release. */
const TMUX_VERSION = '3.6a';

/**
 * Map Node os identifiers to the tmux-builds asset naming convention.
 * Asset format: tmux-{version}-{platform}-{arch}.tar.gz
 */
function getPlatformAsset(): string {
  const os = platform();
  const cpu = arch();

  const key = `${os}-${cpu}`;
  const map: Record<string, string> = {
    'linux-x64': `tmux-${TMUX_VERSION}-linux-x86_64.tar.gz`,
    'linux-arm64': `tmux-${TMUX_VERSION}-linux-arm64.tar.gz`,
    'darwin-arm64': `tmux-${TMUX_VERSION}-macos-arm64.tar.gz`,
    'darwin-x64': `tmux-${TMUX_VERSION}-macos-x86_64.tar.gz`,
  };

  const asset = map[key];
  if (!asset) {
    throw new Error(
      `Unsupported platform: ${key}\ntmux auto-download supports: linux-x64, linux-arm64, macos-arm64, macos-x64.\nInstall tmux manually: https://github.com/tmux/tmux/wiki/Installing`,
    );
  }
  return asset;
}

function genieHome(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

function genieBinDir(): string {
  return join(genieHome(), 'bin');
}

function cachedTmuxPath(): string {
  return join(genieBinDir(), 'tmux');
}

// Cached result — resolved once per process
let _resolved: string | null = null;

/**
 * Return the tmux binary path. Cached after first resolution.
 * Prefers system tmux, falls back to ~/.genie/bin/tmux.
 * Returns bare 'tmux' if neither exists yet (caller should run ensureTmux() first).
 */
export function tmuxBin(): string {
  if (_resolved) return _resolved;

  // 1. System PATH
  try {
    const p = execSync('which tmux', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (p) {
      _resolved = p;
      return p;
    }
  } catch {}

  // 2. Cached binary from previous download
  const cached = cachedTmuxPath();
  if (existsSync(cached)) {
    _resolved = cached;
    return cached;
  }

  // Not yet available
  return 'tmux';
}

/**
 * Ensure tmux is available, downloading a static binary if needed.
 * Call once at startup (e.g., top of `genie serve`).
 * Returns the resolved binary path.
 */
export async function ensureTmux(): Promise<string> {
  const bin = tmuxBin();
  if (bin !== 'tmux') return bin;

  return downloadTmux();
}

/**
 * Download tmux from the official tmux-builds GitHub releases.
 *
 * Pattern follows pgserve's postgres.js:
 *   1. Resolve platform asset name
 *   2. Download tarball to temp dir
 *   3. Extract with `tar`
 *   4. Move binary to ~/.genie/bin/tmux
 *   5. Verify with `tmux -V`
 *   6. Clean up temp
 */
async function downloadTmux(): Promise<string> {
  const asset = getPlatformAsset();
  const url =
    process.env.GENIE_TMUX_URL ?? `https://github.com/tmux/tmux-builds/releases/download/v${TMUX_VERSION}/${asset}`;

  const dest = cachedTmuxPath();
  const tempDir = join(tmpdir(), `genie-tmux-download-${Date.now()}`);

  console.log('  tmux not found — downloading static binary...');
  console.log(`  ${url}`);

  try {
    // 1. Download tarball
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1);
    console.log(`  Downloaded ${sizeMB} MB`);

    // 2. Write tarball to temp
    mkdirSync(tempDir, { recursive: true });
    const tarballPath = join(tempDir, asset);
    writeFileSync(tarballPath, buffer);

    // 3. Extract — tarball contains a single 'tmux' binary at root
    execSync(`tar -xzf '${tarballPath}' -C '${tempDir}'`, { stdio: 'ignore' });

    const extractedBin = join(tempDir, 'tmux');
    if (!existsSync(extractedBin)) {
      throw new Error('Tarball did not contain a tmux binary');
    }

    // 4. Move to cache (copy, not rename — may cross filesystem boundaries with /tmp)
    mkdirSync(genieBinDir(), { recursive: true });
    copyFileSync(extractedBin, dest);
    chmodSync(dest, 0o755);

    // 5. Verify
    const version = execSync(`'${dest}' -V`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    _resolved = dest;
    console.log(`  ${version} installed to ${dest}`);

    return dest;
  } catch (err) {
    // Clean up partial download
    try {
      if (existsSync(dest)) unlinkSync(dest);
    } catch {}

    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to download tmux: ${msg}\nInstall manually:\n  Linux: sudo apt install tmux\n  macOS: brew install tmux`,
    );
  } finally {
    // Always clean up temp dir
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}
