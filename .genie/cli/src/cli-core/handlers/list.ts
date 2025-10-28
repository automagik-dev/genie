import fs from 'fs';
import path from 'path';
import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { listAgents, listCollectives, type CollectiveInfo } from '../../lib/agent-resolver';
import { createForgeExecutor } from '../../lib/forge-executor';
import { describeForgeError, FORGE_RECOVERY_HINT } from '../../lib/forge-helpers';
import { formatSessionList } from '../../lib/markdown-formatter';
import { truncateText } from '../../lib/utils';

const COLLECTIVE_MARKER = 'AGENTS.md';

export function createListHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
    const [targetRaw] = parsed.commandArgs;
    const target = (targetRaw || 'collectives').toLowerCase();

    if (target === 'collectives' || target === 'agents') {
      return listCollectivesView(ctx, parsed);
    }

    if (target === 'workflows') {
      return listWorkflowsView(ctx, parsed);
    }

    if (target === 'skills') {
      return listSkillsView(ctx, parsed);
    }

    if (target === 'sessions') {
      const forgeExecutor = createForgeExecutor();
      let forgeAvailable = true;
      try {
        // Skip config.forge.executors - incompatible format, Forge loads from its own config
        await forgeExecutor.syncProfiles();
      } catch (error) {
        forgeAvailable = false;
        const reason = describeForgeError(error);
        ctx.recordRuntimeWarning(`Forge sync failed: ${reason}`);
      }

      if (forgeAvailable) {
        try {
          const sessions = await forgeExecutor.listSessions();
          const markdown = formatSessionList(
            sessions.map((session) => ({
              sessionId: session.id,
              agent: session.agent,
              status: session.status,
              executor: [session.executor, session.variant].filter(Boolean).join('/'),
              model: session.model || undefined,
              started: session.created,
              updated: session.updated
            }))
          );
          await ctx.emitView(markdown, parsed.options);
          return;
        } catch (error) {
          forgeAvailable = false;
          const reason = describeForgeError(error);
          ctx.recordRuntimeWarning(`Forge session listing failed: ${reason}`);
        }
      }

      const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
      const sessions = Object.entries(store.sessions || {}).map(([name, entry]) => ({
        sessionId: name,
        agent: entry.agent,
        status: entry.status || 'unknown',
        executor: [entry.executor, entry.executorVariant].filter(Boolean).join('/'),
        model: entry.model || undefined,
        started: entry.created,
        updated: entry.lastUsed
      }));
      const markdown = formatSessionList(sessions);
      const fallbackLines = [
        '⚠️ Forge backend unreachable. Showing cached sessions from `.genie/state/agents/sessions.json`.',
        FORGE_RECOVERY_HINT,
        '',
        markdown.trim()
      ];
      await ctx.emitView(fallbackLines.join('\n'), parsed.options);
      return;
    }

    throw new Error(`Unknown list target '${targetRaw}'. Try 'agents', 'workflows', 'skills', or 'sessions'.`);
  };
}

async function listCollectivesView(ctx: HandlerContext, parsed: ParsedCommand): Promise<void> {
  const agents = listAgents();
  const lines: string[] = [];

  lines.push(`# Genie Agents (${agents.length} total)\n`);

  // Group by collective
  const byCollective = new Map<string, typeof agents>();
  agents.forEach(agent => {
    const key = agent.collective || 'root';
    if (!byCollective.has(key)) byCollective.set(key, []);
    byCollective.get(key)!.push(agent);
  });

  // Sort collectives
  const sorted = Array.from(byCollective.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  sorted.forEach(([collective, items]) => {
    lines.push(`## ${collective} (${items.length})`);
    items
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach(agent => {
        const desc = agent.meta?.description || agent.meta?.summary || '';
        const shortDesc = desc ? ` - ${truncateText(desc.replace(/\s+/g, ' ').trim(), 60)}` : '';
        lines.push(`  ${agent.id}${shortDesc}`);
      });
    lines.push('');
  });

  lines.push('Usage: `genie run <agent-id> "<prompt>"`');
  await ctx.emitView(lines.join('\n'), parsed.options);
}

function listMarkdownDocs(dir: string, exclude: Set<string> = new Set()): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md') && !exclude.has(entry.name))
    .map(entry => entry.name.replace(/\.md$/i, ''))
    .sort((a, b) => a.localeCompare(b));
}

async function listWorkflowsView(ctx: HandlerContext, parsed: ParsedCommand): Promise<void> {
  const workspaceRoot = path.join(process.cwd(), '.genie');
  const globalWorkflowsDir = path.join(workspaceRoot, 'workflows');
  const globalWorkflows = listMarkdownDocs(globalWorkflowsDir);

  const collectives = listCollectives();
  const ordered = collectives.slice().sort((a, b) => a.collective.localeCompare(b.collective));

  const lines: string[] = [];
  lines.push(`# Workflows Index`);
  lines.push('');
  lines.push(`## Global (.genie/workflows/)`);
  lines.push(globalWorkflows.length ? `- ${globalWorkflows.join('\n- ')}` : '_None_');
  lines.push('');

  ordered.forEach(info => {
    const wfDir = path.join(info.root, 'workflows');
    const items = listMarkdownDocs(wfDir);
    lines.push(`## ${info.collective} (${path.relative(workspaceRoot, wfDir)})`);
    lines.push(items.length ? `- ${items.join('\n- ')}` : '_None_');
    lines.push('');
  });

  await ctx.emitView(lines.join('\n'), parsed.options);
}

async function listSkillsView(ctx: HandlerContext, parsed: ParsedCommand): Promise<void> {
  const workspaceRoot = path.join(process.cwd(), '.genie');
  const globalSkillsDir = path.join(workspaceRoot, 'skills');
  const globalSkills = listMarkdownDocs(globalSkillsDir);

  const collectives = listCollectives();
  const ordered = collectives.slice().sort((a, b) => a.collective.localeCompare(b.collective));

  const lines: string[] = [];
  lines.push(`# Skills Index`);
  lines.push('');
  lines.push(`## Global (.genie/skills/)`);
  lines.push(globalSkills.length ? `- ${globalSkills.join('\n- ')}` : '_None_');
  lines.push('');

  ordered.forEach(info => {
    const skillsDir = path.join(info.root, 'skills');
    const items = listMarkdownDocs(skillsDir);
    lines.push(`## ${info.collective} (${path.relative(workspaceRoot, skillsDir)})`);
    lines.push(items.length ? `- ${items.join('\n- ')}` : '_None_');
    lines.push('');
  });

  await ctx.emitView(lines.join('\n'), parsed.options);
}
