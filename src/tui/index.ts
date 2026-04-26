/**
 * genie tui — renderer entry point (plain .ts, no JSX).
 *
 * This module ONLY renders the TUI nav panel. It is called when
 * GENIE_TUI_PANE=left, meaning we're inside the tmux pane that
 * `genie serve` already created.
 *
 * Session creation and tmux server management live in serve.ts.
 * Attach logic (check serve → auto-start → attach) lives in genie.ts.
 * The TUI never creates tmux servers or sessions.
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TUI_CRASH_LOG_BANNER_PREFIX = '--- tui-launch ';
const TUI_CRASH_LOG_RECOVERY_MAX_BYTES = 65_536;
const TUI_CRASH_LOG_RECOVERY_MAX_MSG_CHARS = 3_000;

function genieHome(): string {
  return process.env.GENIE_HOME ?? join(homedir(), '.genie');
}

/**
 * Extract the body that was written between the last `--- tui-launch ---`
 * banner and EOF. If the previous run exited cleanly, the body is empty
 * (the wrapper exec'd genie which exited 0). If the previous run crashed,
 * the body contains whatever native panic / stderr survived the alt-screen
 * reset — that's what we ingest into the structured event bus.
 *
 * Bounded read: pulls only the last 64 KiB tail off disk via fd-level
 * `readSync` — never loads the full file into memory, so an append-only
 * stderr stream that has grown to MBs over many launches still costs O(64K)
 * per startup.
 */
function extractPreviousRunCrashOutput(logPath: string): string {
  let fd: number | null = null;
  try {
    const stats = statSync(logPath);
    const size = stats.size;
    if (size === 0) return '';
    const readSize = Math.min(size, TUI_CRASH_LOG_RECOVERY_MAX_BYTES);
    fd = openSync(logPath, 'r');
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, size - readSize);
    const text = buffer.toString('utf-8');
    const lastBannerIndex = text.lastIndexOf(TUI_CRASH_LOG_BANNER_PREFIX);
    if (lastBannerIndex < 0) return '';
    // Skip past the banner line itself.
    const afterBannerNewline = text.indexOf('\n', lastBannerIndex);
    if (afterBannerNewline < 0) return '';
    return text.slice(afterBannerNewline + 1).trim();
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * If the previous TUI run wrote anything to stderr after its launch banner,
 * fold that content into a structured `error.raised` event so it shows up
 * in `genie events errors`. This bridges fd-level panic capture (necessary
 * for native @opentui/core SIGTRAPs that JS can't intercept) with the rest
 * of the genie observability pipeline.
 *
 * Best-effort: emit failures are swallowed so a bridge/PG outage cannot
 * break TUI launch. Importing emit lazily keeps cold-start light when the
 * crash log is empty (the common case).
 */
async function ingestPreviousRunCrash(logPath: string): Promise<void> {
  const body = extractPreviousRunCrashOutput(logPath);
  if (!body) return;
  const truncated =
    body.length > TUI_CRASH_LOG_RECOVERY_MAX_MSG_CHARS
      ? `${body.slice(0, TUI_CRASH_LOG_RECOVERY_MAX_MSG_CHARS)}\n…[truncated]`
      : body;
  try {
    const { emitEvent } = await import('../lib/emit.js');
    emitEvent('error.raised', {
      error_class: 'TuiCrash',
      message: truncated,
      subsystem: 'tui',
      severity: 'error',
      retryable: true,
    });
  } catch {
    // best-effort — never break launch
  }
}

/**
 * JS-level breadcrumb to ~/.genie/logs/tui-crash.log. Belt-and-suspenders
 * companion to the shell-level `exec 2>>` redirect in tui-launch.sh — covers
 * the case where launchTui() is invoked via `bun dist/genie.js` directly
 * (e.g. dev/CI) rather than through the wrapper. See #1390.
 *
 * Also ingests anything the previous run wrote after its banner into a
 * structured `error.raised` event so `genie events errors` surfaces FFI
 * panics that JS can't catch. See discussion in #1390 + this PR.
 *
 * Failures here MUST NOT throw — diagnostic plumbing should never break the
 * TUI launch path.
 */
async function recordTuiLaunchBreadcrumb(): Promise<void> {
  try {
    const logsDir = join(genieHome(), 'logs');
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, 'tui-crash.log');
    // Ingest BEFORE writing the new banner so the recovery body is bounded
    // by the previous banner, not the new one.
    await ingestPreviousRunCrash(logPath);
    const ts = new Date().toISOString();
    const line = `${TUI_CRASH_LOG_BANNER_PREFIX}${ts} pid=${process.pid} platform=${process.platform} arch=${process.arch} ---\n`;
    appendFileSync(logPath, line, { mode: 0o644 });
  } catch {
    // intentionally swallowed
  }
}

/**
 * Render the TUI nav panel.
 * Called from genie.ts when GENIE_TUI_PANE=left.
 */
export async function launchTui(): Promise<void> {
  await recordTuiLaunchBreadcrumb();
  const { renderNav } = await import('./render.js');
  await renderNav();
}
