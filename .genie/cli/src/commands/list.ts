import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import {
  loadSessions,
  saveSessions,
  SessionLoadConfig,
  SessionPathsConfig
} from '../session-store';
import { resolveDisplayStatus } from '../lib/session-helpers';
import {
  formatRelativeTime,
  formatPathRelative,
  safeIsoString,
  truncateText
} from '../lib/utils';
import { formatSessionList, type SessionEntry } from '../lib/markdown-formatter.js';
import { listAgents } from '../lib/agent-resolver';
import { DEFAULT_CONFIG } from '../lib/config-defaults';

export async function runRuns(
  parsed: ParsedCommand,
  config: GenieConfig,
  paths: Required<ConfigPaths>
): Promise<void> {
  const warnings: string[] = [];
  const store = loadSessions(
    paths as SessionPathsConfig,
    config as SessionLoadConfig,
    DEFAULT_CONFIG as any,
    { onWarning: (message) => warnings.push(message) }
  );

  // Cleanup zombie sessions (stuck in "running" for >24h with no live processes)
  const now = Date.now();
  const ZOMBIE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
  let zombieCount = 0;

  for (const [sessionId, entry] of Object.entries(store.sessions || {})) {
    if (entry.status === 'running' && entry.lastUsed) {
      const lastUsedTime = new Date(entry.lastUsed).getTime();
      const age = now - lastUsedTime;

      if (age > ZOMBIE_THRESHOLD_MS) {
        // Check if processes are actually dead
        const status = resolveDisplayStatus(entry);
        if (status !== 'running') {
          entry.status = 'abandoned';
          entry.lastUsed = new Date().toISOString();
          zombieCount++;
        }
      }
    }
  }

  if (zombieCount > 0) {
    saveSessions(paths as SessionPathsConfig, store);
    warnings.push(`Cleaned up ${zombieCount} zombie session(s)`);
  }

  const entries = Object.entries(store.sessions || {});
  const sessions: SessionEntry[] = entries.map(([sessionId, entry]) => ({
    sessionId: entry.sessionId || sessionId,
    agent: entry.agent,
    status: resolveDisplayStatus(entry),
    executor: String(entry.executor || 'unknown'),
    started: entry.created ? safeIsoString(entry.created) ?? undefined : undefined,
    updated: entry.lastUsed ? safeIsoString(entry.lastUsed) ?? undefined : undefined
  }));

  const markdown = formatSessionList(sessions);
  console.log(markdown);

  if (warnings.length) {
    console.log('\n⚠️  Warnings:');
    warnings.forEach(w => console.log(`  ${w}`));
  }
}

export async function runList(
  parsed: ParsedCommand,
  config: GenieConfig,
  paths: Required<ConfigPaths>
): Promise<void> {
  const [targetRaw] = parsed.commandArgs;

  if (!targetRaw) {
    console.log('Usage: genie list <agents|sessions>');
    console.log('       genie list agents       # (alias for agents)');
    return;
  }

  const target = targetRaw.toLowerCase();

  if (target === 'agents' || target === 'agents') {
    await emitAgentCatalog(parsed);
    return;
  }

  if (target === 'sessions') {
    await runRuns(parsed, config, paths);
    return;
  }

  console.error(`Error: Unknown list target '${targetRaw}'. Try 'agents' or 'sessions'.`);
  process.exitCode = 1;
}

interface TreeNode {
  name: string;
  type: 'agent' | 'workflow' | 'skill' | 'folder';
  path: string;
  description: string;
  children: Map<string, TreeNode>;
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

    // Determine type based on path
    let nodeType: 'agent' | 'workflow' | 'skill' | 'folder' = 'agent';
    if (agent.id.includes('/workflows/')) nodeType = 'workflow';
    else if (agent.id.includes('/skills/')) nodeType = 'skill';

    // Build tree structure
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

function renderTree(node: TreeNode, prefix: string = '', isLast: boolean = true, depth: number = 0): string[] {
  const lines: string[] = [];

  if (depth > 0) {
    const connector = isLast ? '└── ' : '├── ';
    const icon = node.type === 'agent' ? '🧠' : node.type === 'workflow' ? '⚙️ ' : node.type === 'skill' ? '💡' : '📁';
    const desc = node.description ? ` - ${truncateText(node.description, 80)}` : '';
    lines.push(`${prefix}${connector}${icon} ${node.name}${desc}`);
  }

  const children = Array.from(node.children.values()).sort((a, b) => {
    // Sort: folders first, then by type, then alphabetically
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

export async function emitAgentCatalog(parsed: ParsedCommand): Promise<void> {
  const allAgents = listAgents();

  // Separate by category
  const agents = allAgents.filter(a => !a.id.includes('/workflows/') && !a.id.includes('/skills/'));
  const workflows = allAgents.filter(a => a.id.includes('/workflows/'));
  const skills = allAgents.filter(a => a.id.includes('/skills/'));

  console.log(`## 🧞 Genie Agent Hierarchy\n`);
  console.log(`**Total:** ${agents.length} agents (${agents.length} agents, ${workflows.length} workflows, ${skills.length} skills)\n`);

  // Build and render tree
  const tree = buildTree(agents);
  const treeLines = renderTree(tree);
  console.log(treeLines.join('\n'));

  console.log('\n## 💡 Quick Guide\n');
  console.log('**Icons:**');
  console.log('  🧠 Agent (main executable agent)');
  console.log('  ⚙️  Workflow (agent-scoped sub-task)');
  console.log('  💡 Skill (capability/pattern)');
  console.log('  📁 Folder (organizational grouping)\n');
  console.log('**Commands:**');
  console.log('  genie run <agent-id> "<prompt>"    # Start a agent');
  console.log('  genie list sessions                 # View active sessions');
  console.log('  genie view <session-id>             # View session transcript');
}
