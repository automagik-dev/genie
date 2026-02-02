import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { loadConfig, getDefaultProfile, configExists } from '../lib/config.js';
import { loadGenieConfig, genieConfigExists } from '../lib/genie-config.js';
import { describeEnabledHooks, hasEnabledHooks, parseHookNames } from '../lib/hooks/index.js';

export interface LaunchOptions {
  hooks?: string;
  noHooks?: boolean;
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
function getClaudeArgs(): string[] {
  const prompt = getAgentsSystemPrompt();
  if (prompt) {
    return ['--system-prompt', prompt];
  }
  return [];
}

/**
 * Display hook information before launch
 */
async function displayHookInfo(options: LaunchOptions): Promise<void> {
  // Handle --no-hooks
  if (options.noHooks) {
    console.log('\x1b[33m⚠️  Hooks disabled via --no-hooks\x1b[0m');
    return;
  }

  // Handle --hooks override
  if (options.hooks) {
    const presets = parseHookNames(options.hooks);
    if (presets.length > 0) {
      console.log(`\x1b[36m🪝 Using hooks: ${presets.join(', ')}\x1b[0m`);
    }
    return;
  }

  // Load from genie config
  if (genieConfigExists()) {
    const genieConfig = await loadGenieConfig();
    if (hasEnabledHooks(genieConfig)) {
      const descriptions = describeEnabledHooks(genieConfig);
      console.log('\x1b[36m🪝 Active hooks:\x1b[0m');
      for (const desc of descriptions) {
        console.log(`   ${desc}`);
      }
    }
  }
}

/**
 * Set hooks environment variables directly in process.env
 * This ensures Claude inherits the hooks configuration
 */
async function setHooksEnvVars(): Promise<void> {
  if (!genieConfigExists()) {
    return;
  }

  const genieConfig = await loadGenieConfig();
  if (!hasEnabledHooks(genieConfig)) {
    return;
  }

  process.env.GENIE_HOOKS_ENABLED = genieConfig.hooks.enabled.join(',');
}

export async function launchProfile(profileName: string, options: LaunchOptions = {}): Promise<void> {
  const config = await loadConfig();
  const profile = config.profiles[profileName];

  if (!profile) {
    console.error(`❌ Profile "${profileName}" not found`);
    console.log(`\nAvailable profiles: ${Object.keys(config.profiles).join(', ')}`);
    process.exit(1);
  }

  // Display hook information
  await displayHookInfo(options);

  // Set hooks environment variables
  await setHooksEnvVars();

  console.log(`🚀 Launching "${profileName}"...`);

  // Set environment variables
  process.env.LC_ALL = 'C.UTF-8';
  process.env.LANG = 'C.UTF-8';
  process.env.ANTHROPIC_BASE_URL = config.apiUrl;
  process.env.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = profile.opus;
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = profile.sonnet;
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = profile.haiku;

  // Spawn claude with inherited stdio
  const child = spawn('claude', getClaudeArgs(), {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    console.error(`❌ Failed to launch: ${error.message}`);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });
}

export async function launchDefaultProfile(options: LaunchOptions = {}): Promise<void> {
  if (!configExists()) {
    console.error('❌ No config found. Run `claudio setup` first.');
    process.exit(1);
  }

  const defaultProfile = await getDefaultProfile();

  if (!defaultProfile) {
    console.error('❌ No default profile set.');
    console.log('\nRun `claudio setup` to configure, or use `claudio <profile>` to launch a specific profile.');
    process.exit(1);
  }

  await launchProfile(defaultProfile, options);
}
