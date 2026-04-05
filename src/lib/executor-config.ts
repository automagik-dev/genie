/**
 * Executor type resolver.
 *
 * Resolution order:
 *   1. Explicit override argument (CLI --executor flag)
 *   2. GENIE_EXECUTOR env var
 *   3. Persisted config (~/.genie/config.json → omni.executor)
 *   4. Default: 'tmux'
 */

import { loadGenieConfigSync } from './genie-config.js';

export type ExecutorType = 'tmux' | 'sdk';

const VALID: ReadonlySet<string> = new Set(['tmux', 'sdk']);

function isValid(value: unknown): value is ExecutorType {
  return typeof value === 'string' && VALID.has(value);
}

export function resolveExecutorType(override?: string): ExecutorType {
  // 1. Explicit override
  if (isValid(override)) return override;

  // 2. Env var
  const env = process.env.GENIE_EXECUTOR;
  if (isValid(env)) return env;

  // 3. Persisted config
  try {
    const cfg = loadGenieConfigSync();
    const persisted = cfg.omni?.executor;
    if (isValid(persisted)) return persisted;
  } catch {
    // Config unreadable — fall through
  }

  // 4. Default
  return 'tmux';
}
