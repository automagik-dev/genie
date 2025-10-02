import { ViewEnvelope, ViewStyle, ViewNode, Tone } from '../view';

const GENIE_STYLE: ViewStyle = 'genie';

export interface BackgroundLoadingParams {
  agentName: string;
  frame?: string;
}

export interface BackgroundStartParams {
  agentName: string;
  sessionId?: string | null;
  executor?: string | null;
  mode?: string | null;
  background?: boolean | null;
  actions?: string[];
}

export interface RunCompletionParams {
  agentName: string;
  outcome: 'success' | 'warning' | 'failure';
  sessionId?: string | null;
  executorKey?: string;
  model?: string | null;
  permissionMode?: string | null;
  sandbox?: string | null;
  mode?: string | null;
  background?: boolean | null;
  exitCode?: number | null;
  durationMs?: number | null;
  extraNotes?: string[];
}

export function buildBackgroundStartingView(params: BackgroundLoadingParams): ViewEnvelope {
  const frame = params.frame ?? '⠋';
  return {
    style: GENIE_STYLE,
    body: {
      type: 'layout',
      direction: 'column',
      gap: 1,
      children: [
        { type: 'heading', level: 1, text: `${frame} Launching background run`, accent: 'primary' },
        {
          type: 'layout',
          direction: 'row',
          gap: 1,
          children: [
            { type: 'badge', text: `Agent ${params.agentName}`, tone: 'info' }
          ]
        },
        {
          type: 'callout',
          tone: 'info',
          icon: '🚀',
          title: 'Preparing workspace',
          body: [
            'Spawning detached runner for this agent.',
            'Session id will appear once the executor boots.'
          ]
        }
      ]
    }
  };
}

export function buildBackgroundPendingView(params: BackgroundLoadingParams): ViewEnvelope {
  const frame = params.frame ?? '⠙';
  return {
    style: GENIE_STYLE,
    body: {
      type: 'layout',
      direction: 'column',
      gap: 1,
      children: [
        { type: 'heading', level: 1, text: `${frame} Linking session id`, accent: 'primary' },
        {
          type: 'callout',
          tone: 'info',
          icon: '⏳',
          title: 'Hold tight',
          body: [
            'Waiting for the executor to publish the session id.',
            'You will see management commands as soon as it is ready.'
          ]
        }
      ]
    }
  };
}

export function buildBackgroundStartView(params: BackgroundStartParams): ViewEnvelope {
  const metaBadges = compact<ViewNode>([
    params.sessionId
      ? { type: 'badge', text: formatSessionBadge(params.sessionId), tone: 'success' }
      : { type: 'badge', text: 'Session pending', tone: 'muted' },
    params.mode ? { type: 'badge', text: `Mode ${params.mode}`, tone: 'info' } : null,
    params.executor ? { type: 'badge', text: `Executor ${params.executor}`, tone: 'info' } : null,
    params.background === false
      ? { type: 'badge', text: 'Attached', tone: 'warning' }
      : { type: 'badge', text: 'Detached', tone: 'info' }
  ]);

  const items: Array<{ label: string; value: string; tone?: Tone }> = compact([
    params.sessionId
      ? { label: 'Session', value: params.sessionId, tone: 'success' }
      : { label: 'Session', value: 'pending', tone: 'muted' },
    params.executor ? { label: 'Executor', value: params.executor } : null,
    params.mode ? { label: 'Execution mode', value: params.mode } : null,
    params.background === true
      ? { label: 'Background', value: 'detached' }
      : params.background === false
        ? { label: 'Background', value: 'attached', tone: 'warning' }
        : null
  ]);

  const actionsList = params.actions && params.actions.length
    ? {
        type: 'callout' as const,
        tone: 'info' as const,
        icon: '🧭',
        title: 'Next actions',
        body: params.actions
      }
    : null;

  return {
    style: GENIE_STYLE,
    body: {
      type: 'layout',
      direction: 'column',
      gap: 1,
      children: [
        { type: 'heading', level: 1, text: `▸ GENIE • ${params.agentName}`, accent: 'primary' },
        metaBadges.length
          ? {
              type: 'layout' as const,
              direction: 'row',
              gap: 1,
              children: metaBadges
            }
          : null,
        { type: 'divider', variant: 'solid', accent: 'muted' },
        {
          type: 'keyValue',
          columns: 1,
          items
        },
        actionsList
      ].filter(Boolean) as ViewNode[]
    }
  };
}

export function buildRunCompletionView(params: RunCompletionParams): ViewEnvelope {
  const tone = params.outcome === 'success' ? 'success' : params.outcome === 'warning' ? 'warning' : 'danger';
  const title =
    params.outcome === 'success'
      ? `${params.agentName} completed`
      : params.outcome === 'warning'
        ? `${params.agentName} completed with warnings`
        : `${params.agentName} failed`;

  const metaItems: Array<{ label: string; value: string; tone?: Tone }> = [];

  // Only show stats for attached mode (not background)
  if (params.background === false) {
    if (params.sessionId) {
      metaItems.push({ label: 'Resume', value: `./genie resume ${params.sessionId} "continue"` });
    }

    // Executor and model on same line
    const executorInfo: string[] = [];
    if (params.executorKey) executorInfo.push(params.executorKey);
    if (params.model) executorInfo.push(params.model);
    if (executorInfo.length) {
      metaItems.push({ label: 'Executor', value: executorInfo.join(' / ') });
    }

    // Executor-specific settings
    // Claude: show permission mode (if meaningful)
    // Codex: show sandbox + approval policy
    if (params.executorKey === 'codex') {
      if (params.sandbox) {
        metaItems.push({ label: 'Sandbox', value: params.sandbox });
      }
      // Could add approval-policy here if we pass it
    } else if (params.executorKey === 'claude') {
      // Skip permission mode if it's "default" (not meaningful)
      if (params.permissionMode && params.permissionMode !== 'default') {
        metaItems.push({ label: 'Permission', value: params.permissionMode });
      }
    }

    if (params.durationMs) {
      metaItems.push({ label: 'Runtime', value: `${(params.durationMs / 1000).toFixed(1)}s` });
    }
  }

  const notesCallout = params.extraNotes && params.extraNotes.length
    ? {
        type: 'callout' as const,
        tone,
        icon: tone === 'success' ? '✅' : tone === 'warning' ? '⚠️' : '❌',
        title: tone === 'success' ? 'Highlights' : 'Follow-ups',
        body: params.extraNotes
      }
    : null;

  return {
    style: GENIE_STYLE,
    title,
    body: {
      type: 'layout',
      direction: 'column',
      gap: 0,
      children: [
        metaItems.length ? {
          type: 'keyValue' as const,
          columns: 1,
          items: metaItems
        } : null,
        notesCallout
      ].filter(Boolean) as ViewNode[]
    }
  };
}

function compact<T>(items: Array<T | null | undefined>): T[] {
  return items.filter((item): item is T => Boolean(item));
}

function formatSessionBadge(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 10) return `Session ${trimmed}`;
  const head = trimmed.slice(0, 8);
  return `Session ${head}…`;
}

function formatOutcomeBadge(outcome: RunCompletionParams['outcome']): string {
  if (outcome === 'success') return 'Completed';
  if (outcome === 'warning') return 'Completed with warnings';
  return 'Failed';
}
