/**
 * Genie home + agent directory resolution.
 *
 * Every path the agent-sync engine reads or writes is derived from one of these
 * four roots. Each honors its conventional environment override so tests can
 * redirect ALL state into a tmpdir and never touch the real `$HOME`, and so
 * operators can relocate any one agent's config without moving the others.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Global genie state root — `$GENIE_HOME` or `~/.genie`. */
export function resolveGenieHome(): string {
  return process.env.GENIE_HOME || join(homedir(), '.genie');
}

/** Claude Code config root — `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
export function resolveClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Codex config root — non-empty `$CODEX_HOME` or `~/.codex`.
 *
 * `env` and `home` are injectable so every caller and test shares one policy.
 * An explicit empty override is invalid and falls back safely; it must never
 * turn `config.toml` or `agents/` into a cwd-relative path.
 */
export function resolveCodexDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.CODEX_HOME;
  return typeof override === 'string' && override.trim().length > 0 ? override : join(home, '.codex');
}

/** Hermes home — `$HERMES_HOME` or `~/.hermes`. */
export function resolveHermesHome(): string {
  return process.env.HERMES_HOME || join(homedir(), '.hermes');
}
