import { ViewEnvelope, ViewNode, ViewStyle } from '../view';

export interface RunRow {
  agent: string;
  status: string;
  sessionId: string | null;
  updated: string;
  updatedIso: string | null;
  log: string | null;
}

interface RunsViewParams {
  active: RunRow[];
  recent: RunRow[];
  warnings?: string[];
}

const GENIE_STYLE: ViewStyle = 'genie';

export function buildRunsOverviewView(params: RunsViewParams): ViewEnvelope {
  const { active, recent, warnings } = params;
  const badgeRow: ViewNode = {
    type: 'layout',
    direction: 'row',
    gap: 1,
    children: [
      { type: 'badge', text: `${active.length} active`, tone: active.length ? 'info' : 'muted' },
      { type: 'badge', text: `${recent.length} recent`, tone: recent.length ? 'info' : 'muted' }
    ]
  };
  return {
    style: GENIE_STYLE,
    title: 'Sessions',
    body: {
      type: 'layout',
      direction: 'column',
      gap: 0,
      children: [
        badgeRow,
        active.length > 0 ? simpleTable('Active', active) : null,
        recent.length > 0 ? simpleTable('Recent (last 10)', recent) : null,
        warnings && warnings.length
          ? {
              type: 'callout',
              tone: 'warning',
              icon: '⚠️',
              title: 'Warnings',
              body: warnings
            }
          : null,
        {
          type: 'callout',
          tone: 'info',
          icon: '💡',
          title: 'Commands',
          body: [
            'genie view <sessionId>',
            'genie resume <sessionId> "<prompt>"',
            'genie stop <sessionId>'
          ]
        }
      ].filter(Boolean) as ViewNode[]
    }
  };
}

function simpleTable(title: string, rows: RunRow[]): ViewNode {
  return {
    type: 'layout' as const,
    direction: 'column' as const,
    children: [
      { type: 'heading', level: 2, text: title, accent: 'secondary' },
      {
        type: 'table' as const,
        columns: [
          { key: 'agent', label: 'Agent', noTruncate: true },
          { key: 'status', label: 'Status', width: 10 },
          { key: 'sessionId', label: 'Session', width: 36, noTruncate: true },
          { key: 'updated', label: 'Updated', width: 8 }
        ],
        rows: rows.map((row) => ({
          agent: row.agent,
          status: decorateStatus(row.status),
          sessionId: row.sessionId ?? 'n/a',
          updated: row.updated || 'n/a'
        }))
      }
    ]
  };
}

function decorateStatus(status: string): string {
  return status;
}
