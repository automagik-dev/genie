/**
 * Push command - Push current branch to remote with branch protection
 *
 * Usage:
 *   term push              - Push current branch to remote
 *
 * Options:
 *   -u, --set-upstream     - Set upstream for new branches (default: true)
 *   -f, --force            - Force push (with lease for safety)
 */

import { $ } from 'bun';
import { getCurrentBranch, assertNotMainBranch } from './ship.js';

// ============================================================================
// Types
// ============================================================================

export interface PushOptions {
  setUpstream?: boolean;
  force?: boolean;
}

// ============================================================================
// Main Command
// ============================================================================

export async function pushCommand(
  options: PushOptions = {}
): Promise<void> {
  try {
    const repoPath = process.cwd();

    // Branch protection: refuse to push from main/master
    await assertNotMainBranch(repoPath);

    // Get current branch
    const branch = await getCurrentBranch(repoPath);
    console.log(`🚀 Pushing branch: ${branch}`);

    // Check if branch has upstream set
    let hasUpstream = false;
    try {
      await $`git -C ${repoPath} rev-parse --abbrev-ref ${branch}@{upstream}`.quiet();
      hasUpstream = true;
    } catch {
      // No upstream set
    }

    // Build push command
    const pushArgs = ['push'];

    if (options.force) {
      // Use --force-with-lease for safer force pushes
      pushArgs.push('--force-with-lease');
      console.log('   Using force-with-lease for safety');
    }

    if (!hasUpstream && options.setUpstream !== false) {
      pushArgs.push('-u', 'origin', branch);
      console.log('   Setting upstream to origin/' + branch);
    }

    // Execute push
    const result = await $`git -C ${repoPath} ${pushArgs}`.quiet();
    const output = result.stdout.toString().trim() || result.stderr.toString().trim();

    if (output) {
      console.log(`   ${output}`);
    }

    console.log(`\n✅ Pushed ${branch} to remote`);

  } catch (error: any) {
    console.error(`❌ Push failed: ${error.message}`);
    process.exit(1);
  }
}
