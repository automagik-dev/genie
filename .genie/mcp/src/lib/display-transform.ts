/**
 * Display Path Transformation Utility
 *
 * Single source of truth for transforming agent paths for display.
 * Strips template/category folders while preserving parent/child relationships.
 *
 * Used by: MCP server (server.ts)
 *
 * NOTE: This is a copy of .genie/cli/src/lib/display-transform.ts
 * Both packages (CLI and MCP) are independent, so each maintains its own copy.
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
