export function buildErrorView(title: string, message: string): string {
  return `❌ **${title}**\n\n${message}`;
}

export function buildWarningView(title: string, messages: string[]): string {
  const body = messages.map(m => `- ${m}`).join('\n');
  return `⚠️ **${title}**\n\n${body}`;
}

export function buildInfoView(title: string, messages: string[]): string {
  const body = messages.map(m => `- ${m}`).join('\n');
  return `ℹ️ **${title}**\n\n${body}`;
}
