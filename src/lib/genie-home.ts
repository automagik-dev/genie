/**
 * Genie home + agent directory resolution.
 *
 * Every path the lifecycle commands read or write is derived from one of these
 * roots. Each honors its conventional environment override so tests can
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

/** Pi agent config root — `$PI_HOME` (legacy genie alias) or `~/.pi`. */
export function resolvePiHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const override = env.PI_HOME;
  return typeof override === 'string' && override.trim().length > 0 ? override : join(home, '.pi');
}

/**
 * Pi extension discovery dir — `<agentDir>/extensions`.
 *
 * The agent dir honors `$PI_CODING_AGENT_DIR` (pi's real relocation override,
 * tilde-expanded exactly as pi expands it) before falling back to
 * `<piHome>/agent`; `piHome` defaults to {@link resolvePiHome}. The legacy
 * `$PI_HOME` alias stays accepted for genie tooling but never overrides pi's
 * own variable, so a relocated pi is always converged where pi actually reads.
 */
export function resolvePiExtensionsDir(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  const override = env.PI_CODING_AGENT_DIR;
  const agentDir =
    typeof override === 'string' && override.trim().length > 0 ? override : join(home ?? resolvePiHome(env), 'agent');
  return join(expandTilde(agentDir), 'extensions');
}

function expandTilde(path: string, home = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}
