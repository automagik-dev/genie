import { ViewEnvelope, ViewStyle, ViewNode, Tone } from '../view';

const GENIE_STYLE: ViewStyle = 'genie';

type ChatRole = 'assistant' | 'reasoning' | 'tool' | 'action';

export interface ChatMessage {
  role: ChatRole;
  title: string;
  body: string[];
}

export interface ChatViewParams {
  agent: string;
  sessionId: string | null;
  status?: string | null;
  messages: ChatMessage[];
  meta?: Array<{ label: string; value: string; tone?: Tone }>;
  showFull: boolean;
  hint?: string;
}

export function buildChatView(params: ChatViewParams): ViewEnvelope {
  const { agent, sessionId, status, messages, meta = [], showFull, hint } = params;
  const badgeCandidates: Array<ViewNode | null> = [
    sessionId ? badgeNode(`Session ${trimSession(sessionId)}`, 'success') : badgeNode('Session pending', 'muted'),
    status ? badgeNode(status, statusTone(status)) : null,
    ...meta.map((item) => badgeNode(`${item.label}: ${item.value}`, toBadgeTone(item.tone)))
  ];

  const badgeRow: ViewNode = {
    type: 'layout',
    direction: 'row',
    gap: 1,
    children: badgeCandidates.filter((node): node is ViewNode => Boolean(node))
  };

  const metaKeyValue = {
    type: 'keyValue' as const,
    columns: 1 as 1,
    items: compactMeta([
      { label: 'Session', value: sessionId ?? 'n/a', tone: sessionId ? 'success' : 'muted' },
      status ? { label: 'Status', value: status } : null,
      ...meta
    ])
  };

  const children: ViewNode[] = [
    { type: 'heading', level: 1, text: `Transcript • ${agent}`, accent: 'primary' },
    badgeRow,
    { type: 'divider', variant: 'solid', accent: 'muted' },
    metaKeyValue
  ];

  if (!messages.length) {
    children.push({
      type: 'callout',
      tone: 'info',
      title: 'No transcript yet',
      body: ['Agent has not produced chat output for this session.']
    });
  } else {
    children.push({ type: 'heading', level: 2, text: showFull ? 'Full conversation' : 'Latest output', accent: 'secondary' });
    children.push({ type: 'layout', direction: 'column', gap: 0, children: messages.map((message) => chatMessageNode(message)) });
    if (!showFull) {
      children.push({
        type: 'callout',
        tone: 'info',
        title: 'Tip',
        body: ['Run `genie view <sessionId> --full` to see the entire conversation.']
      });
    }
  }

  if (hint) {
    children.push({
      type: 'callout',
      tone: 'info',
      title: 'Hint',
      body: [hint]
    });
  }

  return {
    style: GENIE_STYLE,
    title: `${agent} transcript`,
    body: {
      type: 'layout',
      direction: 'column',
      gap: 0,
      children
    }
  };
}

function chatMessageNode(message: ChatMessage): ViewNode {
  const mapping = roleTheme(message.role);
  return {
    type: 'callout',
    tone: mapping.tone,
    icon: mapping.icon,
    title: message.title,
    body: message.body.length ? message.body : ['(empty output)']
  };
}

function roleTheme(role: ChatRole): { tone: 'info' | 'success' | 'warning' | 'danger'; icon: string } {
  switch (role) {
    case 'assistant':
      return { tone: 'success', icon: '🤖' };
    case 'reasoning':
      return { tone: 'info', icon: '🧠' };
    case 'tool':
      return { tone: 'warning', icon: '🛠️' };
    case 'action':
    default:
      return { tone: 'danger', icon: '⚙️' };
  }
}

function compactMeta(items: Array<{ label: string; value: string; tone?: Tone } | null>): Array<{ label: string; value: string; tone?: Tone }> {
  return items.filter((item): item is { label: string; value: string; tone?: Tone } => Boolean(item));
}

function trimSession(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 8)}…`;
}

function statusTone(status: string): 'info' | 'success' | 'warning' | 'danger' | 'muted' {
  const normalized = status.toLowerCase();
  if (normalized.startsWith('running')) return 'info';
  if (normalized.startsWith('completed')) return 'success';
  if (normalized.startsWith('failed')) return 'danger';
  if (normalized.startsWith('pending')) return 'warning';
  return 'muted';
}

function toBadgeTone(tone?: Tone): 'info' | 'success' | 'warning' | 'danger' | 'muted' {
  switch (tone) {
    case 'success':
      return 'success';
    case 'warning':
      return 'warning';
    case 'danger':
      return 'danger';
    case 'muted':
      return 'muted';
    default:
      return 'info';
  }
}

function badgeNode(text: string, tone: 'info' | 'success' | 'warning' | 'danger' | 'muted'): ViewNode {
  return { type: 'badge', text, tone };
}
