/**
 * Create command - Simple bd create wrapper
 *
 * Usage:
 *   term create "Task title"                    - Create beads issue
 *   term create "Task title" -d "Description"   - With description
 *   term create "Task title" -p bd-1            - With parent/dependency
 *
 * Options:
 *   -d, --description <text>  - Issue description
 *   -p, --parent <id>         - Parent issue ID (creates dependency)
 *   --json                    - Output as JSON
 */

import { $ } from 'bun';

export interface CreateOptions {
  description?: string;
  parent?: string;
  json?: boolean;
}

/**
 * Run bd command and return result
 */
async function runBd(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await $`bd ${args}`.quiet();
    return { stdout: result.stdout.toString().trim(), exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString().trim() || error.message,
      exitCode: error.exitCode || 1
    };
  }
}

export async function createCommand(
  title: string,
  options: CreateOptions = {}
): Promise<void> {
  // Build bd create command
  const args = ['create', title];

  if (options.description) {
    args.push('--description', options.description);
  }

  // Run bd create
  const { stdout, exitCode } = await runBd(args);

  if (exitCode !== 0) {
    console.error(`Failed to create issue: ${stdout}`);
    process.exit(1);
  }

  // Extract issue ID from output
  // bd create typically outputs something like "Created bd-123" or just the ID
  const idMatch = stdout.match(/bd-\d+/);
  const issueId = idMatch ? idMatch[0] : null;

  if (!issueId) {
    console.log(stdout);
    return;
  }

  // If parent specified, add blockedBy relationship
  if (options.parent) {
    const { exitCode: updateExit } = await runBd([
      'update',
      issueId,
      '--blocked-by',
      options.parent,
    ]);

    if (updateExit !== 0) {
      console.log(`Created ${issueId} (failed to set parent dependency)`);
    }
  }

  if (options.json) {
    // Fetch full issue details
    const { stdout: showOutput } = await runBd(['show', issueId, '--json']);
    console.log(showOutput);
  } else {
    console.log(`Created: ${issueId} - "${title}"`);
    if (options.parent) {
      console.log(`   Blocked by: ${options.parent}`);
    }
    console.log(`\nNext steps:`);
    console.log(`   term work ${issueId}           - Start working on it`);
    console.log(`   term spawn genie:wish -t ${issueId}  - Plan with wish skill`);
    console.log(`   bd show ${issueId}             - View details`);
  }
}
