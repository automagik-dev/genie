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
import { endSpan, startSpan } from '../lib/emit.js';
import { isWideEmitEnabled } from '../lib/observability-flag.js';
import * as protocolRouter from '../lib/protocol-router.js';
import { getAmbient as getTraceContext } from '../lib/trace-context.js';
import { parseWishRef, resolveWish } from '../lib/wish-resolve.js';
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

const SLUG_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Validate a slug against path traversal. Throws on invalid input. */
export function validateSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    console.error(`❌ Invalid slug: "${slug}"`);
    console.error('   Slugs must match [a-zA-Z0-9._-]+ (no slashes, dots-dots, or special characters)');
    process.exit(1);
  }
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
  /** Pre-computed enrichment from brain vault (via enrichContext). */
  enrichedContext?: string;
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

  if (opts.enrichedContext) {
    parts.push(opts.enrichedContext);
  }

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
        dependsOn = depsNormalized
          .split(',')
          .map((d) =>
            d
              .trim()
              .replace(/^groups?\s*/i, '')
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

interface WaveGroup {
  group: string;
  agent: string;
}

interface Wave {
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
// Leader Resolution
// ============================================================================

/**
 * Resolve the leader name for --to in dispatch prompts.
 * Uses GENIE_TEAM to look up the team config's leader field.
 * Never returns 'team-lead' — falls back to teamName.
 */
async function resolveLeaderTarget(): Promise<string> {
  const teamName = process.env.GENIE_TEAM;
  if (!teamName) return 'team-lead';

  try {
    const { resolveLeaderName } = await import('../lib/team-manager.js');
    return await resolveLeaderName(teamName);
  } catch {
    return teamName;
  }
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
async function autoOrchestrateCommand(slug: string): Promise<void> {
  let wishPath: string;
  let actualSlug = slug;

  // Check for namespace/slug format — resolve and auto-create team
  const parsed = parseWishRef(slug);
  if (parsed.namespace) {
    const resolved = await resolveWish(slug);
    wishPath = resolved.wishPath;
    actualSlug = resolved.slug;

    // Auto-create team using the resolved repo and session
    const { handleTeamCreate } = await import('./team.js');
    await handleTeamCreate(actualSlug, {
      repo: resolved.repo,
      branch: 'dev',
      wish: actualSlug,
      tmuxSession: resolved.session,
    });
    return; // handleTeamCreate spawns the leader, which runs the full lifecycle
  }

  validateSlug(slug);
  wishPath = join(process.cwd(), '.genie', 'wishes', slug, 'WISH.md');

  if (!existsSync(wishPath)) {
    console.error(`❌ Wish not found: ${wishPath}`);
    console.error(`   Create it first: genie wish <agent> ${slug}`);
    process.exit(1);
  }

  // Best-effort: sync wish to PG index (non-blocking)
  import('../lib/wish-sync.js').then((ws) => ws.syncWishes(process.cwd())).catch(() => {});

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
  //
  // Use Promise.allSettled so a single group's post-dispatch failure doesn't
  // abort reporting for siblings whose state mutations already landed.
  // See issue #1207 — CONNECTION_ENDED on one dispatch was rejecting the
  // whole batch and suppressing the success print even when all groups
  // transitioned to in_progress.
  const results = await Promise.allSettled(
    nextWave.groups.map(({ group, agent }) => {
      const ref = `${slug}#${group}`;
      return workDispatchCommand(agent, ref);
    }),
  );

  const succeeded: string[] = [];
  const failed: { group: string; reason: string }[] = [];
  results.forEach((r, i) => {
    const groupName = nextWave.groups[i].group;
    if (r.status === 'fulfilled') {
      succeeded.push(groupName);
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      failed.push({ group: groupName, reason });
    }
  });

  if (succeeded.length > 0) {
    console.log(`\n✅ Agents dispatched for ${nextWave.name} (groups: ${succeeded.join(', ')})`);
  }
  if (failed.length > 0) {
    console.error(`\n❌ ${failed.length} group(s) failed to dispatch in ${nextWave.name}:`);
    for (const { group, reason } of failed) {
      console.error(`   • Group ${group}: ${reason}`);
    }
    console.error(`   Check state with: genie status ${slug}`);
    console.error('   Some groups may have mutated state before failing — rerun genie work to retry.');
  }
  console.log(`   Monitor: genie status ${slug}`);
  console.log('   Logs:    genie read <agent>');

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

// ============================================================================
// Dispatch Commands
// ============================================================================

/**
 * `genie brainstorm <agent> <slug>` — Read DRAFT.md, spawn agent with content.
 */
export async function brainstormCommand(agentName: string, slug: string): Promise<void> {
  validateSlug(slug);
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

  const brainstormPrompt = `Brainstorm "${slug}". Your context is in the system prompt. Explore the idea, ask clarifying questions, and build toward a design.`;
  await handleWorkerSpawn(agentName, {
    provider: 'claude',
    extraArgs: ['--append-system-prompt-file', contextFile],
    initialPrompt: brainstormPrompt,
  });

  // Deliver work prompt via mailbox as backup (durable, queued to disk)
  const repoPath = process.cwd();
  const result = await protocolRouter.sendMessage(repoPath, 'cli', agentName, brainstormPrompt);
  if (!result.delivered) {
    console.warn(`⚠ Backup delivery to ${agentName} failed: ${result.reason ?? 'unknown'}`);
  }
}

/**
 * `genie wish <agent> <slug>` — Read DESIGN.md, spawn agent with content.
 */
export async function wishCommand(agentName: string, slug: string): Promise<void> {
  validateSlug(slug);
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

  const wishPrompt = `Create a wish from the design for "${slug}". Your context is in the system prompt. Write the WISH.md with execution groups, acceptance criteria, and validation commands.`;
  await handleWorkerSpawn(agentName, {
    provider: 'claude',
    extraArgs: ['--append-system-prompt-file', contextFile],
    initialPrompt: wishPrompt,
  });

  // Deliver work prompt via mailbox as backup (durable, queued to disk)
  const repoPath = process.cwd();
  const result = await protocolRouter.sendMessage(repoPath, 'cli', agentName, wishPrompt);
  if (!result.delivered) {
    console.warn(`⚠ Backup delivery to ${agentName} failed: ${result.reason ?? 'unknown'}`);
  }
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
async function workDispatchCommand(agentName: string, ref: string): Promise<void> {
  const { slug, group } = parseRef(ref);
  validateSlug(slug);
  const wishPath = join(process.cwd(), '.genie', 'wishes', slug, 'WISH.md');

  const dispatchSpan = isWideEmitEnabled()
    ? startSpan(
        'wish.dispatch',
        { wish_slug: slug, group_name: group },
        { source_subsystem: 'dispatch', ctx: getTraceContext() ?? undefined, agent: agentName },
      )
    : null;
  try {
    await runWorkDispatch(slug, group, agentName, wishPath, ref);
    if (dispatchSpan) {
      endSpan(dispatchSpan, { outcome: 'completed' }, { source_subsystem: 'dispatch', agent: agentName });
    }
  } catch (err) {
    if (dispatchSpan) {
      endSpan(dispatchSpan, { outcome: 'failed' }, { source_subsystem: 'dispatch', agent: agentName });
    }
    throw err;
  }
}

async function runWorkDispatch(
  slug: string,
  group: string,
  agentName: string,
  wishPath: string,
  ref: string,
): Promise<void> {
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

  // Enrich with brain vault context (best-effort, non-blocking)
  let enrichedContext: string | undefined;
  try {
    const { enrichContext } = await import('../lib/context-enrichment.js');
    enrichedContext = enrichContext({ query: `${slug} ${group}: ${groupSection.slice(0, 500)}` }) || undefined;
  } catch {
    // enrichment unavailable — proceed without
  }

  const context = buildContextPrompt({
    filePath: wishPath,
    sectionContent: groupSection,
    wishContext,
    command: `work ${ref}`,
    skill: 'work',
    enrichedContext,
  });

  const contextFile = await writeContextFile(context);
  console.log(`🔧 Dispatching work to ${agentName} for "${ref}"`);
  console.log(`   Wish: ${wishPath}`);
  console.log(`   Group: ${group}`);

  const effectiveRole = `${agentName}-${group}`;
  const leaderTarget = await resolveLeaderTarget();
  const workPrompt = `Execute Group ${group} of wish "${slug}". Your full context is in the system prompt. Read the wish at ${wishPath} if needed. Implement all deliverables, run validation, and report completion.\n\nWhen done:\n1. Run: genie done ${slug}#${group}\n2. Run: genie send 'Group ${group} complete. <summary>' --to ${leaderTarget}`;
  await handleWorkerSpawn(agentName, {
    provider: 'claude',
    // P1 hotfix: forward the team context so spawn lands in the team's
    // tmux window, not in the operator's "current window". When this
    // option is omitted, agents.ts:1862 sets teamWasExplicit=false →
    // spawnIntoCurrentWindow=true → tmux split-window with no -t target,
    // which tmux resolves to the most-recently-active client (usually
    // the operator's pane). Authority:
    // ~/.genie/reports/trace-genie-spawn-wrong-window.md
    team: process.env.GENIE_TEAM,
    role: effectiveRole,
    extraArgs: ['--append-system-prompt-file', contextFile],
    initialPrompt: workPrompt,
  });

  // Deliver work prompt via mailbox as backup (durable, queued to disk)
  const repoPath = process.cwd();
  const result = await protocolRouter.sendMessage(repoPath, 'cli', effectiveRole, workPrompt);
  if (!result.delivered) {
    console.warn(`⚠ Backup delivery to ${effectiveRole} failed: ${result.reason ?? 'unknown'}`);
  }
}

/**
 * `genie review <agent> <slug>#<group>` — Spawn with group + git diff context.
 */
export async function reviewCommand(agentName: string, ref: string): Promise<void> {
  const { slug, group } = parseRef(ref);
  validateSlug(slug);
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

  // Enrich with brain vault context (best-effort, non-blocking)
  let enrichedReviewContext: string | undefined;
  try {
    const { enrichContext } = await import('../lib/context-enrichment.js');
    enrichedReviewContext =
      enrichContext({ query: `review ${slug} ${group}: ${groupSection.slice(0, 500)}` }) || undefined;
  } catch {
    // enrichment unavailable — proceed without
  }

  const context = buildContextPrompt({
    filePath: wishPath,
    sectionContent: reviewContent,
    wishContext,
    command: `review ${ref}`,
    skill: 'review',
    enrichedContext: enrichedReviewContext,
  });

  const contextFile = await writeContextFile(context);
  console.log(`🔍 Dispatching review to ${agentName} for "${ref}"`);
  console.log(`   Wish: ${wishPath}`);
  console.log(`   Group: ${group}`);
  if (diff) console.log(`   Diff: ${diff.split('\n').length} lines`);

  const reviewLeaderTarget = await resolveLeaderTarget();
  const reviewPrompt = `Review "${ref}". Your context and diff are in the system prompt. Evaluate against acceptance criteria and return SHIP, FIX-FIRST, or BLOCKED with severity-tagged findings.\n\nWhen done, report your verdict:\nRun: genie send '<SHIP|FIX-FIRST|BLOCKED> — <summary>' --to ${reviewLeaderTarget}`;
  await handleWorkerSpawn(agentName, {
    provider: 'claude',
    // P1 hotfix: forward team context (same root cause as workDispatchCommand
    // above). Review dispatch is also team-context — must not fall back to
    // operator's "current window".
    team: process.env.GENIE_TEAM,
    extraArgs: ['--append-system-prompt-file', contextFile],
    initialPrompt: reviewPrompt,
  });

  // Deliver work prompt via mailbox as backup (durable, queued to disk)
  const repoPath = process.cwd();
  const result = await protocolRouter.sendMessage(repoPath, 'cli', agentName, reviewPrompt);
  if (!result.delivered) {
    console.warn(`⚠ Backup delivery to ${agentName} failed: ${result.reason ?? 'unknown'}`);
  }
}

// ============================================================================
// Registration
// ============================================================================

export function registerDispatchCommands(program: Command): void {
  // Flat `brainstorm`, `wish`, `review` registrations were removed in Group 2
  // of wish-command-group-restructure. They now live under `genie dispatch`:
  //   genie dispatch brainstorm <agent> <slug>
  //   genie dispatch wish <agent> <slug>
  //   genie dispatch review <agent> <ref>
  // Handler functions are exported and wired by dispatch-group.ts.
  // `work` stays flat — hot path, by decision #2.

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
}
