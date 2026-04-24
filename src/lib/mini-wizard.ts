/**
 * Mini-Wizard — Streamlined first-run onboarding during `genie init`.
 *
 * A condensed version of the full /wizard skill, designed to run inline
 * during workspace initialization. Shows effective defaults, lets the user
 * customize workspace-level settings, and provides next-steps guidance.
 *
 * Uses BUILTIN_DEFAULTS and computeEffectiveDefaults from the cascading
 * defaults system (genie-model-resolution).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentDefaults, BUILTIN_DEFAULTS, type DefaultField, computeEffectiveDefaults } from './defaults.js';
import type { DiscoveredAgent } from './discovery.js';
import type { PendingAgent } from './pending-agents.js';
import type { WorkspaceConfig } from './workspace.js';

// ============================================================================
// Types
// ============================================================================

export interface WizardContext {
  /** Workspace root directory. */
  workspaceRoot: string;
  /** Workspace name (directory basename). */
  workspaceName: string;
  /** Current workspace config. */
  config: WorkspaceConfig;
  /** Agents discovered outside canonical agents/. */
  discovered: DiscoveredAgent[];
  /** Pending agents from the queue. */
  pending: PendingAgent[];
  /** Number of canonical agents already in agents/. */
  canonicalAgentCount: number;
}

export interface WizardResult {
  /** Whether the user customized any defaults. */
  customized: boolean;
  /** Updated workspace defaults (if customized). */
  defaults?: Partial<AgentDefaults>;
  /** Agents the user chose to import. */
  importedAgents: string[];
  /** Whether the wizard completed (vs. was skipped). */
  completed: boolean;
}

// ============================================================================
// Display helpers
// ============================================================================

/** Format effective defaults for display. */
export function formatDefaults(workspaceDefaults?: Partial<AgentDefaults>): string {
  const effective = computeEffectiveDefaults(workspaceDefaults);
  const lines: string[] = [];

  for (const key of Object.keys(BUILTIN_DEFAULTS) as DefaultField[]) {
    const value = effective[key];
    const source = workspaceDefaults?.[key] !== undefined ? 'workspace' : 'built-in';
    lines.push(`  ${key}: ${value} (${source})`);
  }

  return lines.join('\n');
}

/** Format the welcome banner. */
export function formatWelcome(ctx: WizardContext): string {
  const lines: string[] = [
    '',
    `  Workspace: ${ctx.workspaceName}`,
    `  Agents:    ${ctx.canonicalAgentCount} registered`,
  ];

  if (ctx.discovered.length > 0) {
    lines.push(`  Discovered: ${ctx.discovered.length} external agent(s) found`);
  }

  lines.push('');
  lines.push('  Effective defaults:');
  lines.push(formatDefaults(ctx.config.agents?.defaults));
  lines.push('');

  return lines.join('\n');
}

/** Format next-steps guidance. */
export function formatNextSteps(ctx: WizardContext): string {
  const lines: string[] = ['', '  Next steps:'];

  if (ctx.canonicalAgentCount === 0) {
    lines.push('    genie init agent <name>   Scaffold your first agent');
  }

  lines.push('    genie spawn <agent>       Launch an agent');
  lines.push('    genie team create <name>  Create a multi-agent team');
  lines.push('    /wizard                   Full guided onboarding');
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Interactive wizard
// ============================================================================

/** Known model choices for the select prompt. */
const MODEL_CHOICES = [
  { name: 'opus (most capable)', value: 'opus' },
  { name: 'sonnet (balanced)', value: 'sonnet' },
  { name: 'haiku (fastest)', value: 'haiku' },
];

/**
 * Run the interactive mini-wizard.
 *
 * Shows effective defaults, offers customization, handles discovered agents.
 * Returns the result describing what changed.
 */
export async function runMiniWizard(ctx: WizardContext): Promise<WizardResult> {
  const { confirm } = await import('@inquirer/prompts');

  console.log(formatWelcome(ctx));

  // Ask if user wants to customize defaults
  const wantCustomize = await confirm({
    message: 'Customize workspace defaults?',
    default: false,
  });

  const result: WizardResult = {
    customized: false,
    importedAgents: [],
    completed: true,
  };

  if (wantCustomize) {
    const newDefaults = await customizeDefaults(ctx.config.agents?.defaults);
    if (newDefaults) {
      result.customized = true;
      result.defaults = newDefaults;
      persistDefaults(ctx.workspaceRoot, newDefaults);
    }
  }

  // Show discovered agents if any
  if (ctx.pending.length > 0) {
    console.log(`\n  Found ${ctx.pending.length} agent(s) in your project tree:`);
    for (const agent of ctx.pending) {
      console.log(`    ${agent.name} (${agent.relativePath})`);
    }

    const wantImport = await confirm({
      message: 'Import discovered agents into workspace?',
      default: true,
    });

    if (wantImport) {
      result.importedAgents = ctx.pending.map((a) => a.name);
    }
  }

  console.log(formatNextSteps(ctx));

  return result;
}

/**
 * Interactive defaults customization.
 * Returns the new defaults to merge, or null if no changes.
 */
async function customizeDefaults(currentDefaults?: Partial<AgentDefaults>): Promise<Partial<AgentDefaults> | null> {
  const { select } = await import('@inquirer/prompts');
  const effective = computeEffectiveDefaults(currentDefaults);
  const updates: Partial<AgentDefaults> = {};
  let changed = false;

  // Model selection
  const model = await select({
    message: 'Default model:',
    choices: MODEL_CHOICES,
    default: effective.model,
  });
  if (model !== BUILTIN_DEFAULTS.model) {
    updates.model = model;
    changed = true;
  }

  // Permission mode
  const permChoices = [
    { name: 'auto (tool-by-tool judgment — default)', value: 'auto' },
    { name: 'default (ask for risky tools)', value: 'default' },
    { name: 'plan (require plan approval)', value: 'plan' },
    { name: 'bypassPermissions (auto-approve all)', value: 'bypassPermissions' },
  ];
  const permissionMode = await select({
    message: 'Default permission mode:',
    choices: permChoices,
    default: effective.permissionMode,
  });
  if (permissionMode !== BUILTIN_DEFAULTS.permissionMode) {
    updates.permissionMode = permissionMode;
    changed = true;
  }

  return changed ? updates : null;
}

/**
 * Persist updated defaults to workspace.json.
 */
function persistDefaults(workspaceRoot: string, newDefaults: Partial<AgentDefaults>): void {
  const configPath = join(workspaceRoot, '.genie', 'workspace.json');

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as WorkspaceConfig;

    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};

    Object.assign(config.agents.defaults, newDefaults);

    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    console.log('  Workspace defaults updated.');
  } catch (err) {
    console.error(`  Failed to update workspace.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}
