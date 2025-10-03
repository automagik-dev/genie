"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildChatView = buildChatView;
const GENIE_STYLE = 'genie';
function buildChatView(params) {
    const { agent, sessionId, status, messages, meta = [], showFull, hint } = params;
    const badgeCandidates = [
        sessionId ? badgeNode(`Session ${trimSession(sessionId)}`, 'success') : badgeNode('Session pending', 'muted'),
        status ? badgeNode(status, statusTone(status)) : null,
        ...meta.map((item) => badgeNode(`${item.label}: ${item.value}`, toBadgeTone(item.tone)))
    ];
    const badgeRow = {
        type: 'layout',
        direction: 'row',
        gap: 1,
        children: badgeCandidates.filter((node) => Boolean(node))
    };
    const metaKeyValue = {
        type: 'keyValue',
        columns: 1,
        items: compactMeta([
            { label: 'Session', value: sessionId ?? 'n/a', tone: sessionId ? 'success' : 'muted' },
            status ? { label: 'Status', value: status } : null,
            ...meta
        ])
    };
    const children = [
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
    }
    else {
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
function chatMessageNode(message) {
    const mapping = roleTheme(message.role);
    return {
        type: 'callout',
        tone: mapping.tone,
        icon: mapping.icon,
        title: message.title,
        body: message.body.length ? message.body : ['(empty output)']
    };
}
function roleTheme(role) {
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
function compactMeta(items) {
    return items.filter((item) => Boolean(item));
}
function trimSession(sessionId) {
    const trimmed = sessionId.trim();
    if (trimmed.length <= 10)
        return trimmed;
    return `${trimmed.slice(0, 8)}…`;
}
function statusTone(status) {
    const normalized = status.toLowerCase();
    if (normalized.startsWith('running'))
        return 'info';
    if (normalized.startsWith('completed'))
        return 'success';
    if (normalized.startsWith('failed'))
        return 'danger';
    if (normalized.startsWith('pending'))
        return 'warning';
    return 'muted';
}
function toBadgeTone(tone) {
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
function badgeNode(text, tone) {
    return { type: 'badge', text, tone };
}
