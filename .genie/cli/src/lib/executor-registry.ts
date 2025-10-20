export interface ExecutorDescriptor {
  label: string;
}

export const EXECUTORS: Record<string, ExecutorDescriptor> = {
  opencode: { label: 'OpenCode (Forge)' },
  codex: { label: 'Codex (Forge)' },
  claude: { label: 'Claude Code (Forge)' }
};

export const DEFAULT_EXECUTOR_KEY = 'opencode';
