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
import { buildRunsOverviewView, RunRow } from '../views/runs';
import { emitView } from '../lib/view-helpers';
import { buildListHelpView } from '../views/help';
import { buildErrorView } from '../views/common';
import { buildAgentCatalogView } from '../views/agent-catalog';
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
  const rows: RunRow[] = entries.map(([agent, entry]) => {
    const iso = entry.lastUsed ? safeIsoString(entry.lastUsed) : entry.created ? safeIsoString(entry.created) : null;
    return {
      agent,
      status: resolveDisplayStatus(entry),
      sessionId: entry.sessionId || null,
      updated: iso ? formatRelativeTime(iso) : 'n/a',
      updatedIso: iso,
      log: entry.logFile ? formatPathRelative(entry.logFile, paths.baseDir || '.') : null
    };
  });

  const isActive = (row: RunRow) => {
    const normalized = (row.status || '').toLowerCase();
    return normalized.startsWith('running') || normalized.startsWith('pending');
  };

  const sortByUpdated = (a: RunRow, b: RunRow) => {
    const aTime = a.updatedIso ? new Date(a.updatedIso).getTime() : 0;
    const bTime = b.updatedIso ? new Date(b.updatedIso).getTime() : 0;
    return bTime - aTime;
  };

  const active = rows.filter(isActive).sort(sortByUpdated);
  const recent = rows.filter((row) => !isActive(row)).sort(sortByUpdated).slice(0, 10);

  const envelope = buildRunsOverviewView({
    active,
    recent,
    warnings: warnings.length ? warnings : undefined
  });
  await emitView(envelope, parsed.options);
}

export async function runList(
  parsed: ParsedCommand,
  config: GenieConfig,
  paths: Required<ConfigPaths>
): Promise<void> {
  const [targetRaw] = parsed.commandArgs;

  if (!targetRaw) {
    await emitView(buildListHelpView(), parsed.options);
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

  await emitView(
    buildErrorView('Unknown list target', `Unknown list target '${targetRaw}'. Try 'agents' or 'sessions'.`),
    parsed.options,
    { stream: process.stderr }
  );
  process.exitCode = 1;
}

export async function emitAgentCatalog(parsed: ParsedCommand): Promise<void> {
  const agents = listAgents();
  interface ListedAgent {
    id: string;
    label: string;
    meta: any;
    folder: string | null;
  }
  const summarize = (entry: ListedAgent) => {
    const description = ((entry.meta?.description || entry.meta?.summary || '') as string).replace(/\s+/g, ' ').trim();
    return truncateText(description || '—', 96);
  };
  const grouped = new Map<string, ListedAgent[]>();
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

  const groups = orderedFolders.map((folder) => ({
    label: folder === '.' ? 'root' : folder,
    rows: grouped
      .get(folder)!
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((entry) => ({ id: entry.id, summary: summarize(entry) }))
  }));

  const envelope = buildAgentCatalogView({
    total: agents.length,
    groups
  });

  await emitView(envelope, parsed.options);
}
