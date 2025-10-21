"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTempBackupsRoot = exports.resolveProviderStatusPath = exports.resolveWorkspaceVersionPath = exports.resolveWorkspaceProviderPath = exports.resolveBackupsRoot = exports.resolveTargetStatePath = exports.resolveTargetGeniePath = exports.getTemplateRelativeBlacklist = exports.getTemplateRootPath = exports.getTemplateClaudePath = exports.getTemplateGeniePath = exports.getPackageRoot = exports.findWorkspaceRoot = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// Find workspace root by searching upward for .genie/ directory
// This locates the USER'S project root (where they run genie)
function findWorkspaceRoot() {
    let dir = process.cwd();
    while (dir !== path_1.default.dirname(dir)) {
        if (fs_1.default.existsSync(path_1.default.join(dir, '.genie'))) {
            return dir;
        }
        dir = path_1.default.dirname(dir);
    }
    // Fallback to cwd if .genie not found
    return process.cwd();
}
exports.findWorkspaceRoot = findWorkspaceRoot;
// Get Genie framework package root (where automagik-genie package.json lives)
// This is DIFFERENT from workspace root!
// Works in both dev mode and npm mode (npx automagik-genie)
function getPackageRoot() {
    // __dirname = .genie/cli/dist/lib/
    // ../../../../ = workspace root (dev) or package root (npm)
    return path_1.default.resolve(__dirname, '../../../..');
}
exports.getPackageRoot = getPackageRoot;
function getTemplateGeniePath(_template = 'code') {
    // Copy directly from framework's .genie/ directory
    // Template variants (code vs create) handled by install/update agents
    return path_1.default.join(getPackageRoot(), '.genie');
}
exports.getTemplateGeniePath = getTemplateGeniePath;
function getTemplateClaudePath(_template = 'code') {
    // .claude/ not used - Claude Code wraps core agents directly
    return path_1.default.join(getPackageRoot(), '.claude');
}
exports.getTemplateClaudePath = getTemplateClaudePath;
function getTemplateRootPath(_template = 'code') {
    // Root files (AGENTS.md, CLAUDE.md) copied from framework root
    return getPackageRoot();
}
exports.getTemplateRootPath = getTemplateRootPath;
function getTemplateRelativeBlacklist() {
    // Protect user work - these directories should NEVER be overwritten
    return new Set([
        'cli',
        'mcp',
        'backups',
        'wishes',
        'reports',
        'state' // User session state (preserve entirely)
    ]);
}
exports.getTemplateRelativeBlacklist = getTemplateRelativeBlacklist;
function resolveTargetGeniePath(cwd = process.cwd()) {
    return path_1.default.resolve(cwd, '.genie');
}
exports.resolveTargetGeniePath = resolveTargetGeniePath;
function resolveTargetStatePath(cwd = process.cwd()) {
    return path_1.default.join(resolveTargetGeniePath(cwd), 'state');
}
exports.resolveTargetStatePath = resolveTargetStatePath;
function resolveBackupsRoot(cwd = process.cwd()) {
    return path_1.default.join(resolveTargetGeniePath(cwd), 'backups');
}
exports.resolveBackupsRoot = resolveBackupsRoot;
function resolveWorkspaceProviderPath(cwd = process.cwd()) {
    return path_1.default.join(resolveTargetStatePath(cwd), 'provider.json');
}
exports.resolveWorkspaceProviderPath = resolveWorkspaceProviderPath;
function resolveWorkspaceVersionPath(cwd = process.cwd()) {
    return path_1.default.join(resolveTargetStatePath(cwd), 'version.json');
}
exports.resolveWorkspaceVersionPath = resolveWorkspaceVersionPath;
function resolveProviderStatusPath(cwd = process.cwd()) {
    return path_1.default.join(resolveTargetStatePath(cwd), 'provider-status.json');
}
exports.resolveProviderStatusPath = resolveProviderStatusPath;
function resolveTempBackupsRoot(cwd = process.cwd()) {
    return path_1.default.join(cwd, '.genie-backups-temp');
}
exports.resolveTempBackupsRoot = resolveTempBackupsRoot;
