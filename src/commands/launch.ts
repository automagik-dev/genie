import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, getDefaultProfile, configExists } from '../lib/config.js';

export interface LaunchOptions {
  claudeArgs?: string[];
}

/**
 * Get the AGENTS.md system prompt if it exists in the current directory
 */
function getAgentsSystemPrompt(): string | null {
  const agentsPath = join(process.cwd(), 'AGENTS.md');
  if (existsSync(agentsPath)) {
    return readFileSync(agentsPath, 'utf-8');
  }
  return null;
}

/**
 * Get Claude CLI arguments including system prompt if AGENTS.md exists
 */
function getClaudeArgs(passthroughArgs: string[] = []): string[] {
  const args: string[] = [];
  const prompt = getAgentsSystemPrompt();
  if (prompt) {
    args.push('--system-prompt', prompt);
  }
  args.push(...passthroughArgs);
  return args;
}

export async function launchProfile(profileName: string, options: LaunchOptions = {}): Promise<void> {
  const config = await loadConfig();
  const profile = config.profiles[profileName];

  if (!profile) {
    console.error(`Profile "${profileName}" not found`);
    console.log(`\nAvailable profiles: ${Object.keys(config.profiles).join(', ')}`);
    process.exit(1);
  }

  console.log(`Launching "${profileName}"...`);

  // Set environment variables
  process.env.LC_ALL = 'C.UTF-8';
  process.env.LANG = 'C.UTF-8';
  process.env.ANTHROPIC_BASE_URL = config.apiUrl;
  process.env.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = profile.opus;
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = profile.sonnet;
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = profile.haiku;

  // Spawn claude with inherited stdio
  const child = spawn('claude', getClaudeArgs(options.claudeArgs || []), {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    console.error(`Failed to launch: ${error.message}`);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

export async function launchDefaultProfile(options: LaunchOptions = {}): Promise<void> {
  if (!configExists()) {
    console.error('No config found. Run `claudio setup` first.');
    process.exit(1);
  }

  const defaultProfile = await getDefaultProfile();

  if (!defaultProfile) {
    console.error('No default profile set.');
    console.log('\nRun `claudio setup` to configure, or use `claudio <profile>` to launch a specific profile.');
    process.exit(1);
  }

  await launchProfile(defaultProfile, options);
}
