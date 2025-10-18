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

export interface TransformResult {
  displayId: string;
  displayFolder: string | null;
}

/**
 * Transforms agent paths for display by stripping template/category folders
 * while preserving parent/child workflow relationships.
 *
 * Template folders (code/, create/): Stripped entirely
 * Category folders (neurons/, workflows/): Stripped for top-level, preserved for children
 *
 * @param normalizedId - Full agent path (e.g., "code/neurons/implementor", "neurons/git/issue")
 * @returns Transformed path for display
 *
 * @example
 * transformDisplayPath("code/neurons/implementor") // { displayId: "implementor", displayFolder: null }
 * transformDisplayPath("neurons/plan") // { displayId: "plan", displayFolder: null }
 * transformDisplayPath("code/neurons/git/git") // { displayId: "git", displayFolder: null }
 * transformDisplayPath("code/neurons/git/workflows/issue") // { displayId: "git/workflows/issue", displayFolder: "git" }
 */
export function transformDisplayPath(normalizedId: string): TransformResult {
  const parts = normalizedId.split('/');
  const templateFolders = ['code', 'create'];
  const categoryFolders = ['neurons', 'workflows'];

  // Step 1: Strip template folder (code/, create/) if present
  let remaining = parts;
  if (templateFolders.includes(remaining[0])) {
    remaining = remaining.slice(1);
  }

  // Step 2: Strip category folder (neurons/, workflows/) if present AFTER template
  if (categoryFolders.includes(remaining[0])) {
    if (remaining.length === 2) {
      // Top-level: neurons/plan → plan
      return { displayId: remaining[1], displayFolder: null };
    }
    if (remaining.length === 3 && remaining[1] === remaining[2]) {
      // Parent: neurons/git/git → git
      return { displayId: remaining[1], displayFolder: null };
    }
    // Child: neurons/git/issue → git/issue
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
 * orchestrator, universal neuron, template-specific neuron, or workflow.
 *
 * @param normalizedId - Full agent path (e.g., "code/code", "neurons/plan", "code/neurons/implementor")
 * @returns Semantic display message
 *
 * @example
 * getSemanticDisplayMessage("code/code") // "🧞 Starting code orchestrator"
 * getSemanticDisplayMessage("neurons/plan") // "🧞 Starting neuron: plan"
 * getSemanticDisplayMessage("code/neurons/implementor") // "🧞 Starting code neuron: implementor"
 * getSemanticDisplayMessage("code/neurons/git/workflows/issue") // "🧞 Starting git workflow: issue"
 */
export function getSemanticDisplayMessage(normalizedId: string): string {
  const parts = normalizedId.split('/');

  // Template base orchestrators
  if (normalizedId === 'code/code') {
    return '🧞 Starting code orchestrator';
  }
  if (normalizedId === 'create/create') {
    return '🧞 Starting create orchestrator';
  }

  // Universal neurons (neurons/*)
  if (parts[0] === 'neurons' && parts.length === 2) {
    return `🧞 Starting neuron: ${parts[1]}`;
  }

  // Code template neurons (code/neurons/*)
  if (parts[0] === 'code' && parts[1] === 'neurons') {
    if (parts.length === 3) {
      return `🧞 Starting code neuron: ${parts[2]}`;
    }
    // Git workflows (code/neurons/git/workflows/*)
    if (parts.length === 5 && parts[2] === 'git' && parts[3] === 'workflows') {
      return `🧞 Starting git workflow: ${parts[4]}`;
    }
    // Git neuron parent (code/neurons/git/git)
    if (parts.length === 4 && parts[2] === 'git' && parts[3] === 'git') {
      return '🧞 Starting code neuron: git';
    }
  }

  // Create template neurons (create/neurons/*)
  if (parts[0] === 'create' && parts[1] === 'neurons' && parts.length === 3) {
    return `🧞 Starting create neuron: ${parts[2]}`;
  }

  // Universal neuron workflows (neurons/*/workflows/*)
  if (parts[0] === 'neurons' && parts.length === 4 && parts[2] === 'workflows') {
    return `🧞 Starting ${parts[1]} workflow: ${parts[3]}`;
  }

  // Fallback to generic agent message
  const { displayId } = transformDisplayPath(normalizedId);
  return `🧞 Starting agent: ${displayId}`;
}
