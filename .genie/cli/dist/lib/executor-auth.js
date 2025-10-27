"use strict";
/**
 * Executor authentication helpers
 * Auto-configures executors during init and checks auth during run
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkExecutorAuth = checkExecutorAuth;
exports.promptExecutorLogin = promptExecutorLogin;
exports.configureExecutor = configureExecutor;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const readline_1 = __importDefault(require("readline"));
/**
 * Check if an executor is authenticated
 */
async function checkExecutorAuth(executorId) {
    switch (executorId) {
        case 'OPENCODE':
            return checkOpenCodeAuth();
        case 'CLAUDE_CODE':
            return checkClaudeAuth();
        case 'CODEX':
            return checkCodexAuth();
        case 'GEMINI':
            return checkGeminiAuth();
        case 'CURSOR':
            return checkCursorAuth();
        case 'COPILOT':
            return checkCopilotAuth();
        case 'QWEN_CODE':
            return checkQwenAuth();
        default:
            // Unknown executor, assume it doesn't need auth
            return true;
    }
}
/**
 * Prompt user to configure executor authentication
 */
async function promptExecutorLogin(executorId) {
    console.log(`\n⚠️  ${getExecutorName(executorId)} is not configured`);
    console.log('Would you like to configure it now? (Y/n)');
    const answer = await promptYesNo();
    if (!answer) {
        console.log('Skipping authentication. You can configure later.');
        return;
    }
    await configureExecutor(executorId);
}
/**
 * Configure executor authentication (interactive)
 */
async function configureExecutor(executorId) {
    switch (executorId) {
        case 'OPENCODE':
            await configureOpenCode();
            break;
        case 'CLAUDE_CODE':
            await configureClaude();
            break;
        case 'CODEX':
            await configureCodex();
            break;
        case 'GEMINI':
            await configureGemini();
            break;
        case 'CURSOR':
            await configureCursor();
            break;
        case 'COPILOT':
            await configureCopilot();
            break;
        case 'QWEN_CODE':
            await configureQwen();
            break;
    }
}
// OpenCode
async function checkOpenCodeAuth() {
    try {
        // OpenCode stores credentials in ~/.local/share/opencode/auth.json
        const authPath = path_1.default.join(os_1.default.homedir(), '.local', 'share', 'opencode', 'auth.json');
        const authData = await fs_1.promises.readFile(authPath, 'utf-8');
        const parsed = JSON.parse(authData);
        // Check if there are any credential entries (object with keys)
        return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0;
    }
    catch {
        return false;
    }
}
async function configureOpenCode() {
    return new Promise((resolve, reject) => {
        console.log(`\nLaunching OpenCode authentication...`);
        const child = (0, child_process_1.spawn)('npx', ['@opencode/cli', 'auth', 'login'], {
            stdio: 'inherit',
            shell: false,
        });
        child.on('exit', (code) => {
            if (code === 0) {
                console.log('✓ OpenCode configured');
                resolve();
            }
            else {
                reject(new Error(`OpenCode auth failed with code ${code}`));
            }
        });
        child.on('error', (error) => {
            reject(new Error(`Failed to launch OpenCode: ${error.message}`));
        });
    });
}
// Claude Code
async function checkClaudeAuth() {
    return new Promise((resolve) => {
        const child = (0, child_process_1.spawn)('claude', ['--version'], {
            stdio: 'pipe',
            shell: false,
        });
        child.on('exit', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
    });
}
async function configureClaude() {
    return new Promise((resolve, reject) => {
        console.log(`\nLaunching Claude Code token setup...`);
        console.log('This requires a Claude subscription.\n');
        const child = (0, child_process_1.spawn)('npx', ['@anthropic-ai/claude-code@latest', 'setup-token'], {
            stdio: 'inherit',
            shell: false,
        });
        child.on('exit', (code) => {
            if (code === 0) {
                console.log('\n✓ Claude Code configured');
                resolve();
            }
            else {
                reject(new Error(`Claude setup-token failed with code ${code}`));
            }
        });
        child.on('error', (error) => {
            reject(new Error(`Failed to launch Claude: ${error.message}`));
        });
    });
}
// Codex
async function checkCodexAuth() {
    try {
        const authPath = path_1.default.join(os_1.default.homedir(), '.codex', 'auth.json');
        const authData = await fs_1.promises.readFile(authPath, 'utf-8');
        const parsed = JSON.parse(authData);
        return !!(parsed.OPENAI_API_KEY ||
            (parsed.tokens?.access_token && parsed.tokens?.refresh_token));
    }
    catch {
        return false;
    }
}
async function configureCodex() {
    return new Promise((resolve, reject) => {
        console.log(`\nLaunching Codex authentication...\n`);
        const child = (0, child_process_1.spawn)('npx', ['@openai/codex@latest', 'login'], {
            stdio: 'inherit',
            shell: false,
        });
        child.on('exit', (code) => {
            if (code === 0) {
                console.log('\n✓ Codex configured');
                resolve();
            }
            else {
                reject(new Error(`Codex login failed with code ${code}`));
            }
        });
        child.on('error', (error) => {
            reject(new Error(`Failed to launch Codex: ${error.message}`));
        });
    });
}
// Gemini
async function checkGeminiAuth() {
    try {
        // Gemini stores config in ~/.gemini/ directory
        const geminiDir = path_1.default.join(os_1.default.homedir(), '.gemini');
        // Check for OAuth authentication (oauth_creds.json with refresh_token)
        const oauthPath = path_1.default.join(geminiDir, 'oauth_creds.json');
        try {
            const oauthData = await fs_1.promises.readFile(oauthPath, 'utf-8');
            const oauth = JSON.parse(oauthData);
            if (oauth.refresh_token)
                return true;
        }
        catch {
            // OAuth not configured, check other methods
        }
        // Check for API key in settings.json
        const settingsPath = path_1.default.join(geminiDir, 'settings.json');
        try {
            const settingsData = await fs_1.promises.readFile(settingsPath, 'utf-8');
            const settings = JSON.parse(settingsData);
            if (settings.apiKey)
                return true;
            // Check if OAuth is selected in settings
            if (settings.security?.auth?.selectedType === 'oauth-personal')
                return true;
        }
        catch {
            // Settings not found
        }
        return false;
    }
    catch {
        return false;
    }
}
async function configureGemini() {
    console.log('\n📋 Gemini Authentication Setup');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\nGemini CLI requires interactive authentication.');
    console.log('Please run the following command:\n');
    console.log('  npx @google/gemini-cli@latest\n');
    console.log('Then type: /auth');
    console.log('\nYou can choose between:');
    console.log('  • Google OAuth (recommended)');
    console.log('  • Gemini API Key');
    console.log('  • Vertex AI\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    const answer = await promptYesNo();
    if (answer) {
        console.log('Proceeding with setup (run gemini authentication separately)...\n');
    }
    else {
        throw new Error('Gemini authentication skipped');
    }
}
// Cursor
async function checkCursorAuth() {
    return new Promise((resolve) => {
        const child = (0, child_process_1.spawn)('cursor-agent', ['status'], {
            stdio: 'pipe',
            shell: false,
        });
        child.on('exit', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
    });
}
async function configureCursor() {
    return new Promise((resolve, reject) => {
        console.log(`\nLaunching Cursor Agent authentication...\n`);
        const child = (0, child_process_1.spawn)('cursor-agent', ['login'], {
            stdio: 'inherit',
            shell: false,
        });
        child.on('exit', (code) => {
            if (code === 0) {
                console.log('\n✓ Cursor configured');
                resolve();
            }
            else {
                reject(new Error(`Cursor login failed with code ${code}`));
            }
        });
        child.on('error', (error) => {
            reject(new Error(`Failed to launch Cursor Agent: ${error.message}`));
        });
    });
}
// GitHub Copilot
async function checkCopilotAuth() {
    // Copilot uses GitHub CLI auth
    return new Promise((resolve) => {
        const child = (0, child_process_1.spawn)('gh', ['auth', 'status'], {
            stdio: 'pipe',
            shell: false,
        });
        child.on('exit', (code) => resolve(code === 0));
        child.on('error', () => resolve(false));
    });
}
async function configureCopilot() {
    return new Promise((resolve, reject) => {
        console.log(`\nLaunching GitHub authentication for Copilot...\n`);
        const child = (0, child_process_1.spawn)('npx', ['gh', 'auth', 'login'], {
            stdio: 'inherit',
            shell: false,
        });
        child.on('exit', (code) => {
            if (code === 0) {
                console.log('\n✓ GitHub Copilot configured (authenticated via GitHub CLI)');
                resolve();
            }
            else {
                reject(new Error(`GitHub auth failed with code ${code}`));
            }
        });
        child.on('error', (error) => {
            reject(new Error(`Failed to launch GitHub CLI: ${error.message}`));
        });
    });
}
// Qwen Code
async function checkQwenAuth() {
    try {
        // Qwen stores config in ~/.qwen/ directory
        const settingsPath = path_1.default.join(os_1.default.homedir(), '.qwen', 'settings.json');
        const settingsData = await fs_1.promises.readFile(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsData);
        // Check for API key in settings
        return !!settings.apiKey;
    }
    catch {
        return false;
    }
}
async function configureQwen() {
    console.log('\n📋 Qwen Code Authentication Setup');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\nQwen Code requires interactive authentication.');
    console.log('Please run the following command:\n');
    console.log('  npx @qwen-code/qwen-code@latest\n');
    console.log('Then configure your API credentials through the CLI.\n');
    console.log('You can use --openai-api-key flag or configure via settings.\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    const answer = await promptYesNo();
    if (answer) {
        console.log('Proceeding with setup (run qwen authentication separately)...\n');
    }
    else {
        throw new Error('Qwen authentication skipped');
    }
}
// Helper functions
function getExecutorName(executorId) {
    const names = {
        OPENCODE: 'OpenCode',
        CLAUDE_CODE: 'Claude Code',
        CODEX: 'Codex',
        GEMINI: 'Gemini CLI',
        CURSOR: 'Cursor',
        COPILOT: 'GitHub Copilot',
        QWEN_CODE: 'Qwen Code',
    };
    return names[executorId] || executorId;
}
function promptYesNo() {
    return new Promise((resolve) => {
        const rl = readline_1.default.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question('', (answer) => {
            rl.close();
            const normalized = answer.trim().toLowerCase();
            resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
        });
    });
}
function promptText(question) {
    return new Promise((resolve) => {
        const rl = readline_1.default.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
