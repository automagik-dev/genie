"use strict";
/**
 * Comprehensive executor definitions with installation, verification, and authentication
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXECUTOR_DEFINITIONS = void 0;
exports.getExecutorDefinition = getExecutorDefinition;
exports.getAllExecutorKeys = getAllExecutorKeys;
exports.getExecutorsRequiringAuth = getExecutorsRequiringAuth;
/**
 * All available executors with installation instructions
 */
exports.EXECUTOR_DEFINITIONS = {
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
function getExecutorDefinition(key) {
    const normalized = key.toLowerCase();
    return exports.EXECUTOR_DEFINITIONS[normalized];
}
/**
 * Get all executor keys
 */
function getAllExecutorKeys() {
    return Object.keys(exports.EXECUTOR_DEFINITIONS);
}
/**
 * Get executors that require authentication
 */
function getExecutorsRequiringAuth() {
    return Object.values(exports.EXECUTOR_DEFINITIONS).filter(e => e.requiresAuth);
}
