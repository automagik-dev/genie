"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.palette = void 0;
exports.toneToColor = toneToColor;
exports.accentToColor = accentToColor;
exports.palette = {
    accent: {
        primary: '#8B5CF6',
        secondary: '#14B8A6',
        warning: '#F97316',
        danger: '#F43F5E',
        muted: '#94A3B8'
    },
    foreground: {
        default: '#E2E8F0',
        muted: '#CBD5F5',
        placeholder: '#64748B'
    },
    background: {
        panel: '#111827'
    }
};
function toneToColor(tone) {
    switch (tone) {
        case 'default':
            return exports.palette.foreground.default;
        case 'muted':
            return exports.palette.foreground.muted;
        case 'success':
            return exports.palette.accent.secondary;
        case 'warning':
            return exports.palette.accent.warning;
        case 'danger':
            return exports.palette.accent.danger;
        case 'info':
            return exports.palette.accent.primary;
        default:
            return undefined;
    }
}
function accentToColor(accent) {
    if (!accent)
        return exports.palette.foreground.default;
    if (accent === 'primary')
        return exports.palette.accent.primary;
    if (accent === 'secondary')
        return exports.palette.accent.secondary;
    if (accent === 'muted')
        return exports.palette.accent.muted;
    return exports.palette.foreground.default;
}
