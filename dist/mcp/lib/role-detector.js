"use strict";
/**
 * Role Detection - Identifies which Genie agent type is running
 *
 * Architecture: Branch name pattern detection (forge/XXXX-{type}-description)
 * Used for: Read-only filesystem, spell loading, master orchestration
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectGenieRole = detectGenieRole;
exports.isReadOnlyFilesystem = isReadOnlyFilesystem;
exports.isMasterOrchestrator = isMasterOrchestrator;
exports.getWorkflowType = getWorkflowType;
const child_process_1 = require("child_process");
/**
 * Detect which Genie agent type is currently running
 *
 * Detection strategy:
 * 1. Check if CWD is in Forge worktree
 * 2. If yes, parse branch name for pattern: forge/XXXX-{type}-description
 * 3. Extract type (wish/forge/review) → return {type}-master
 * 4. If no match, return base-genie
 */
function detectGenieRole() {
    const cwd = process.cwd();
    const isForgeWorktree = cwd.includes('/worktrees/');
    // Not in worktree = base genie
    if (!isForgeWorktree) {
        return {
            role: 'base-genie',
            confidence: 'high',
            method: 'cwd-path',
            worktree: cwd
        };
    }
    // In worktree - detect role from branch name
    try {
        const branch = (0, child_process_1.execSync)('git branch --show-current', { encoding: 'utf-8' }).trim();
        // Pattern: forge/XXXX-{type}-description
        const match = branch.match(/^forge\/[0-9a-f]+-(\w+)-/);
        if (match) {
            const type = match[1]; // 'wish', 'forge', 'review'
            // Validate type
            if (['wish', 'forge', 'review'].includes(type)) {
                return {
                    role: `${type}-master`,
                    confidence: 'high',
                    method: 'branch-pattern',
                    branch,
                    worktree: cwd
                };
            }
        }
        // In worktree but pattern didn't match
        return {
            role: 'base-genie',
            confidence: 'medium',
            method: 'fallback',
            branch,
            worktree: cwd
        };
    }
    catch (error) {
        // Git command failed - likely not a git repo
        return {
            role: 'base-genie',
            confidence: 'low',
            method: 'fallback',
            worktree: cwd
        };
    }
}
/**
 * Check if current role has read-only filesystem
 * Wish and Review masters cannot modify files
 */
function isReadOnlyFilesystem(role) {
    return role === 'wish-master' || role === 'review-master';
}
/**
 * Check if current role is a master orchestrator
 */
function isMasterOrchestrator(role) {
    return role !== 'base-genie';
}
/**
 * Get workflow type from role
 * Returns null for base-genie
 */
function getWorkflowType(role) {
    if (role === 'base-genie')
        return null;
    return role.replace('-master', '');
}
