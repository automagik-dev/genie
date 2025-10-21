export interface ExecutorDescriptor {
  label: string;
}

// Full executor mapping - matches Forge profile names
// See init.ts mapExecutorToForgeProfile for canonical mapping
const EXECUTOR_LABELS: Record<string, string> = {
  opencode: 'OpenCode (Forge)',
  codex: 'Codex (Forge)',
  claude: 'Claude Code (Forge)',
  'claude-code': 'Claude Code (Forge)',
  gemini: 'Gemini (Forge)',
  cursor: 'Cursor (Forge)',
  qwen_code: 'Qwen Code (Forge)',
  amp: 'Amp (Forge)',
  copilot: 'GitHub Copilot (Forge)'
};

// Build EXECUTORS dynamically from labels
export const EXECUTORS: Record<string, ExecutorDescriptor> = Object.keys(EXECUTOR_LABELS).reduce(
  (acc, key) => {
    acc[key] = { label: EXECUTOR_LABELS[key] };
    return acc;
  },
  {} as Record<string, ExecutorDescriptor>
);

export const DEFAULT_EXECUTOR_KEY = 'opencode';
