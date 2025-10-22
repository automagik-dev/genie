import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { pathExists, ensureDir, writeJsonFile } from './fs-utils';

/**
 * Configure Genie MCP server for both Codex and Claude Code executors
 */

interface McpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Configure Codex MCP server (global ~/.codex/config.toml)
 */
export async function configureCodexMcp(): Promise<void> {
  const codexConfigDir = path.join(os.homedir(), '.codex');
  const codexConfigPath = path.join(codexConfigDir, 'config.toml');

  if (!(await pathExists(codexConfigPath))) {
    console.log('⚠️  Codex config not found at ~/.codex/config.toml');
    console.log('   Skipping Codex MCP configuration');
    return;
  }

  const content = await fsp.readFile(codexConfigPath, 'utf8');

  // Check if genie MCP server already configured correctly
  const hasGenieSection = /\[mcp_servers\.genie\]/i.test(content);
  const hasCorrectCommand = /command\s*=\s*"npx"[\s\S]*?args\s*=\s*\[[\s\S]*?"automagik-genie@next"/i.test(content);

  if (hasGenieSection && hasCorrectCommand) {
    console.log('✅ Codex MCP already configured correctly');
    return;
  }

  let newContent = content;

  if (hasGenieSection) {
    // Replace existing genie section
    newContent = content.replace(
      /\[mcp_servers\.genie\][\s\S]*?(?=\n\[|\n\n\[|$)/,
      `[mcp_servers.genie]
command = "npx"
args = ["automagik-genie@next", "mcp"]
`
    );
    console.log('✅ Updated existing Genie MCP configuration in Codex');
  } else {
    // Add new genie section
    const mcpServersMatch = content.match(/(\[mcp_servers\.[^\]]+\][\s\S]*?)(?=\n\[(?!mcp_servers)|$)/);
    if (mcpServersMatch) {
      const insertIndex = mcpServersMatch.index! + mcpServersMatch[0].length;
      newContent = content.slice(0, insertIndex) +
        `\n\n[mcp_servers.genie]
command = "npx"
args = ["automagik-genie@next", "mcp"]
` +
        content.slice(insertIndex);
    } else {
      // No mcp_servers section exists, add at end
      newContent = content + `\n\n[mcp_servers.genie]
command = "npx"
args = ["automagik-genie@next", "mcp"]
`;
    }
    console.log('✅ Added Genie MCP configuration to Codex');
  }

  await fsp.writeFile(codexConfigPath, newContent, 'utf8');
}

/**
 * Configure Claude Code MCP server (project-local .mcp.json or global)
 */
export async function configureClaudeMcp(projectDir?: string): Promise<void> {
  // Claude Code supports both project-local and global configs
  // We'll configure project-local if projectDir provided
  const mcpPath = projectDir
    ? path.join(projectDir, '.mcp.json')
    : path.join(os.homedir(), '.claude', 'claude_desktop_config.json');

  let mcpConfig: any = { mcpServers: {} };

  if (await pathExists(mcpPath)) {
    const content = await fsp.readFile(mcpPath, 'utf8');
    mcpConfig = JSON.parse(content);
  }

  // Ensure mcpServers exists
  mcpConfig.mcpServers = mcpConfig.mcpServers || {};

  // Check if genie already configured correctly
  const existingGenie = mcpConfig.mcpServers.genie;
  if (existingGenie?.command === 'npx' &&
      existingGenie?.args?.[0] === 'automagik-genie@next' &&
      existingGenie?.args?.[1] === 'mcp') {
    console.log(`✅ Claude Code MCP already configured correctly${projectDir ? ' (project-local)' : ' (global)'}`);
    return;
  }

  // Add/update genie MCP server
  mcpConfig.mcpServers.genie = {
    command: 'npx',
    args: ['automagik-genie@next', 'mcp']
  };

  // Also configure Forge MCP server
  const existingForge = mcpConfig.mcpServers.forge || mcpConfig.mcpServers['automagik-forge'];
  // Prefer canonical key 'forge'
  (mcpConfig.mcpServers as any).forge = {
    command: 'npx',
    args: ['automagik-forge', '--mcp']
  } as any;

  // Ensure parent directory exists
  if (projectDir) {
    await ensureDir(projectDir);
  } else {
    await ensureDir(path.join(os.homedir(), '.claude'));
  }

  await writeJsonFile(mcpPath, mcpConfig);
  console.log(`✅ ${existingGenie ? 'Updated' : 'Added'} Genie MCP configuration for Claude Code${projectDir ? ' (project-local)' : ' (global)'}`);
  console.log(`✅ ${existingForge ? 'Updated' : 'Added'} Forge MCP configuration${projectDir ? ' (project-local)' : ' (global)'}`);
}

/**
 * Configure MCP for both executors
 */
export async function configureBothExecutors(projectDir?: string): Promise<void> {
  console.log('');
  console.log('🔧 Configuring MCP servers for executors...');
  console.log('');

  try {
    await configureCodexMcp();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`⚠️  Failed to configure Codex MCP: ${message}`);
  }

  try {
    await configureClaudeMcp(projectDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`⚠️  Failed to configure Claude Code MCP: ${message}`);
  }

  console.log('');
}
