"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildInfoView = exports.buildWarningView = exports.buildErrorView = void 0;
function buildErrorView(title, message) {
    return `❌ **${title}**\n\n${message}`;
}
exports.buildErrorView = buildErrorView;
function buildWarningView(title, messages) {
    const body = messages.map(m => `- ${m}`).join('\n');
    return `⚠️ **${title}**\n\n${body}`;
}
exports.buildWarningView = buildWarningView;
function buildInfoView(title, messages) {
    const body = messages.map(m => `- ${m}`).join('\n');
    return `ℹ️ **${title}**\n\n${body}`;
}
exports.buildInfoView = buildInfoView;
