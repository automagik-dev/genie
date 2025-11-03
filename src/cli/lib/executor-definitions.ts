/**
 * Comprehensive executor definitions with installation, verification, and authentication
 */

export interface ExecutorDefinition {
  key: string;                  // Internal key (forge uses uppercase)
  friendlyName: string;         // Display name (ChatGPT, Claude, etc.)
  description: string;          // Short description
  command: string;              // CLI command to check/run
  installCommands: {
    macos: string[];
    linux: string[];
    windows?: string[];
  };
  verifyCommand: string;        // Command to verify installation
  loginCommand?: string;        // Authentication command (if applicable)
  requiresAuth: boolean;        // Whether authentication is needed
  website: string;              // Documentation/homepage
}

/**
 * All available executors with installation instructions
 */
export const EXECUTOR_DEFINITIONS: Record<string, ExecutorDefinition> = {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Primary Executors (Most Common)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  claude: {
    key: 'claude',
    friendlyName: 'Claude',
    description: 'Anthropic Claude via Claude Code CLI',
    command: 'claude',
    installCommands: {
      macos: ['brew install --cask claude-code'],
      linux: ['npm install -g @anthropic-ai/claude-code']
    },
    verifyCommand: 'claude --version',
    requiresAuth: false, // Uses API key in config
    website: 'https://docs.anthropic.com/en/docs/claude-code'
  },

  codex: {
    key: 'codex',
    friendlyName: 'ChatGPT',
    description: 'OpenAI ChatGPT via Codex CLI',
    command: 'codex',
    installCommands: {
      macos: ['brew install codex'],
      linux: ['npm install -g @openai/codex']
    },
    verifyCommand: 'codex --version',
    loginCommand: 'codex login',
    requiresAuth: true,
    website: 'https://platform.openai.com/docs/api-reference'
  },

  copilot: {
    key: 'copilot',
    friendlyName: 'GitHub Copilot',
    description: 'GitHub Copilot CLI',
    command: 'copilot',
    installCommands: {
      macos: ['npm install -g @github/copilot'],
      linux: ['npm install -g @github/copilot']
    },
    verifyCommand: 'copilot --version',
    requiresAuth: false, // Uses gh auth
    website: 'https://docs.github.com/en/copilot/github-copilot-in-the-cli'
  },

  cursor: {
    key: 'cursor',
    friendlyName: 'Cursor',
    description: 'Cursor AI editor CLI',
    command: 'cursor',
    installCommands: {
      macos: [
        'curl https://cursor.com/install -fsSL -o /tmp/cursor-install.sh',
        'bash /tmp/cursor-install.sh',
        'rm /tmp/cursor-install.sh'
      ],
      linux: [
        'curl https://cursor.com/install -fsSL -o /tmp/cursor-install.sh',
        'bash /tmp/cursor-install.sh',
        'rm /tmp/cursor-install.sh'
      ]
    },
    verifyCommand: 'cursor --version',
    requiresAuth: false,
    website: 'https://cursor.com'
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Additional Executors
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  opencode: {
    key: 'opencode',
    friendlyName: 'OpenCode',
    description: 'Open-source code assistant',
    command: 'opencode',
    installCommands: {
      macos: ['brew install opencode'],
      linux: ['npm install -g opencode-ai']
    },
    verifyCommand: 'opencode --version',
    requiresAuth: false,
    website: 'https://github.com/automagik/opencode'
  },

  gemini: {
    key: 'gemini',
    friendlyName: 'Google Gemini',
    description: 'Google Gemini AI',
    command: 'gemini',
    installCommands: {
      macos: ['brew install gemini-cli'],
      linux: ['npm install -g @google/gemini-cli']
    },
    verifyCommand: 'gemini --version',
    requiresAuth: false, // Uses API key
    website: 'https://ai.google.dev/gemini-api/docs'
  },

  qwen_code: {
    key: 'qwen_code',
    friendlyName: 'Qwen Code',
    description: 'Alibaba Qwen coding model',
    command: 'qwen',
    installCommands: {
      macos: ['brew install qwen-code'],
      linux: ['npm install -g @qwen-code/qwen-code@latest']
    },
    verifyCommand: 'qwen --version',
    requiresAuth: false,
    website: 'https://qwen.ai'
  }
};

/**
 * Get executor definition by key
 */
export function getExecutorDefinition(key: string): ExecutorDefinition | undefined {
  const normalized = key.toLowerCase();
  return EXECUTOR_DEFINITIONS[normalized];
}

/**
 * Get all executor keys
 */
export function getAllExecutorKeys(): string[] {
  return Object.keys(EXECUTOR_DEFINITIONS);
}

/**
 * Get executors that require authentication
 */
export function getExecutorsRequiringAuth(): ExecutorDefinition[] {
  return Object.values(EXECUTOR_DEFINITIONS).filter(e => e.requiresAuth);
}
