"use strict";
/**
 * Display Path Transformation Utility
 *
 * Single source of truth for transforming agent paths for display.
 * Strips template/category folders while preserving parent/child relationships.
 *
 * Used by:
 * - CLI agent resolver (agent-resolver.ts)
 * - CLI handlers (shared.ts)
 * - MCP server (server.ts)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.transformDisplayPath = transformDisplayPath;
exports.getSemanticDisplayMessage = getSemanticDisplayMessage;
/**
 * Transforms agent paths for display by stripping template/category folders
 * while preserving parent/child workflow relationships.
 *
 * Template folders (code/, create/): Stripped entirely
 * Category folders (agents/, workflows/): Stripped for top-level, preserved for children
 *
 * @param normalizedId - Full agent path (e.g., "code/agents/implementor", "agents/git/issue")
 * @returns Transformed path for display
 *
 * @example
 * transformDisplayPath("code/agents/implementor") // { displayId: "implementor", displayFolder: null }
 * transformDisplayPath("agents/plan") // { displayId: "plan", displayFolder: null }
 * transformDisplayPath("code/agents/git/git") // { displayId: "git", displayFolder: null }
 * transformDisplayPath("code/agents/git/workflows/issue") // { displayId: "git/workflows/issue", displayFolder: "git" }
 */
function transformDisplayPath(normalizedId) {
    const parts = normalizedId.split('/');
    const templateFolders = ['code', 'create'];
    const categoryFolders = ['agents', 'workflows'];
    // Step 1: Strip template folder (code/, create/) if present
    let remaining = parts;
    if (templateFolders.includes(remaining[0])) {
        remaining = remaining.slice(1);
    }
    // Step 2: Strip category folder (agents/, workflows/) if present AFTER template
    if (categoryFolders.includes(remaining[0])) {
        if (remaining.length === 2) {
            // Top-level: agents/plan → plan
            return { displayId: remaining[1], displayFolder: null };
        }
        if (remaining.length === 3 && remaining[1] === remaining[2]) {
            // Parent: agents/git/git → git
            return { displayId: remaining[1], displayFolder: null };
        }
        // Child: agents/git/issue → git/issue
        const displayId = remaining.slice(1).join('/');
        const displayFolder = remaining[1];
        return { displayId, displayFolder };
    }
    // Already stripped template, no category folder (e.g., code/code.md → code)
    const displayId = remaining.join('/');
    const displayFolder = remaining.length > 1 ? remaining.slice(0, -1).join('/') : null;
    return { displayId, displayFolder };
}
/**
 * Generates a semantic display message for agent startup.
 *
 * Provides context-aware messages that indicate whether an agent is a template
 * orchestrator, universal agent, template-specific agent, or workflow.
 *
 * @param normalizedId - Full agent path (e.g., "code/code", "agents/plan", "code/agents/implementor")
 * @returns Semantic display message
 *
 * @example
 * getSemanticDisplayMessage("code/code") // "🧞 Starting code orchestrator"
 * getSemanticDisplayMessage("agents/plan") // "🧞 Starting agent: plan"
 * getSemanticDisplayMessage("code/agents/implementor") // "🧞 Starting code agent: implementor"
 * getSemanticDisplayMessage("code/agents/git/workflows/issue") // "🧞 Starting git workflow: issue"
 */
function getSemanticDisplayMessage(normalizedId) {
    const parts = normalizedId.split('/');
    if (parts.length === 2) {
        const [collective, agent] = parts;
        if (collective === 'code') {
            return `🧞 Starting code agent: ${agent}`;
        }
        if (collective === 'create') {
            return `🧞 Starting create agent: ${agent}`;
        }
        if (collective === 'genie') {
            return `🧞 Starting genie agent: ${agent}`;
        }
    }
    if (parts.length >= 3) {
        const [collective, scope, ...rest] = parts;
        const remainder = rest.join('/');
        if (collective === 'code') {
            if (scope === 'qa' && rest[0] === 'workflows') {
                return `🧞 Starting qa workflow: ${rest.slice(1).join('/')}`;
            }
            if (rest[0] === 'workflows') {
                return `🧞 Starting code workflow: ${rest.slice(1).join('/')}`;
            }
            return `🧞 Starting code agent: ${[scope, ...rest].join('/')}`;
        }
        if (collective === 'create') {
            if (rest[0] === 'workflows') {
                return `🧞 Starting create workflow: ${rest.slice(1).join('/')}`;
            }
            return `🧞 Starting create agent: ${[scope, ...rest].join('/')}`;
        }
    }
    // Template base orchestrators
    if (normalizedId === 'code/code') {
        return '🧞 Starting code orchestrator';
    }
    if (normalizedId === 'create/create') {
        return '🧞 Starting create orchestrator';
    }
    // Universal agents (agents/*)
    if (parts[0] === 'agents' && parts.length === 2) {
        return `🧞 Starting agent: ${parts[1]}`;
    }
    // Code template agents (code/agents/*)
    if (parts[0] === 'code' && parts[1] === 'agents') {
        if (parts.length === 3) {
            return `🧞 Starting code agent: ${parts[2]}`;
        }
        // Git workflows (code/agents/git/workflows/*)
        if (parts.length === 5 && parts[2] === 'git' && parts[3] === 'workflows') {
            return `🧞 Starting git workflow: ${parts[4]}`;
        }
        // Git agent parent (code/agents/git/git)
        if (parts.length === 4 && parts[2] === 'git' && parts[3] === 'git') {
            return '🧞 Starting code agent: git';
        }
    }
    // Create template agents (create/agents/*)
    if (parts[0] === 'create' && parts[1] === 'agents' && parts.length === 3) {
        return `🧞 Starting create agent: ${parts[2]}`;
    }
    // Universal agent workflows (agents/*/workflows/*)
    if (parts[0] === 'agents' && parts.length === 4 && parts[2] === 'workflows') {
        return `🧞 Starting ${parts[1]} workflow: ${parts[3]}`;
    }
    // Fallback to generic agent message
    const { displayId } = transformDisplayPath(normalizedId);
    return `🧞 Starting agent: ${displayId}`;
}
