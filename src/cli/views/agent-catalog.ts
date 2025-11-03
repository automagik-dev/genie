interface AgentCatalogRow {
  id: string;
  summary: string;
}

interface AgentCatalogGroup {
  label: string;
  rows: AgentCatalogRow[];
}

interface AgentCatalogParams {
  total: number;
  groups: AgentCatalogGroup[];
}

export function buildAgentCatalogView(params: AgentCatalogParams): string {
  const { total, groups } = params;

  const lines: string[] = [];

  // Header
  lines.push('# Agents');
  lines.push('');
  lines.push(`**${total} agents** · **${groups.length} folders**`);
  lines.push('');

  // Groups
  for (const group of groups) {
    lines.push(`## ${group.label} (${group.rows.length})`);
    lines.push('');

    if (group.rows.length === 0) {
      lines.push('*No agents found in this folder*');
      lines.push('');
      continue;
    }

    // Simple table format
    lines.push('| Identifier | Summary |');
    lines.push('|------------|---------|');
    for (const row of group.rows) {
      lines.push(`| ${row.id} | ${row.summary} |`);
    }
    lines.push('');
  }

  // Commands
  lines.push('💡 **Commands**');
  lines.push('```');
  lines.push('genie run <agent-id> "<prompt>"');
  lines.push('genie list sessions');
  lines.push('```');

  return lines.join('\n');
}
