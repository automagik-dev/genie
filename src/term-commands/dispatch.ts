/**
 * Dispatch Commands — Context-injecting spawn commands that bridge
 * the wish state machine and agent spawn.
 *
 * Commands:
 *   genie brainstorm <agent> <slug>     — Spawn with DRAFT.md content
 *   genie wish <agent> <slug>           — Spawn with DESIGN.md content
 *   genie work <agent> <slug>#<group>   — Check state, start group, spawn with context
 *   genie review <agent> <slug>#<group> — Spawn with group + git diff context
 *
 * All commands inject:
 *   1. The file path to the full document (so agent can read it)
 *   2. The extracted section content (so agent has immediate context)
 *   3. Wish-level context when available (summary, scope, decisions)
 *
 * Context is written to a temp file and passed via --append-system-prompt-file
 * through extraArgs in the spawn params.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import * as protocolRouter from '../lib/protocol-router.js';
import type { GroupDefinition } from '../lib/wish-state.js';
import * as wishState from '../lib/wish-state.js';
import { handleWorkerSpawn } from './agents.js';
import { parseRef } from './state.js';

// ============================================================================
// Context Injection Utilities
// ============================================================================

/**
 * Write dispatch context to a temp file.
 * Returns the file path for use with --append-system-prompt-file.
 */
export async function writeContextFile(content: string): Promise<string> {
  const dir = join(tmpdir(), 'genie-dispatch');
  await mkdir(dir, { recursive: true });
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  const filePath = join(dir, `ctx-${ts}-${rand}.md`);
  await writeFile(filePath, content);
  return filePath;
}

/**
 * Extract a specific group section from WISH.md content.
 *
 * Groups are delimited by `### Group <N>: <title>` headings
 * and separated by `---` lines or the next group heading.
 */
export function extractGroup(content: string, groupName: string): string | null {
  const pattern = new RegExp(`^### Group ${escapeRegExp(groupName)}:`, 'm');
  const match = content.match(pattern);
  if (!match || match.index === undefined) return null;

  const start = match.index;
  const afterHeading = content.slice(start);

  // Find next group heading or HR separator
  const nextBoundary = afterHeading.slice(1).search(/^### Group \d|^---$/m);
  const end = nextBoundary !== -1 ? start + 1 + nextBoundary : content.length;

  return content.slice(start, end).trim();
}

/**
 * Extract wish-level context (everything before ## Execution Groups).
 * This includes Summary, Scope, and Decisions sections.
 */
export function extractWishContext(content: string): string {
  const execGroupsIdx = content.indexOf('## Execution Groups');
  if (execGroupsIdx !== -1) {
    return content.slice(0, execGroupsIdx).trim();
  }
  // If no execution groups section, return the whole content up to 2000 chars
  return content.slice(0, 2000).trim();
}

/** Escape regex special characters. */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a dispatch context prompt that gives the agent:
 * - The file path to read the full document
 * - The extracted section content
 * - Optional wish-level context
 */
export function buildContextPrompt(opts: {
  filePath: string;
  sectionContent: string;
  wishContext?: string;
  command: string;
  skill?: string;
}): string {
  const parts = [
    `# Dispatch Context (${opts.command})`,
    '',
    `**Source file:** \`${opts.filePath}\``,
    '(Read the full document at the path above for complete context)',
    '',
  ];

  if (opts.wishContext) {
    parts.push('## Wish Context', '', opts.wishContext, '');
  }

  parts.push('## Assigned Section', '', opts.sectionContent, '');

  if (opts.skill) {
    parts.push('## Initial Command', '', `Run \`/${opts.skill}\` to begin.`, '');
  }

  return parts.join('\n');
}

/**
 * Get git diff context for review commands.
 * Returns the diff output or empty string if no changes.
 */
function getGitDiff(): string {
  try {
    const diff = execSync('git diff HEAD', { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    const staged = execSync('git diff --cached', { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    const combined = [diff, staged].filter(Boolean).join('\n');
    // Limit diff size to avoid overwhelming the context
    if (combined.length > 50000) {
      return `${combined.slice(0, 50000)}\n\n... (diff truncated at 50KB)`;
    }
    return combined;
  } catch {
    return '';
  }
}

/**
 * Parse WISH.md content to extract group definitions for state initialization.
 * Looks for `### Group <id>: <title>` headings and `**depends-on:**` lines.
 * Accepts both numbered (Group 1) and lettered (Group A) identifiers.
 */
export function parseWishGroups(content: string): GroupDefinition[] {
  const groups: GroupDefinition[] = [];
  const groupPattern = /^### Group ([A-Za-z0-9]+):/gim;

  let match: RegExpExecArray | null = groupPattern.exec(content);
  while (match !== null) {
    const name = match[1];
    const start = match.index;

    // Find the next group heading or end of content
    const rest = content.slice(start + match[0].length);
    const nextGroupIdx = rest.search(/^### Group [A-Za-z0-9]+:/m);
    const section = nextGroupIdx !== -1 ? rest.slice(0, nextGroupIdx) : rest;

    // Look for **depends-on:** line within this group section
    const depsMatch = section.match(/\*\*depends-on:\*\*\s*(.+)/i);
    let dependsOn: string[] = [];
    if (depsMatch) {
      const depsStr = depsMatch[1].trim();
      const depsNormalized = depsStr.replace(/\s*\([^)]*\)/g, '').trim();
      if (depsNormalized.toLowerCase() !== 'none') {
        dependsOn = depsStr
          .split(',')
          .map((d) =>
            d
              .trim()
              .replace(/^group\s*/i, '')
              .replace(/\s*\(.*\)\s*$/, '')
              .trim(),
          )
          .filter(Boolean);
      }
    }

    groups.push({ name, dependsOn });
    match = groupPattern.exec(content);
  }

  return groups;
}

// ============================================================================
// Execution Strategy Parser
// ============================================================================

export interface WaveGroup {
  group: string;
  agent: string;
}

export interface Wave {
  name: string;
  groups: WaveGroup[];
}

/**
 * Parse the Execution Strategy section from WISH.md content.
 *
 * Looks for `## Execution Strategy` section, then parses `### Wave N` headings
 * with their markdown tables (Group | Agent | Description).
 *
 * Falls back to a single wave with all groups assigned to `engineer` if no
 * Execution Strategy section is found.
 */
export function parseExecutionStrategy(content: string): Wave[] {
  // Find the Execution Strategy section
  const strategyMatch = content.match(/^## Execution Strategy\s*$/m);
  if (!strategyMatch || strategyMatch.index === undefined) {
    return buildFallbackWaves(content);
  }

  const strategyStart = strategyMatch.index + strategyMatch[0].length;

  // Find the end of the Execution Strategy section (next ## heading or end of content)
  const nextSectionMatch = content.slice(strategyStart).match(/^## /m);
  const strategyEnd = nextSectionMatch?.index !== undefined ? strategyStart + nextSectionMatch.index : content.length;

  const strategyContent = content.slice(strategyStart, strategyEnd);

  // Parse each ### Wave heading and its table
  const waves: Wave[] = [];
  const wavePattern = /^### (Wave \d+[^\n]*)/gm;
  let waveMatch: RegExpExecArray | null = wavePattern.exec(strategyContent);

  while (waveMatch !== null) {
    const waveName = waveMatch[1].trim();
    const waveStart = waveMatch.index + waveMatch[0].length;

    // Find the end of this wave section (next ### heading or end of strategy)
    const restAfterWave = strategyContent.slice(waveStart);
    const nextWaveIdx = restAfterWave.search(/^### /m);
    const waveEnd = nextWaveIdx !== -1 ? waveStart + nextWaveIdx : strategyContent.length;

    const waveContent = strategyContent.slice(waveStart, waveEnd);

    // Parse markdown table rows (skip header row and separator)
    const waveGroups: WaveGroup[] = [];
    const tableRowPattern = /^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*[^|]*\s*\|$/gm;
    let rowMatch: RegExpExecArray | null = tableRowPattern.exec(waveContent);

    while (rowMatch !== null) {
      const groupVal = rowMatch[1].trim();
      const agentVal = rowMatch[2].trim();

      // Skip header row and separator row
      if (groupVal !== 'Group' && !groupVal.startsWith('-')) {
        waveGroups.push({ group: groupVal, agent: agentVal });
      }

      rowMatch = tableRowPattern.exec(waveContent);
    }

    if (waveGroups.length > 0) {
      waves.push({ name: waveName, groups: waveGroups });
    }

    waveMatch = wavePattern.exec(strategyContent);
  }

  // If strategy section exists but had no parseable waves, fall back
  if (waves.length === 0) {
    return buildFallbackWaves(content);
  }

  return waves;
}

/**
 * Build fallback waves — all groups in a single wave with `engineer` as default agent.
 */
function buildFallbackWaves(content: string): Wave[] {
  const groups = parseWishGroups(content);
  if (groups.length === 0) return [];

  return [
    {
      name: 'Wave 1 (sequential fallback)',
      groups: groups.map((g) => ({ group: g.name, agent: 'engineer' })),
    },
  ];
}

// ============================================================================
// Auto-Orchestration (fire-and-forget)
// ============================================================================

/**
 * Detect whether `genie work` should run in auto or manual mode.
 *
 * - 1 arg, no `#` → auto mode (slug only)
 * - 2 args, first has `#` → manual mode, new style: `work <slug#group> <agent>`
 * - 2 args, second has `#` → manual mode, old style: `work <agent> <slug#group>`
 */
export function detectWorkMode(
  ref: string,
  agent?: string,
): { mode: 'auto'; slug: string } | { mode: 'manual'; ref: string; agent: string } {
  if (!agent) {
    if (ref.includes('#')) {
      throw new Error('Manual dispatch requires an agent: genie work <slug>#<group> <agent>');
    }
    return { mode: 'auto', slug: ref };
  }

  if (ref.includes('#')) {
    return { mode: 'manual', ref, agent };
  }
  if (agent.includes('#')) {
    // Backwards compatible: genie work <agent> <slug>#<group>
    return { mode: 'manual', ref: agent, agent: ref };
  }

  throw new Error('Invalid: ref must contain "#" — use "genie work <slug>" or "genie work <agent> <slug>#<group>"');
}

/**
 * `genie work <slug>` — Fire-and-forget wish dispatch.
 *
 * Reads the Execution Strategy, finds the first wave with unstarted groups,
 * spawns all agents for that wave in parallel, prints guidance, and returns
 * the terminal immediately. Wave advancement is handled by `genie done`
 * notifying the team-lead.
 */
export async function autoOrchestrateCommand(slug: string): Promise<void> {
  const wishPath = join(process.cwd(), '.genie', 'wishes', slug, 'WISH.md');

  if (!existsSync(wishPath)) {
    console.error(`❌ Wish not found: ${wishPath}`);
    console.error(`   Create it first: genie wish <agent> ${slug}`);
    process.exit(1);
  }

  const content = await readFile(wishPath, 'utf-8');
  const groups = parseWishGroups(content);
  const waves = parseExecutionStrategy(content);

  if (waves.length === 0) {
    console.error('❌ No execution groups found in wish');
    process.exit(1);
  }

  // Auto-initialize wish state if missing (prevents polling loop when no state exists)
  const state = await wishState.getOrCreateState(slug, groups);

  // Find the first wave with groups that are still `ready` (not started/done)
  const nextWave = waves.find((wave) =>
    wave.groups.some((g) => {
      const gs = state?.groups[g.group];
      return !gs || gs.status === 'ready';
    }),
  );

  if (!nextWave) {
    console.log(`✅ All waves already dispatched for wish "${slug}"`);
    return;
  }

  console.log(`🚀 Dispatching ${nextWave.name} for wish "${slug}" — ${nextWave.groups.length} group(s)`);

  // Dispatch all groups in this wave concurrently.
  // workDispatchCommand spawns a tmux pane and returns immediately.
  await Promise.all(
    nextWave.groups.map(({ group, agent }) => {
      const ref = `${slug}#${group}`;
      return workDispatchCommand(agent, ref);
    }),
  );

  const groupList = nextWave.groups.map((g) => g.group).join(', ');
  console.log(`\n✅ Agents dispatched for ${nextWave.name} (groups: ${groupList})`);
  console.log(`   Monitor: genie status ${slug}`);
  console.log('   Logs:    genie read <agent>');
}

// ============================================================================
// Dispatch Commands
// ============================================================================

/**
 * `genie brainstorm <agent> <slug>` — Read DRAFT.md, spawn agent with content.
 */
export async function brainstormCommand(agentName: string, slug: string): Promise<void> {
  const draftPath = join(process.cwd(), '.genie', 'brainstorms', slug, 'DRAFT.md');

  if (!existsSync(draftPath)) {
    console.error(`❌ Draft not found: ${draftPath}`);
    console.error(
      `   Create it first: mkdir -p .genie/brainstorms/${slug} && touch .genie/brainstorms/${slug}/DRAFT.md`,
    );
    process.exit(1);
  }

  const content = await readFile(draftPath, 'utf-8');
  const context = buildContextPrompt({
    filePath: draftPath,
    sectionContent: content,
    command: 'brainstorm',
    skill: 'brainstorm',
  });

  const contextFile = await writeContextFile(context);
  console.log(`📝 Dispatching brainstorm to ${agentName} for "${slug}"`);
  console.log(`   Draft: ${draftPath}`);

  await handleWorkerSpawn(agentName, {
    provider: 'claude',
    team: process.env.GENIE_TEAM ?? 'genie',
    extraArgs: ['--append-system-prompt-file', contextFile],
  });

  // Deliver work prompt via mailbox (durable, queued to disk)
  const repoPath = process.cwd();
  await protocolRouter.sendMessage(
    repoPath,
    'cli',
    agentName,
    `Brainstorm "${slug}". Your context is in the system prompt. Explore the idea, ask clarifying questions, and build toward a design.`,
  );
}

/**
 * `genie wish <agent> <slug>` — Read DESIGN.md, spawn agent with content.
 */
export async function wishCommand(agentName: string, slug: string): Promise<void> {
  const designPath = join(process.cwd(), '.genie', 'brainstorms', slug, 'DESIGN.md');

  if (!existsSync(designPath)) {
    console.error(`❌ Design not found: ${designPath}`);
    console.error(`   Run brainstorm first: genie brainstorm <agent> ${slug}`);
    process.exit(1);
  }

  const content = await readFile(designPath, 'utf-8');
  const context = buildContextPrompt({
    filePath: designPath,
    sectionContent: content,
    command: 'wish',
    skill: 'wish',
  });

  const contextFile = await writeContextFile(context);
  console.log(`📝 Dispatching wish to ${agentName} for "${slug}"`);
  console.log(`   Design: ${designPath}`);

  await handleWorkerSpawn(agentName, {
    provider: 'claude',
    team: process.env.GENIE_TEAM ?? 'genie',
    extraArgs: ['--append-system-prompt-file', contextFile],
  });

  // Deliver work prompt via mailbox (durable, queued to disk)
  const repoPath = process.cwd();
  await protocolRouter.sendMessage(
    repoPath,
    'cli',
    agentName,
    `Create a wish from the design for "${slug}". Your context is in the system prompt. Write the WISH.md with execution groups, acceptance criteria, and validation commands.`,
  );
}

/**
 * `genie work <agent> <slug>#<group>` — Check state, start group, spawn with context.
 *
 * Flow:
 * 1. Parse ref (slug#group)
 * 2. Read WISH.md
 * 3. Extract group section
 * 4. Call wishState.startGroup() (enforces dependency order)
 * 5. Build context with wish-level info + group section
 * 6. Spawn agent
 */
export async function workDispatchCommand(agentName: string, ref: string): Promise<void> {
  const { slug, group } = parseRef(ref);
  const wishPath = join(process.cwd(), '.genie', 'wishes', slug, 'WISH.md');

  if (!existsSync(wishPath)) {
    console.error(`❌ Wish not found: ${wishPath}`);
    console.error(`   Create it first: genie wish <agent> ${slug}`);
    process.exit(1);
  }

  const content = await readFile(wishPath, 'utf-8');

  // Extract the specific group section
  const groupSection = extractGroup(content, group);
  if (!groupSection) {
    console.error(`❌ Group "${group}" not found in ${wishPath}`);
    console.error('   Available groups:');
    const groups = content.match(/^### Group [A-Za-z0-9]+:.*$/gm);
    if (groups) {
      for (const g of groups) console.error(`     ${g}`);
    }
    process.exit(1);
  }

  // Auto-initialize state if missing (prevents polling loop when no state exists)
  const groups = parseWishGroups(content);
  await wishState.getOrCreateState(slug, groups);

  // Start group in state machine (enforces dependencies)
  try {
    await wishState.startGroup(slug, group, agentName);
    console.log(`✅ Group "${group}" set to in_progress (assigned to ${agentName})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${message}`);
    process.exit(1);
  }

  // Build context with wish-level info + group section
  const wishContext = extractWishContext(content);
  const context = buildContextPrompt({
    filePath: wishPath,
    sectionContent: groupSection,
    wishContext,
    command: `work ${ref}`,
    skill: 'work',
  });

  const contextFile = await writeContextFile(context);
  console.log(`🔧 Dispatching work to ${agentName} for "${ref}"`);
  console.log(`   Wish: ${wishPath}`);
  console.log(`   Group: ${group}`);

  const effectiveRole = `${agentName}-${group}`;
  await handleWorkerSpawn(agentName, {
    provider: 'claude',
    team: process.env.GENIE_TEAM ?? 'genie',
    role: effectiveRole,
    extraArgs: ['--append-system-prompt-file', contextFile],
  });

  // Deliver work prompt via mailbox (durable, queued to disk)
  const repoPath = process.cwd();
  await protocolRouter.sendMessage(
    repoPath,
    'cli',
    effectiveRole,
    `Execute Group ${group} of wish "${slug}". Your full context is in the system prompt. Read the wish at ${wishPath} if needed. Implement all deliverables, run validation, and report completion.\n\nWhen done:\n1. Run: genie done ${slug}#${group}\n2. Run: genie send 'Group ${group} complete. <summary>' --to team-lead`,
  );
}

/**
 * `genie review <agent> <slug>#<group>` — Spawn with group + git diff context.
 */
export async function reviewCommand(agentName: string, ref: string): Promise<void> {
  const { slug, group } = parseRef(ref);
  const wishPath = join(process.cwd(), '.genie', 'wishes', slug, 'WISH.md');

  if (!existsSync(wishPath)) {
    console.error(`❌ Wish not found: ${wishPath}`);
    process.exit(1);
  }

  const content = await readFile(wishPath, 'utf-8');

  // Extract the specific group section
  const groupSection = extractGroup(content, group);
  if (!groupSection) {
    console.error(`❌ Group "${group}" not found in ${wishPath}`);
    process.exit(1);
  }

  // Get git diff for review context
  const diff = getGitDiff();

  const wishContext = extractWishContext(content);
  const reviewContent = [
    groupSection,
    '',
    '## Git Diff (changes to review)',
    '',
    diff ? `\`\`\`diff\n${diff}\n\`\`\`` : '(no uncommitted changes found — review committed changes)',
  ].join('\n');

  const context = buildContextPrompt({
    filePath: wishPath,
    sectionContent: reviewContent,
    wishContext,
    command: `review ${ref}`,
    skill: 'review',
  });

  const contextFile = await writeContextFile(context);
  console.log(`🔍 Dispatching review to ${agentName} for "${ref}"`);
  console.log(`   Wish: ${wishPath}`);
  console.log(`   Group: ${group}`);
  if (diff) console.log(`   Diff: ${diff.split('\n').length} lines`);

  await handleWorkerSpawn(agentName, {
    provider: 'claude',
    team: process.env.GENIE_TEAM ?? 'genie',
    extraArgs: ['--append-system-prompt-file', contextFile],
  });

  // Deliver work prompt via mailbox (durable, queued to disk)
  const repoPath = process.cwd();
  await protocolRouter.sendMessage(
    repoPath,
    'cli',
    agentName,
    `Review "${ref}". Your context and diff are in the system prompt. Evaluate against acceptance criteria and return SHIP, FIX-FIRST, or BLOCKED with severity-tagged findings.\n\nWhen done, report your verdict:\nRun: genie send '<SHIP|FIX-FIRST|BLOCKED> — <summary>' --to team-lead`,
  );
}

// ============================================================================
// Registration
// ============================================================================

export function registerDispatchCommands(program: Command): void {
  program
    .command('brainstorm <agent> <slug>')
    .description('Spawn agent with brainstorm DRAFT.md context')
    .action(async (agent: string, slug: string) => {
      await brainstormCommand(agent, slug);
    });

  program
    .command('wish <agent> <slug>')
    .description('Spawn agent with wish DESIGN.md context')
    .action(async (agent: string, slug: string) => {
      await wishCommand(agent, slug);
    });

  program
    .command('work <ref> [agent]')
    .description('Auto-orchestrate a wish, or dispatch work on a specific group')
    .action(async (ref: string, agent?: string) => {
      try {
        const work = detectWorkMode(ref, agent);
        if (work.mode === 'auto') {
          await autoOrchestrateCommand(work.slug);
        } else {
          await workDispatchCommand(work.agent, work.ref);
        }
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : error}`);
        process.exit(1);
      }
    });

  program
    .command('review <agent> <ref>')
    .description('Spawn agent with review scope for a wish group (format: <slug>#<group>)')
    .action(async (agent: string, ref: string) => {
      await reviewCommand(agent, ref);
    });
}
