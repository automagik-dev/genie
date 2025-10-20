import fs from 'fs';
import path from 'path';
import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { listAgents, listCollectives, type CollectiveInfo } from '../../lib/agent-resolver';
import { createForgeExecutor } from '../../lib/forge-executor';
import { formatSessionList } from '../../lib/markdown-formatter';
import { truncateText } from '../../lib/utils';

const COLLECTIVE_MARKER = 'AGENTS.md';

interface TreeNode {
  name: string;
  type: 'agent' | 'workflow' | 'skill' | 'folder';
  path: string;
  description: string;
  children: Map<string, TreeNode>;
}

export function createListHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
    const [targetRaw] = parsed.commandArgs;
    const target = (targetRaw || 'collectives').toLowerCase();

    if (target === 'collectives' || target === 'agents') {
      return listCollectivesView(ctx, parsed);
    }

    if (target === 'sessions') {
      const forgeExecutor = createForgeExecutor();
      await forgeExecutor.syncProfiles(ctx.config.forge?.executors);
      try {
        const sessions = await forgeExecutor.listSessions();
        const markdown = formatSessionList(
          sessions.map((session) => ({
            sessionId: session.id,
            agent: session.agent,
            status: session.status,
            executor: [session.executor, session.variant].filter(Boolean).join('/'),
            started: session.created,
            updated: session.updated
          }))
        );
        await ctx.emitView(markdown, parsed.options);
        return;
      } catch (err) {
        console.warn('Failed to fetch Forge sessions, falling back to local store');
      }

      const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
      const sessions = Object.entries(store.sessions || {}).map(([name, entry]) => ({
        sessionId: name,
        agent: entry.agent,
        status: entry.status || 'unknown',
        executor: [entry.executor, entry.executorVariant].filter(Boolean).join('/'),
        started: entry.created,
        updated: entry.lastUsed
      }));
      const markdown = formatSessionList(sessions);
      await ctx.emitView(markdown, parsed.options);
      return;
    }

    throw new Error(`Unknown list target '${targetRaw}'. Try 'agents' or 'sessions'.`);
  };
}

async function listCollectivesView(ctx: HandlerContext, parsed: ParsedCommand): Promise<void> {
  const allCollectives = listCollectives();
  const activeCollectives = allCollectives.filter(info => info.agentsDir);
  const agents = listAgents();

  const agentsByCollective = new Map<string, ReturnType<typeof listAgents>>();
  agents.forEach(agent => {
    const key = agent.collective || 'root';
    if (!agentsByCollective.has(key)) {
      agentsByCollective.set(key, []);
    }
    agentsByCollective.get(key)!.push(agent);
  });

  const workspaceRoot = path.join(process.cwd(), '.genie');
  const workspaceDocs = listMarkdownDocs(workspaceRoot, new Set([COLLECTIVE_MARKER]));
  const supportingDirs = ['skills', 'product', 'teams']
    .filter(dir => fs.existsSync(path.join(workspaceRoot, dir)) && fs.statSync(path.join(workspaceRoot, dir)).isDirectory());

  const orderedCollectives = activeCollectives.slice().sort((a, b) => a.collective.localeCompare(b.collective));

  const lines: string[] = [];
  lines.push(`# Genie Atlas`);
  lines.push(`Workspace: ${workspaceRoot}`);
  if (workspaceDocs.length) {
    lines.push(`Workspace docs: ${workspaceDocs.join(', ')}`);
  }
  if (supportingDirs.length) {
    lines.push(`Supporting directories (context only): ${supportingDirs.join(', ')}`);
  }
  lines.push('');
  lines.push(`Collectives: ${orderedCollectives.length} • Agents: ${agents.length}`);
  lines.push('');

  orderedCollectives.forEach(info => {
    const collectiveAgents = agentsByCollective.get(info.collective) || [];
    const summary = buildCollectiveSummary(info, collectiveAgents);

    lines.push(`## ${summary.title}`);
    lines.push(`Path: ${summary.relativePath}`);
    lines.push(`Counts → agents: ${summary.counts.agents} • workflows: ${summary.counts.workflows} • skills: ${summary.counts.skills} • teams: ${summary.counts.teams}`);

    if (summary.agentsDir) lines.push(`Agents dir: ${summary.agentsDir}`);
    if (summary.skillsDir && summary.skills.length) lines.push(`Skills dir: ${summary.skillsDir}`);
    if (summary.teamsDir && summary.teams.length) lines.push(`Teams dir: ${summary.teamsDir}`);

    const docLine = formatInlineList(summary.docs, 'Docs');
    if (docLine) lines.push(docLine);
    const skillLine = formatInlineList(summary.skills, 'Skills');
    if (skillLine) lines.push(skillLine);
    const teamLine = formatInlineList(summary.teams, 'Teams');
    if (teamLine) lines.push(teamLine);

    if (summary.agentTree.length) {
      summary.agentTree.forEach(line => lines.push(line));
    } else {
      lines.push('_No executable agents._');
    }

    summary.notes.forEach(note => lines.push(note));
    lines.push('');
  });

  lines.push('Tip: Use `genie run <collective>/<agent> "<prompt>"` to start sessions.');
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

function buildCollectiveSummary(info: CollectiveInfo, agents: ReturnType<typeof listAgents>) {
  const workspaceRoot = path.join(process.cwd(), '.genie');
  const relativePath = path.relative(workspaceRoot, info.root) || '.genie';

  const workflows = agents.filter(agent => agent.id.includes('/workflows/'));
  const agentTree = agents.length ? renderTree(buildTree(agents)) : [];

  const skillsDir = path.join(info.root, 'skills');
  const skills = fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()
    ? listMarkdownDocs(skillsDir)
    : [];

  const teamsDir = path.join(info.root, 'teams');
  const teams: string[] = [];
  if (fs.existsSync(teamsDir) && fs.statSync(teamsDir).isDirectory()) {
    const entries = fs.readdirSync(teamsDir, { withFileTypes: true });
    entries.forEach(entry => {
      if (entry.name.startsWith('.')) return;
      if (entry.isFile() && entry.name.endsWith('.md')) {
        teams.push(entry.name.replace(/\.md$/i, ''));
      } else if (entry.isDirectory()) {
        teams.push(`${entry.name}/`);
      }
    });
    teams.sort((a, b) => a.localeCompare(b));
  }

  const rawDocs = listMarkdownDocs(info.root, new Set([COLLECTIVE_MARKER]));
  const docs = rawDocs.filter(name => !skills.includes(name) && !teams.includes(name));

  const counts = {
    agents: agents.filter(agent => !agent.id.includes('/workflows/')).length,
    workflows: workflows.length,
    skills: skills.length,
    teams: teams.length
  };

  const notes: string[] = [];
  if (!info.agentsDir) {
    notes.push('_Documentation-only collective (no executable agents)._');
  }

  return {
    title: `${info.collective} collective • agents=${counts.agents} • workflows=${counts.workflows}`,
    relativePath,
    counts,
    docs,
    skills,
    teams,
    agentsDir: info.agentsDir ? path.relative(workspaceRoot, info.agentsDir) : null,
    skillsDir: skills.length ? path.relative(workspaceRoot, skillsDir) : null,
    teamsDir: teams.length ? path.relative(workspaceRoot, teamsDir) : null,
    agentTree,
    notes
  };
}

function buildTree(agents: ReturnType<typeof listAgents>): TreeNode {
  const root: TreeNode = {
    name: 'root',
    type: 'folder',
    path: '',
    description: '',
    children: new Map()
  };

  agents.forEach((agent) => {
    const parts = agent.id.split('/');
    let current = root;

    let nodeType: TreeNode['type'] = 'agent';
    if (agent.id.includes('/workflows/')) nodeType = 'workflow';
    else if (agent.id.includes('/skills/')) nodeType = 'skill';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          type: isLast ? nodeType : 'folder',
          path: parts.slice(0, i + 1).join('/'),
          description: isLast
            ? (((agent.meta?.description || agent.meta?.summary || '') as string)
                .replace(/\s+/g, ' ')
                .trim() || '')
            : '',
          children: new Map()
        });
      }

      current = current.children.get(part)!;
    }
  });

  return root;
}

function renderTree(node: TreeNode, prefix = '', isLast = true, depth = 0): string[] {
  const lines: string[] = [];

  if (depth > 0) {
    const connector = isLast ? '└── ' : '├── ';
    const icon = node.type === 'agent' ? '🧠' : node.type === 'workflow' ? '⚙️ ' : node.type === 'skill' ? '💡' : '📁';
    const desc = node.description ? ` - ${truncateText(node.description, 80)}` : '';
    lines.push(`${prefix}${connector}${icon} ${node.name}${desc}`);
  }

  const children = Array.from(node.children.values()).sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.name.localeCompare(b.name);
  });

  children.forEach((child, index) => {
    const isChildLast = index === children.length - 1;
    const extension = isLast ? '    ' : '│   ';
    const childPrefix = depth > 0 ? prefix + extension : '';
    lines.push(...renderTree(child, childPrefix, isChildLast, depth + 1));
  });

  return lines;
}

function formatInlineList(items: string[], label: string, limit = 6): string | null {
  if (!items.length) return null;
  const truncated = items.slice(0, limit);
  if (items.length > limit) {
    truncated.push(`… (+${items.length - limit})`);
  }
  return `${label}: ${truncated.join(', ')}`;
}
