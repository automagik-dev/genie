export interface ExecutorDescriptor {
  label: string;
}

const CANONICAL_EXECUTOR_LABELS: Record<string, string> = {
  GEMINI: 'Google Gemini',
  CODEX: 'ChatGPT',
  CLAUDE_CODE: 'Claude',
  CURSOR: 'Cursor',
  COPILOT: 'GitHub Copilot',
  OPENCODE: 'OpenCode',
  QWEN_CODE: 'Qwen Code',
  AMP: 'Amp'
};

const FRIENDLY_NAME_MAP: Record<string, string> = {
  claude: 'CLAUDE_CODE',
  chatgpt: 'CODEX'
};

// Build EXECUTORS dynamically from labels (canonical keys only)
export const EXECUTORS: Record<string, ExecutorDescriptor> = Object.keys(CANONICAL_EXECUTOR_LABELS).reduce(
  (acc, key) => {
    acc[key] = { label: CANONICAL_EXECUTOR_LABELS[key] };
    return acc;
  },
  {} as Record<string, ExecutorDescriptor>
);

export const DEFAULT_EXECUTOR_KEY = 'OPENCODE';

export const USER_EXECUTOR_ORDER: string[] = ['GEMINI', 'CODEX', 'CLAUDE_CODE', 'CURSOR', 'COPILOT'];

/**
 * Normalize user-provided executor keys (CLI flags, env vars, config) to Forge canonical names.
 * Returns undefined when the input is empty/undefined.
 */
export function normalizeExecutorKey(key?: string | null): string | undefined {
  if (key == null) return undefined;
  const trimmed = key.trim();
  if (!trimmed.length) return undefined;

  const upper = trimmed.toUpperCase();
  if (upper in CANONICAL_EXECUTOR_LABELS) {
    return upper;
  }

  const sanitized = trimmed.toLowerCase().replace(/\s+/g, '').replace(/-/g, '_');
  const sanitizedUpper = sanitized.toUpperCase();
  if (sanitizedUpper in CANONICAL_EXECUTOR_LABELS) {
    return sanitizedUpper;
  }

  if (sanitized in FRIENDLY_NAME_MAP) {
    return FRIENDLY_NAME_MAP[sanitized];
  }

  const lower = trimmed.toLowerCase();
  if (lower in FRIENDLY_NAME_MAP) {
    return FRIENDLY_NAME_MAP[lower];
  }

  return upper;
}

export function normalizeExecutorKeyOrDefault(key?: string | null, fallback: string = DEFAULT_EXECUTOR_KEY): string {
  return normalizeExecutorKey(key) ?? fallback;
}

export function getExecutorLabel(executorKey: string): string {
  return CANONICAL_EXECUTOR_LABELS[executorKey] ?? executorKey;
}
