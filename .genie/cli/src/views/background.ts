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

export function buildBackgroundStartingView(params: BackgroundLoadingParams): string {
  const frame = params.frame ?? '⠋';
  return `${frame} **Launching background run**

**Agent ${params.agentName}**

🚀 **Preparing workspace**
- Spawning detached runner for this agent.
- Session id will appear once the executor boots.`;
}

export function buildBackgroundPendingView(params: BackgroundLoadingParams): string {
  const frame = params.frame ?? '⠙';
  return `${frame} **Linking session id**

⏳ **Hold tight**
- Waiting for the executor to publish the session id.
- You will see management commands as soon as it is ready.`;
}

export function buildBackgroundStartView(params: BackgroundStartParams): string {
  const lines: string[] = [];

  lines.push(`# ▸ GENIE • ${params.agentName}`);
  lines.push('');

  // Badges
  const badges: string[] = [];
  if (params.sessionId) {
    badges.push(formatSessionBadge(params.sessionId));
  } else {
    badges.push('Session pending');
  }
  if (params.mode) badges.push(`Mode ${params.mode}`);
  if (params.executor) badges.push(`Executor ${params.executor}`);
  badges.push(params.background === false ? 'Attached' : 'Detached');
  lines.push(badges.map(b => `**${b}**`).join(' · '));
  lines.push('');

  // Key-value pairs
  if (params.sessionId) {
    lines.push(`**Session:** ${params.sessionId}`);
  } else {
    lines.push(`**Session:** pending`);
  }
  if (params.executor) {
    lines.push(`**Executor:** ${params.executor}`);
  }
  if (params.mode) {
    lines.push(`**Execution mode:** ${params.mode}`);
  }
  if (params.background === true) {
    lines.push(`**Background:** detached`);
  } else if (params.background === false) {
    lines.push(`**Background:** attached`);
  }

  // Actions
  if (params.actions && params.actions.length > 0) {
    lines.push('');
    lines.push('🧭 **Next actions**');
    for (const action of params.actions) {
      lines.push(`- ${action}`);
    }
  }

  return lines.join('\n');
}

export function buildRunCompletionView(params: RunCompletionParams): string {
  const icon = params.outcome === 'success' ? '✅' : params.outcome === 'warning' ? '⚠️' : '❌';
  const title =
    params.outcome === 'success'
      ? `${params.agentName} completed`
      : params.outcome === 'warning'
        ? `${params.agentName} completed with warnings`
        : `${params.agentName} failed`;

  const lines: string[] = [];
  lines.push(`${icon} **${title}**`);
  lines.push('');

  // Only show stats for attached mode (not background)
  if (params.background === false) {
    if (params.sessionId) {
      lines.push(`**Resume:** ./genie resume ${params.sessionId} "continue"`);
    }

    // Executor and model on same line
    const executorInfo: string[] = [];
    if (params.executorKey) executorInfo.push(params.executorKey);
    if (params.model) executorInfo.push(params.model);
    if (executorInfo.length) {
      lines.push(`**Executor:** ${executorInfo.join(' / ')}`);
    }

    // Executor-specific settings
    if (params.executorKey === 'codex') {
      if (params.sandbox) {
        lines.push(`**Sandbox:** ${params.sandbox}`);
      }
    } else if (params.executorKey === 'claude') {
      // Skip permission mode if it's "default" (not meaningful)
      if (params.permissionMode && params.permissionMode !== 'default') {
        lines.push(`**Permission:** ${params.permissionMode}`);
      }
    }

    if (params.durationMs) {
      lines.push(`**Runtime:** ${(params.durationMs / 1000).toFixed(1)}s`);
    }
  }

  // Extra notes
  if (params.extraNotes && params.extraNotes.length > 0) {
    lines.push('');
    const notesTitle = params.outcome === 'success' ? 'Highlights' : 'Follow-ups';
    lines.push(`${icon} **${notesTitle}**`);
    for (const note of params.extraNotes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join('\n');
}

function formatSessionBadge(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 10) return `Session ${trimmed}`;
  const head = trimmed.slice(0, 8);
  return `Session ${head}…`;
}
