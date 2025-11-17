"use strict";
/**
 * Project Detection Helper
 *
 * Automatically detects or creates Forge project for current workspace.
 * Matches forge-executor.ts logic (getOrCreateGenieProject).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOrCreateGenieProject = getOrCreateGenieProject;
const child_process_1 = require("child_process");
/**
 * Get the main repository path (handles worktrees correctly)
 *
 * When running inside a Forge worktree, process.cwd() returns the worktree path.
 * We need the main repo path to match against existing projects.
 *
 * @returns Main repository path
 */
function getMainRepoPath() {
    try {
        // Get list of worktrees (first one is always the main worktree)
        const worktreeList = (0, child_process_1.execSync)('git worktree list --porcelain', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'ignore']
        });
        // Parse the first worktree entry (main repo)
        const match = worktreeList.match(/^worktree (.+)$/m);
        if (match && match[1]) {
            return match[1];
        }
    }
    catch {
        // Fall back to current directory if git worktree list fails
        // (e.g., not a git repo, or git not available)
    }
    return process.cwd();
}
/**
 * Get or create Forge project for current workspace
 *
 * Detection logic:
 * 1. Normalize to main repository path (handles worktrees)
 * 2. Query all projects from Forge
 * 3. Find project where git_repo_path matches main repo path
 * 4. If no match, create new project with auto-detected name
 *
 * @param forgeClient - ForgeClient instance
 * @returns Project ID
 */
async function getOrCreateGenieProject(forgeClient) {
    const currentRepoPath = getMainRepoPath();
    const projects = await forgeClient.listProjects();
    // Find existing project by git repo path
    const existingProject = projects.find((p) => p.git_repo_path === currentRepoPath);
    if (existingProject) {
        return existingProject.id;
    }
    // Auto-detect project name from git repo or directory name
    let projectName = 'Genie Project';
    try {
        const remoteUrl = (0, child_process_1.execSync)('git config --get remote.origin.url', {
            encoding: 'utf8',
            cwd: currentRepoPath,
            stdio: ['pipe', 'pipe', 'ignore']
        }).trim();
        const match = remoteUrl.match(/\/([^\/]+?)(\.git)?$/);
        if (match && match[1]) {
            projectName = match[1].replace(/\.git$/, '');
        }
    }
    catch {
        try {
            const dirName = (0, child_process_1.execSync)('basename "$(pwd)"', {
                encoding: 'utf8',
                cwd: currentRepoPath,
                stdio: ['pipe', 'pipe', 'ignore']
            }).trim();
            if (dirName) {
                projectName = dirName;
            }
        }
        catch {
            // Keep default
        }
    }
    // Create new project
    const newProject = await forgeClient.createProject({
        name: projectName,
        git_repo_path: currentRepoPath,
        use_existing_repo: true
    });
    return newProject.id;
}
