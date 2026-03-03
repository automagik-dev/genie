/**
 * Codex Configuration
 *
 * Manages ~/.codex/config.toml settings required for genie integration:
 * - disable_paste_burst: Allows reliable tmux send-keys injection
 * - OTel exporter: Routes telemetry to the shared relay for state detection
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n');
    return (
      uncommented.includes('disable_paste_burst') &&
      uncommented.includes(`127.0.0.1:${OTEL_RELAY_PORT}`)
    );
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
export function ensureCodexOtelConfig(): 'changed' | 'unchanged' | 'error' {
  try {
    mkdirSync(CODEX_CONFIG_DIR, { recursive: true });

    let content = existsSync(CODEX_CONFIG_PATH)
      ? readFileSync(CODEX_CONFIG_PATH, 'utf-8')
      : '';

    let changed = false;

    // 1. Ensure OTel exporter is configured
    const otelLine = `exporter = { otlp-http = { endpoint = "http://127.0.0.1:${OTEL_RELAY_PORT}/v1/traces", protocol = "binary" } }`;

    if (!content.includes(`127.0.0.1:${OTEL_RELAY_PORT}`)) {
      if (content.includes('[otel]')) {
        if (/exporter\s*=/.test(content)) {
          // Replace exporter line only within the [otel] section
          content = content.replace(
            /(\[otel\][^\[]*?)exporter\s*=\s*.+/,
            `$1${otelLine}`,
          );
        } else {
          content = content.replace('[otel]', `[otel]\n${otelLine}`);
        }
      } else {
        content += `\n[otel]\n${otelLine}\n`;
      }
      changed = true;
    }

    // 2. Ensure disable_paste_burst = true (allows reliable tmux send-keys injection)
    if (!content.includes('disable_paste_burst')) {
      // Add at the top level (before any section headers)
      const firstSection = content.indexOf('[');
      if (firstSection > 0) {
        content = content.slice(0, firstSection) + 'disable_paste_burst = true\n' + content.slice(firstSection);
      } else if (firstSection === 0) {
        content = 'disable_paste_burst = true\n' + content;
      } else {
        content += '\ndisable_paste_burst = true\n';
      }
      changed = true;
    }

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
