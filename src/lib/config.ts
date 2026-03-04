import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Config, ConfigSchema, type Profile } from '../types/config.js';

const CONFIG_DIR = join(homedir(), '.claudio');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function getConfigPath(): string {
  return CONFIG_FILE;
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

export async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error('Config file not found. Run "claudio setup" first.');
  }

  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const data = JSON.parse(content);
    return ConfigSchema.parse(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config: ${message}`);
  }
}

export async function saveConfig(config: Config): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }

  try {
    const validated = ConfigSchema.parse(config);
    const content = JSON.stringify(validated, null, 2);
    writeFileSync(CONFIG_FILE, content, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to save config: ${message}`);
  }
}

async function deleteConfig(): Promise<void> {
  if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE);
  }
}

export function getDefaultApiUrl(): string {
  return 'http://10.114.1.119:8317';
}

function getAnthropicApiUrl(): string {
  return 'https://api.anthropic.com/v1';
}

// Profile CRUD helpers

export async function getDefaultProfile(): Promise<string | undefined> {
  const config = await loadConfig();
  return config.defaultProfile;
}

export async function setDefaultProfile(name: string): Promise<void> {
  const config = await loadConfig();
  if (!config.profiles[name]) {
    throw new Error(`Profile "${name}" not found`);
  }
  config.defaultProfile = name;
  await saveConfig(config);
}

async function addProfile(name: string, profile: Profile): Promise<void> {
  const config = await loadConfig();
  if (config.profiles[name]) {
    throw new Error(`Profile "${name}" already exists`);
  }
  config.profiles[name] = profile;
  await saveConfig(config);
}

export async function removeProfile(name: string): Promise<void> {
  const config = await loadConfig();
  if (!config.profiles[name]) {
    throw new Error(`Profile "${name}" not found`);
  }
  delete config.profiles[name];
  // Clear default if we just deleted it
  if (config.defaultProfile === name) {
    config.defaultProfile = undefined;
  }
  await saveConfig(config);
}

export async function listProfiles(): Promise<{ name: string; profile: Profile; isDefault: boolean }[]> {
  const config = await loadConfig();
  return Object.entries(config.profiles).map(([name, profile]) => ({
    name,
    profile,
    isDefault: config.defaultProfile === name,
  }));
}

export async function getProfile(name: string): Promise<Profile | undefined> {
  const config = await loadConfig();
  return config.profiles[name];
}
