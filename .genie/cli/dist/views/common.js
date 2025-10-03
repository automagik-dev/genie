"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildErrorView = buildErrorView;
exports.buildWarningView = buildWarningView;
exports.buildInfoView = buildInfoView;
const GENIE_STYLE = 'genie';
function buildErrorView(title, message) {
    return {
        style: GENIE_STYLE,
        title,
        body: {
            type: 'callout',
            tone: 'danger',
            icon: '❌',
            title,
            body: [message]
        }
    };
}
function buildWarningView(title, messages) {
    return {
        style: GENIE_STYLE,
        title,
        body: {
            type: 'callout',
            tone: 'warning',
            icon: '⚠️',
            title,
            body: messages
        }
    };
}
function buildInfoView(title, messages) {
    return {
        style: GENIE_STYLE,
        title,
        body: {
            type: 'callout',
            tone: 'info',
            icon: 'ℹ️',
            title,
            body: messages
        }
    };
}
