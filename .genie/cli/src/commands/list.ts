import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import {
  loadSessions,
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

  const entries = Object.entries(store.agents || {});
  const sessions: SessionEntry[] = entries.map(([agent, entry]) => ({
    sessionId: entry.sessionId || 'pending',
    agent,
    status: resolveDisplayStatus(entry),
    executor: String(entry.executor || 'unknown'),
    started: entry.created ? safeIsoString(entry.created) : undefined,
    updated: entry.lastUsed ? safeIsoString(entry.lastUsed) : undefined
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
    return;
  }

  const target = targetRaw.toLowerCase();

  if (target === 'agents') {
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

export async function emitAgentCatalog(parsed: ParsedCommand): Promise<void> {
  const agents = listAgents();

  console.log(`## Available Agents (${agents.length} total)\n`);

  const grouped = new Map<string, typeof agents>();
  agents.forEach((entry) => {
    const folder = entry.folder ?? '.';
    if (!grouped.has(folder)) grouped.set(folder, []);
    grouped.get(folder)!.push(entry);
  });

  const orderedFolders = Array.from(grouped.keys()).sort((a, b) => {
    if (a === '.') return -1;
    if (b === '.') return 1;
    return a.localeCompare(b);
  });

  orderedFolders.forEach((folder) => {
    const label = folder === '.' ? 'root' : folder;
    console.log(`### ${label}\n`);

    const folderAgents = grouped.get(folder)!.sort((a, b) => a.label.localeCompare(b.label));

    folderAgents.forEach((agent) => {
      const description = ((agent.meta?.description || agent.meta?.summary || '') as string)
        .replace(/\s+/g, ' ')
        .trim();
      const summary = truncateText(description || '—', 96);
      console.log(`- **${agent.id}**: ${summary}`);
    });

    console.log('');
  });
}
