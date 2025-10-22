"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildErrorView = buildErrorView;
exports.buildWarningView = buildWarningView;
exports.buildInfoView = buildInfoView;
function buildErrorView(title, message) {
    return `❌ **${title}**\n\n${message}`;
}
function buildWarningView(title, messages) {
    const body = messages.map(m => `- ${m}`).join('\n');
    return `⚠️ **${title}**\n\n${body}`;
}
function buildInfoView(title, messages) {
    const body = messages.map(m => `- ${m}`).join('\n');
    return `ℹ️ **${title}**\n\n${body}`;
}
