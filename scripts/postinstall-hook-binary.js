#!/usr/bin/env node
/**
 * postinstall-hook-binary.js — Compile the genie-hook thin client binary.
 *
 * Runs during `bun add -g @automagik/genie` (and during local `bun install`
 * via the postinstall script). Produces a static binary at
 * `~/.genie/bin/genie-hook` that the hook injector prefers over the
 * bun-fork fallback (`genie hook dispatch`).
 *
 * The binary is the precondition for the hookify-perf-foundation cold-start
 * win: ~80–200ms bun fork → ~10ms native binary that talks to the daemon
 * UDS at `~/.genie/hook.sock`. Without this, every CC tool call still pays
 * the full bun startup cost on the hot path.
 *
 * The build is platform-specific (Linux x64 binary doesn't run on macOS arm64,
 * etc.). We compile against the user's installed `bun` so the produced binary
 * targets their actual platform — no cross-compilation matrix needed.
 *
 * Failure modes:
 *   - bun missing on PATH: skip silently (genie ships bun via package deps,
 *     but a sandboxed install might not surface it). Hook injector falls back
 *     to bun-fork at runtime.
 *   - `bun build --compile` fails: print error, skip. Same fallback applies.
 *   - Read-only $HOME (CI): skip silently.
 *
 * Standalone — no imports outside node builtins.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

/**
 * Resolve the dispatch-client entry point. Published tarballs ship the
 * pre-bundled JS at `dist/dispatch-client.js` (built by `prepack`); local
 * development runs against the TS source at `src/hooks/dispatch-client.ts`.
 * Prefer the bundled artifact when present so installs are deterministic.
 */
function resolveEntry() {
  const dist = join(PKG_ROOT, 'dist', 'dispatch-client.js');
  if (existsSync(dist)) return dist;
  const src = join(PKG_ROOT, 'src', 'hooks', 'dispatch-client.ts');
  if (existsSync(src)) return src;
  return null;
}

const ENTRY = resolveEntry();

const HOME = process.env.GENIE_HOME ?? join(homedir(), '.genie');
const BIN_DIR = join(HOME, 'bin');
const BIN_PATH = join(BIN_DIR, 'genie-hook');

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function findBun() {
  // Prefer bun on PATH (matches what the user invokes interactively).
  const onPath = which('bun');
  if (onPath) return onPath;

  // Fallback to common install locations on Linux/macOS.
  const home = homedir();
  for (const candidate of [join(home, '.bun', 'bin', 'bun'), '/usr/local/bin/bun']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function main() {
  // Skip on environments where the entry point isn't in this package
  // (e.g. installation from a corrupt tarball — fail open, don't break npm).
  if (!ENTRY || !existsSync(ENTRY)) {
    console.error('[genie] hook-binary: skipping — dispatch-client entry not found');
    return;
  }

  const bun = findBun();
  if (!bun) {
    console.error('[genie] hook-binary: skipping — bun not found on PATH');
    console.error('[genie]   genie hook dispatch will use the bun-fork fallback (slower hot path)');
    return;
  }

  // Ensure ~/.genie/bin/ exists. Tolerate read-only HOME (CI containers).
  try {
    mkdirSync(BIN_DIR, { recursive: true });
  } catch (err) {
    console.error(`[genie] hook-binary: cannot create ${BIN_DIR}: ${err.message}`);
    return;
  }

  // Local-compile path is exempt from binarySha256 pinning (we don't download
  // the binary — we build it ourselves from sources we already trust). Log the
  // exact source artifact so operators can verify by other means
  // (sha256sum on the entry, or `genie doctor --verbose` post-install).
  console.error(`[genie] hook-binary: compiling from ${ENTRY} via ${bun}`);

  // bun build --compile produces a platform-specific static binary that
  // includes a copy of the bun runtime + the bundled JS. Targets the user's
  // current platform; no cross-compile arguments needed.
  const r = spawnSync(bun, ['build', '--compile', ENTRY, '--outfile', BIN_PATH], {
    cwd: PKG_ROOT,
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  if (r.status !== 0) {
    console.error(`[genie] hook-binary: bun build --compile failed (exit ${r.status})`);
    if (r.stderr && r.stderr.trim().length > 0) {
      // Truncate to avoid spamming postinstall output.
      const head = r.stderr.split('\n').slice(0, 5).join('\n');
      console.error(head);
    }
    console.error('[genie]   genie hook dispatch will use the bun-fork fallback (slower hot path)');
    return;
  }

  if (!existsSync(BIN_PATH)) {
    console.error(`[genie] hook-binary: build reported success but ${BIN_PATH} is missing`);
    return;
  }

  // Best-effort: print a one-line confirmation. Stays quiet on success when
  // postinstall runs noninteractively (silent install), per the postinstall
  // convention used by scripts/postinstall-tmux.js.
  if (process.stdout.isTTY) {
    console.error(`[genie] genie-hook binary installed at ${BIN_PATH}`);
  }
}

main().catch((err) => {
  // Never let postinstall failures break npm install; the hook injector
  // falls back to bun-fork at runtime so CC keeps working either way.
  console.error(`[genie] hook-binary: unexpected failure: ${err?.message ? err.message : err}`);
});
