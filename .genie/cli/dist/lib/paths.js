"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPackageRoot = getPackageRoot;
exports.getTemplateGeniePath = getTemplateGeniePath;
exports.getTemplateClaudePath = getTemplateClaudePath;
exports.getTemplateRootPath = getTemplateRootPath;
exports.getTemplateRelativeBlacklist = getTemplateRelativeBlacklist;
exports.resolveTargetGeniePath = resolveTargetGeniePath;
exports.resolveTargetStatePath = resolveTargetStatePath;
exports.resolveBackupsRoot = resolveBackupsRoot;
exports.resolveWorkspaceProviderPath = resolveWorkspaceProviderPath;
exports.resolveWorkspaceVersionPath = resolveWorkspaceVersionPath;
exports.resolveProviderStatusPath = resolveProviderStatusPath;
exports.resolveTempBackupsRoot = resolveTempBackupsRoot;
const path_1 = __importDefault(require("path"));
function getPackageRoot() {
    return path_1.default.resolve(__dirname, '../../../..');
}
function getTemplateGeniePath(template = 'code') {
    // templates/code/.genie/ - Software development template
    // templates/create/.genie/ - Adaptive learning template
    return path_1.default.join(getPackageRoot(), 'templates', template, '.genie');
}
function getTemplateClaudePath(template = 'code') {
    return path_1.default.join(getPackageRoot(), 'templates', template, '.claude');
}
function getTemplateRootPath(template = 'code') {
    return path_1.default.join(getPackageRoot(), 'templates', template);
}
function getTemplateRelativeBlacklist() {
    // Protect user work - these directories should NEVER be overwritten
    return new Set([
        'cli', // Framework CLI code
        'mcp', // Framework MCP code
        'backups', // User backups
        'agents', // User custom agents (preserve entirely)
        'wishes', // User wishes (preserve entirely)
        'reports', // User reports (preserve entirely)
        'state' // User session state (preserve entirely)
    ]);
}
function resolveTargetGeniePath(cwd = process.cwd()) {
    return path_1.default.resolve(cwd, '.genie');
}
function resolveTargetStatePath(cwd = process.cwd()) {
    return path_1.default.join(resolveTargetGeniePath(cwd), 'state');
}
function resolveBackupsRoot(cwd = process.cwd()) {
    return path_1.default.join(resolveTargetGeniePath(cwd), 'backups');
}
function resolveWorkspaceProviderPath(cwd = process.cwd()) {
    return path_1.default.join(resolveTargetStatePath(cwd), 'provider.json');
}
function resolveWorkspaceVersionPath(cwd = process.cwd()) {
    return path_1.default.join(resolveTargetStatePath(cwd), 'version.json');
}
function resolveProviderStatusPath(cwd = process.cwd()) {
    return path_1.default.join(resolveTargetStatePath(cwd), 'provider-status.json');
}
function resolveTempBackupsRoot(cwd = process.cwd()) {
    return path_1.default.join(cwd, '.genie-backups-temp');
}
