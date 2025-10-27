"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureCodexMcp = configureCodexMcp;
exports.configureClaudeMcp = configureClaudeMcp;
exports.configureBothExecutors = configureBothExecutors;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const fs_utils_1 = require("./fs-utils");
/**
 * Configure Codex MCP server (global ~/.codex/config.toml)
 */
async function configureCodexMcp() {
    const codexConfigDir = path_1.default.join(os_1.default.homedir(), '.codex');
    const codexConfigPath = path_1.default.join(codexConfigDir, 'config.toml');
    if (!(await (0, fs_utils_1.pathExists)(codexConfigPath))) {
        console.log('⚠️  Codex config not found at ~/.codex/config.toml');
        console.log('   Skipping Codex MCP configuration');
        return;
    }
    const content = await fs_1.promises.readFile(codexConfigPath, 'utf8');
    // Check if genie MCP server already configured correctly
    const hasGenieSection = /\[mcp_servers\.genie\]/i.test(content);
    const hasCorrectCommand = /command\s*=\s*"npx"[\s\S]*?args\s*=\s*\[[\s\S]*?"automagik-genie@latest"/i.test(content);
    if (hasGenieSection && hasCorrectCommand) {
        console.log('✅ Codex MCP already configured correctly');
        return;
    }
    let newContent = content;
    if (hasGenieSection) {
        // Replace existing genie section
        newContent = content.replace(/\[mcp_servers\.genie\][\s\S]*?(?=\n\[|\n\n\[|$)/, `[mcp_servers.genie]
command = "npx"
args = ["automagik-genie@latest", "mcp"]
`);
        console.log('✅ Updated existing Genie MCP configuration in Codex');
    }
    else {
        // Add new genie section
        const mcpServersMatch = content.match(/(\[mcp_servers\.[^\]]+\][\s\S]*?)(?=\n\[(?!mcp_servers)|$)/);
        if (mcpServersMatch) {
            const insertIndex = mcpServersMatch.index + mcpServersMatch[0].length;
            newContent = content.slice(0, insertIndex) +
                `\n\n[mcp_servers.genie]
command = "npx"
args = ["automagik-genie@latest", "mcp"]
` +
                content.slice(insertIndex);
        }
        else {
            // No mcp_servers section exists, add at end
            newContent = content + `\n\n[mcp_servers.genie]
command = "npx"
args = ["automagik-genie@latest", "mcp"]
`;
        }
        console.log('✅ Added Genie MCP configuration to Codex');
    }
    await fs_1.promises.writeFile(codexConfigPath, newContent, 'utf8');
}
/**
 * Configure Claude Code MCP server (project-local .mcp.json or global)
 */
async function configureClaudeMcp(projectDir) {
    // Claude Code supports both project-local and global configs
    // We'll configure project-local if projectDir provided
    const mcpPath = projectDir
        ? path_1.default.join(projectDir, '.mcp.json')
        : path_1.default.join(os_1.default.homedir(), '.claude', 'claude_desktop_config.json');
    let mcpConfig = { mcpServers: {} };
    if (await (0, fs_utils_1.pathExists)(mcpPath)) {
        const content = await fs_1.promises.readFile(mcpPath, 'utf8');
        mcpConfig = JSON.parse(content);
    }
    // Ensure mcpServers exists
    mcpConfig.mcpServers = mcpConfig.mcpServers || {};
    // Check if genie already configured correctly
    const existingGenie = mcpConfig.mcpServers.genie;
    if (existingGenie?.command === 'npx' &&
        existingGenie?.args?.[0] === 'automagik-genie@latest' &&
        existingGenie?.args?.[1] === 'mcp') {
        console.log(`✅ Claude Code MCP already configured correctly${projectDir ? ' (project-local)' : ' (global)'}`);
        return;
    }
    // Add/update genie MCP server
    mcpConfig.mcpServers.genie = {
        command: 'npx',
        args: ['automagik-genie@latest', 'mcp']
    };
    // Also configure Forge MCP server
    const existingForge = mcpConfig.mcpServers.forge || mcpConfig.mcpServers['automagik-forge'];
    // Prefer canonical key 'forge'
    mcpConfig.mcpServers.forge = {
        command: 'npx',
        args: ['automagik-forge', '--mcp']
    };
    // Ensure parent directory exists
    if (projectDir) {
        await (0, fs_utils_1.ensureDir)(projectDir);
    }
    else {
        await (0, fs_utils_1.ensureDir)(path_1.default.join(os_1.default.homedir(), '.claude'));
    }
    await (0, fs_utils_1.writeJsonFile)(mcpPath, mcpConfig);
    console.log(`✅ ${existingGenie ? 'Updated' : 'Added'} Genie MCP configuration for Claude Code${projectDir ? ' (project-local)' : ' (global)'}`);
    console.log(`✅ ${existingForge ? 'Updated' : 'Added'} Forge MCP configuration${projectDir ? ' (project-local)' : ' (global)'}`);
}
/**
 * Configure MCP for both executors
 */
async function configureBothExecutors(projectDir) {
    console.log('');
    console.log('🔧 Configuring MCP servers for executors...');
    console.log('');
    try {
        await configureCodexMcp();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`⚠️  Failed to configure Codex MCP: ${message}`);
    }
    try {
        await configureClaudeMcp(projectDir);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`⚠️  Failed to configure Claude Code MCP: ${message}`);
    }
    console.log('');
}
