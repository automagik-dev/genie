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
    parts.push(`## Initial Command`, '', `Run \`/${opts.skill}\` to begin.`, '');
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
      return combined.slice(0, 50000) + '\n\n... (diff truncated at 50KB)';
    }
    return combined;
  } catch {
    return '';
  }
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
    console.error(`   Create it first: mkdir -p .genie/brainstorms/${slug} && touch .genie/brainstorms/${slug}/DRAFT.md`);
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
    const groups = content.match(/^### Group \d+:.*$/gm);
    if (groups) {
      for (const g of groups) console.error(`     ${g}`);
    }
    process.exit(1);
  }

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

  await handleWorkerSpawn(agentName, {
    provider: 'claude',
    team: process.env.GENIE_TEAM ?? 'genie',
    extraArgs: ['--append-system-prompt-file', contextFile],
  });
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
    diff ? '```diff\n' + diff + '\n```' : '(no uncommitted changes found — review committed changes)',
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

  // Note: this is a NEW dispatch command, separate from the existing `genie work <target>`
  // which handles task-based work. This command handles wish group dispatch.
  program
    .command('dispatch-work <agent> <ref>')
    .description('Dispatch work on a wish group (format: <slug>#<group>)')
    .action(async (agent: string, ref: string) => {
      await workDispatchCommand(agent, ref);
    });

  program
    .command('review <agent> <ref>')
    .description('Spawn agent with review scope for a wish group (format: <slug>#<group>)')
    .action(async (agent: string, ref: string) => {
      await reviewCommand(agent, ref);
    });
}
