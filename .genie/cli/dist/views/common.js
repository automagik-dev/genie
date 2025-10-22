export function buildErrorView(title, message) {
    return `❌ **${title}**\n\n${message}`;
}
export function buildWarningView(title, messages) {
    const body = messages.map(m => `- ${m}`).join('\n');
    return `⚠️ **${title}**\n\n${body}`;
}
export function buildInfoView(title, messages) {
    const body = messages.map(m => `- ${m}`).join('\n');
    return `ℹ️ **${title}**\n\n${body}`;
}
