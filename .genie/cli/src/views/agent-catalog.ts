import { ViewEnvelope, ViewStyle, ViewNode } from '../view';

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

const GENIE_STYLE: ViewStyle = 'genie';

export function buildAgentCatalogView(params: AgentCatalogParams): ViewEnvelope {
  const { total, groups } = params;
  const badgeRow: ViewNode = {
    type: 'layout',
    direction: 'row',
    gap: 1,
    children: [
      { type: 'badge', text: `${total} agents`, tone: 'info' },
      { type: 'badge', text: `${groups.length} folders`, tone: 'muted' }
    ]
  };

  // Calculate responsive column widths across all groups
  const allRows = groups.flatMap(g => g.rows);
  const maxIdLength = Math.max(...allRows.map(r => r.id.length), 10);

  // Use just enough width for the longest identifier, with small padding
  const idWidth = maxIdLength + 1;

  return {
    style: GENIE_STYLE,
    title: 'Agents',
    body: {
      type: 'layout',
      direction: 'column',
      gap: 0,
      children: [
        badgeRow,
        ...groups.map(group => buildGroupSection(group, idWidth)) as ViewNode[],
        {
          type: 'callout',
          tone: 'info',
          icon: '💡',
          title: 'Commands',
          body: [
            'genie run <agent-id> "<prompt>"',
            'genie list sessions'
          ]
        }
      ] as ViewNode[]
    }
  };
}

function buildGroupSection(group: AgentCatalogGroup, idWidth: number): ViewNode {
  return {
    type: 'layout',
    direction: 'column',
    gap: 0,
    children: [
      { type: 'heading', level: 2, text: `${group.label} (${group.rows.length})`, accent: 'secondary' },
      {
        type: 'table',
        columns: [
          { key: 'id', label: 'Identifier', width: idWidth, noTruncate: true },
          { key: 'summary', label: 'Summary' }
        ],
        rows: group.rows.map((row) => ({
          id: row.id,
          summary: row.summary
        })),
        emptyText: 'No agents found in this folder'
      }
    ]
  };
}
