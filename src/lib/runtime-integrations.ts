import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getCodexConfigPath, getCodexHome, migrateDeadGenieOtel } from './codex-config.js';

export type IntegrationSelection = 'auto' | 'codex' | 'claude' | 'all' | 'none';
export type RuntimeName = 'codex' | 'claude';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => CommandResult;

const defaultRunner: CommandRunner = (command, args) => {
  const result = Bun.spawnSync([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

function commandExists(command: string): boolean {
  return Boolean(Bun.which(command));
}

export function resolveBundleRoot(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.GENIE_BUNDLE_ROOT) return resolve(process.env.GENIE_BUNDLE_ROOT);
  const installed = dirname(process.execPath);
  if (existsSync(join(installed, 'plugins', 'genie'))) return installed;
  return resolve(import.meta.dir, '..', '..');
}

function jsonPayload(raw: string): unknown {
  const start = raw.indexOf('{');
  const arrayStart = raw.indexOf('[');
  const first = start < 0 ? arrayStart : arrayStart < 0 ? start : Math.min(start, arrayStart);
  if (first < 0) return undefined;
  try {
    return JSON.parse(raw.slice(first));
  } catch {
    return undefined;
  }
}

export function codexPluginState(raw: string): { installed: boolean; enabled?: boolean; version?: string } {
  const payload = jsonPayload(raw) as { installed?: Array<Record<string, unknown>> } | undefined;
  const plugin = payload?.installed?.find((entry) => entry.pluginId === 'genie@automagik');
  return plugin
    ? { installed: true, enabled: plugin.enabled === true, version: String(plugin.version ?? '') }
    : { installed: false };
}

export function claudePluginState(raw: string): { installed: boolean; enabled?: boolean; version?: string } {
  const payload = jsonPayload(raw) as Array<Record<string, unknown>> | undefined;
  const plugin = Array.isArray(payload) ? payload.find((entry) => entry.id === 'genie@automagik') : undefined;
  return plugin
    ? { installed: true, enabled: plugin.enabled === true, version: String(plugin.version ?? '') }
    : { installed: false };
}

function runChecked(runner: CommandRunner, command: string, args: string[], allowAlready = false): CommandResult {
  const result = runner(command, args);
  if (
    result.exitCode !== 0 &&
    !(allowAlready && /already|exists|configured/i.test(`${result.stdout}\n${result.stderr}`))
  ) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

export function installCodexAgents(bundleRoot: string, codexHome = getCodexHome()): number {
  const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents');
  if (!existsSync(source)) throw new Error(`Codex agents are missing from bundle: ${source}`);
  const target = join(codexHome, 'agents');
  mkdirSync(target, { recursive: true });
  let count = 0;
  for (const name of readdirSync(source)) {
    if (!name.startsWith('genie-') || !name.endsWith('.toml')) continue;
    copyFileSync(join(source, name), join(target, name));
    count += 1;
  }
  return count;
}

/** Restore an explicit disabled state after Codex refreshes an installed plugin. */
export function setCodexPluginEnabled(enabled: boolean, configPath = getCodexConfigPath()): void {
  if (!existsSync(configPath)) return;
  const content = readFileSync(configPath, 'utf8');
  const header = '[plugins."genie@automagik"]';
  const at = content.indexOf(header);
  if (at < 0) return;
  const next = content.indexOf('\n[', at + header.length);
  const end = next < 0 ? content.length : next + 1;
  const section = content.slice(at, end);
  const replacement = /(^|\n)enabled\s*=\s*(true|false)/.test(section)
    ? section.replace(/(^|\n)enabled\s*=\s*(true|false)/, `$1enabled = ${enabled}`)
    : section.replace(header, `${header}\nenabled = ${enabled}`);
  writeFileSync(configPath, `${content.slice(0, at)}${replacement}${content.slice(end)}`, 'utf8');
}

export interface IntegrationResult {
  runtime: RuntimeName;
  ok: boolean;
  detail: string;
  preservedDisabled?: boolean;
}

export interface InstallIntegrationsOptions {
  selection?: IntegrationSelection;
  bundleRoot?: string;
  runner?: CommandRunner;
  detected?: Partial<Record<RuntimeName, boolean>>;
  codexHome?: string;
}

export function installRuntimeIntegrations(options: InstallIntegrationsOptions = {}): IntegrationResult[] {
  const selection = options.selection ?? 'auto';
  if (selection === 'none') return [];
  const runner = options.runner ?? defaultRunner;
  const bundleRoot = resolveBundleRoot(options.bundleRoot);
  const detected = {
    codex: options.detected?.codex ?? commandExists('codex'),
    claude: options.detected?.claude ?? commandExists('claude'),
  };
  const targets: RuntimeName[] =
    selection === 'all'
      ? ['codex', 'claude']
      : selection === 'auto'
        ? (Object.keys(detected) as RuntimeName[]).filter((runtime) => detected[runtime])
        : [selection];

  return targets.map((runtime) => {
    if (!detected[runtime]) return { runtime, ok: false, detail: `${runtime} CLI not found` };
    try {
      if (runtime === 'codex') {
        const migration = migrateDeadGenieOtel(join(options.codexHome ?? getCodexHome(), 'config.toml'));
        if (migration.status === 'error') throw new Error(`Codex config migration failed: ${migration.error}`);
        const agents = installCodexAgents(bundleRoot, options.codexHome);
        const before = codexPluginState(runChecked(runner, 'codex', ['plugin', 'list', '--json']).stdout);
        runChecked(runner, 'codex', ['plugin', 'marketplace', 'add', bundleRoot, '--json'], true);
        runChecked(runner, 'codex', ['plugin', 'add', 'genie@automagik', '--json']);
        if (before.installed && before.enabled === false) {
          setCodexPluginEnabled(false, join(options.codexHome ?? getCodexHome(), 'config.toml'));
        }
        return {
          runtime,
          ok: true,
          detail: `plugin refreshed; ${agents} role agents installed`,
          preservedDisabled: before.installed && before.enabled === false,
        };
      }

      const before = claudePluginState(runChecked(runner, 'claude', ['plugin', 'list', '--json']).stdout);
      runChecked(runner, 'claude', ['plugin', 'marketplace', 'add', bundleRoot], true);
      if (before.installed) runChecked(runner, 'claude', ['plugin', 'update', 'genie@automagik']);
      else runChecked(runner, 'claude', ['plugin', 'install', 'genie@automagik']);
      return {
        runtime,
        ok: true,
        detail: 'plugin refreshed',
        preservedDisabled: before.installed && before.enabled === false,
      };
    } catch (error) {
      return { runtime, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** Remove only Genie-owned runtime integration state; shared marketplaces are opt-in. */
export function removeRuntimeIntegrations(removeMarketplace = false): void {
  const codexHome = getCodexHome();
  const agentsDir = join(codexHome, 'agents');
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir)) {
      if (!/^genie-.+\.toml$/.test(name)) continue;
      const path = join(agentsDir, name);
      try {
        if (readFileSync(path, 'utf8').startsWith('# Managed by Genie.')) unlinkSync(path);
      } catch {
        // Preserve unreadable or user-modified files.
      }
    }
  }
  if (commandExists('codex')) defaultRunner('codex', ['plugin', 'remove', 'genie@automagik']);
  if (commandExists('claude')) defaultRunner('claude', ['plugin', 'uninstall', 'genie@automagik']);
  if (removeMarketplace) {
    if (commandExists('codex')) defaultRunner('codex', ['plugin', 'marketplace', 'remove', 'automagik']);
    if (commandExists('claude')) defaultRunner('claude', ['plugin', 'marketplace', 'remove', 'automagik']);
  }
}
