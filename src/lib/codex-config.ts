/**
 * Codex Configuration
 *
 * Manages ~/.codex/config.toml settings required for genie integration:
 * - disable_paste_burst: Allows reliable tmux send-keys injection
 * - OTel exporter: Routes telemetry to the shared relay for state detection
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Fixed port for the shared OTel relay listener. */
export const OTEL_RELAY_PORT = 14318;

const CODEX_CONFIG_DIR = join(homedir(), '.codex');
const CODEX_CONFIG_PATH = join(CODEX_CONFIG_DIR, 'config.toml');

/**
 * Check if codex config.toml already has genie integration configured.
 */
export function isCodexConfigured(): boolean {
  if (!existsSync(CODEX_CONFIG_PATH)) return false;

  try {
    const content = readFileSync(CODEX_CONFIG_PATH, 'utf-8');
    // Strip TOML comments (lines starting with #) before checking
    const uncommented = content
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    return uncommented.includes('disable_paste_burst') && uncommented.includes(`127.0.0.1:${OTEL_RELAY_PORT}`);
  } catch {
    return false;
  }
}

/**
 * Ensure codex config.toml has OTel exporter and disable_paste_burst enabled.
 *
 * Uses the struct format: exporter = { otlp-http = { endpoint, protocol } }
 * pointing to the shared relay on OTEL_RELAY_PORT.
 *
 * Idempotent — safe to call multiple times.
 *
 * @returns 'changed' if changes were made, 'unchanged' if already configured, 'error' on failure
 */
function ensureOtelExporter(content: string): { content: string; changed: boolean } {
  const otelLine = `exporter = { otlp-http = { endpoint = "http://127.0.0.1:${OTEL_RELAY_PORT}/v1/traces", protocol = "binary" } }`;

  if (content.includes(`127.0.0.1:${OTEL_RELAY_PORT}`)) {
    return { content, changed: false };
  }

  if (!content.includes('[otel]')) {
    return { content: `${content}\n[otel]\n${otelLine}\n`, changed: true };
  }

  if (/exporter\s*=/.test(content)) {
    return { content: content.replace(/(\[otel\][^\[]*?)exporter\s*=\s*.+/, `$1${otelLine}`), changed: true };
  }

  return { content: content.replace('[otel]', `[otel]\n${otelLine}`), changed: true };
}

function ensurePasteBurst(content: string): { content: string; changed: boolean } {
  if (content.includes('disable_paste_burst')) {
    return { content, changed: false };
  }

  const firstSection = content.indexOf('[');
  if (firstSection > 0) {
    return {
      content: `${content.slice(0, firstSection)}disable_paste_burst = true\n${content.slice(firstSection)}`,
      changed: true,
    };
  }
  if (firstSection === 0) {
    return { content: `disable_paste_burst = true\n${content}`, changed: true };
  }
  return { content: `${content}\ndisable_paste_burst = true\n`, changed: true };
}

export function ensureCodexOtelConfig(): 'changed' | 'unchanged' | 'error' {
  try {
    mkdirSync(CODEX_CONFIG_DIR, { recursive: true });

    let content = existsSync(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, 'utf-8') : '';
    let changed = false;

    const otel = ensureOtelExporter(content);
    content = otel.content;
    changed = changed || otel.changed;

    const paste = ensurePasteBurst(content);
    content = paste.content;
    changed = changed || paste.changed;

    if (changed) {
      writeFileSync(CODEX_CONFIG_PATH, content);
    }

    return changed ? 'changed' : 'unchanged';
  } catch {
    return 'error';
  }
}

/**
 * Get the path to the codex config file (for display).
 */
export function getCodexConfigPath(): string {
  return CODEX_CONFIG_PATH;
}
