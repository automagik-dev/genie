/**
 * Spawn command - Spawn Claude with a skill loaded
 *
 * Usage:
 *   term spawn              - Interactive skill picker
 *   term spawn <skill>      - Spawn Claude with skill loaded
 *   term spawn wish         - Start wish brainstorming
 *   term spawn forge        - Execute approved wish
 *
 * Options:
 *   -s, --session <name>        - Target tmux session
 *   --no-worktree               - Skip worktree creation (when taskId provided)
 *   --focus                     - Focus the new pane (default: true)
 *   -p, --prompt <message>      - Additional context for the skill
 *   -t, --task-id <id>          - Bind to beads issue
 */

import { $ } from 'bun';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { search } from '@inquirer/prompts';
import * as tmux from '../lib/tmux.js';
import * as registry from '../lib/worker-registry.js';
import * as beadsRegistry from '../lib/beads-registry.js';
import * as skillLoader from '../lib/skill-loader.js';

// Use beads registry when enabled
const useBeads = beadsRegistry.isBeadsRegistryEnabled();

// Worktrees are created inside the project at .genie/worktrees/<taskId>
const WORKTREE_DIR_NAME = '.genie/worktrees';

// ============================================================================
// Types
// ============================================================================

export interface SpawnOptions {
  session?: string;
  noWorktree?: boolean;
  focus?: boolean;
  prompt?: string;
  taskId?: string;
}

// ============================================================================
// Skill Picker
// ============================================================================

/**
 * Interactive skill picker using fuzzy search
 */
async function pickSkill(projectRoot?: string): Promise<skillLoader.SkillInfo | null> {
  const skills = await skillLoader.listSkills(projectRoot);

  if (skills.length === 0) {
    console.log('No skills found in .claude/skills/ or ~/.claude/skills/');
    return null;
  }

  // Build skill options with descriptions
  const skillInfos: Array<{ name: string; info: skillLoader.SkillInfo }> = [];
  for (const name of skills) {
    const info = await skillLoader.findSkill(name, projectRoot);
    if (info) {
      skillInfos.push({ name, info });
    }
  }

  const selected = await search({
    message: 'Select skill:',
    source: async (term) => {
      const searchTerm = (term || '').toLowerCase();
      return skillInfos
        .filter(s =>
          s.name.toLowerCase().includes(searchTerm) ||
          (s.info.description?.toLowerCase().includes(searchTerm) ?? false)
        )
        .map(s => ({
          name: s.info.description
            ? `${s.name} - ${s.info.description.substring(0, 60)}${s.info.description.length > 60 ? '...' : ''}`
            : s.name,
          value: s.info,
        }));
    },
  });

  return selected;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Run bd command and parse output
 */
async function runBd(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await $`bd ${args}`.quiet();
    return { stdout: result.stdout.toString().trim(), exitCode: 0 };
  } catch (error: any) {
    return { stdout: error.stdout?.toString().trim() || '', exitCode: error.exitCode || 1 };
  }
}

/**
 * Get a beads issue by ID
 */
async function getBeadsIssue(id: string): Promise<{ id: string; title: string; description?: string } | null> {
  const { stdout, exitCode } = await runBd(['show', id, '--json']);
  if (exitCode !== 0 || !stdout) return null;

  try {
    const parsed = JSON.parse(stdout);
    const issue = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!issue) return null;
    return {
      id: issue.id,
      title: issue.title || issue.description?.substring(0, 50) || 'Untitled',
      description: issue.description,
    };
  } catch {
    return null;
  }
}

/**
 * Get current tmux session name
 */
async function getCurrentSession(): Promise<string | null> {
  try {
    const result = await tmux.executeTmux(`display-message -p '#{session_name}'`);
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Create worktree for task
 */
async function createWorktree(taskId: string, repoPath: string): Promise<string | null> {
  const fs = await import('fs/promises');
  const worktreeDir = join(repoPath, WORKTREE_DIR_NAME);
  const worktreePath = join(worktreeDir, taskId);

  try {
    await fs.mkdir(worktreeDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  try {
    const stat = await fs.stat(worktreePath);
    if (stat.isDirectory()) {
      console.log(`   Worktree for ${taskId} already exists`);
      return worktreePath;
    }
  } catch {
    // Doesn't exist, will create
  }

  const branchName = `work/${taskId}`;
  try {
    try {
      await $`git -C ${repoPath} branch ${branchName}`.quiet();
    } catch {
      // Branch may already exist
    }

    await $`git -C ${repoPath} worktree add ${worktreePath} ${branchName}`.quiet();

    // Set up .genie redirect so bd commands work in the worktree
    const genieRedirect = join(worktreePath, '.genie');
    await fs.mkdir(genieRedirect, { recursive: true });
    await fs.writeFile(join(genieRedirect, 'redirect'), join(repoPath, '.genie'));

    return worktreePath;
  } catch (error: any) {
    console.error(`   Failed to create worktree: ${error.message}`);
    return null;
  }
}

/**
 * Spawn Claude worker in new pane (splits the CURRENT active pane)
 */
async function spawnWorkerPane(
  session: string,
  workingDir: string
): Promise<{ paneId: string } | null> {
  try {
    const sessionObj = await tmux.findSessionByName(session);
    if (!sessionObj) {
      console.error(`Session "${session}" not found`);
      return null;
    }

    const windows = await tmux.listWindows(sessionObj.id);
    if (!windows || windows.length === 0) {
      console.error(`No windows in session "${session}"`);
      return null;
    }

    const activeWindow = windows.find(w => w.active) || windows[0];
    const panes = await tmux.listPanes(activeWindow.id);
    if (!panes || panes.length === 0) {
      console.error(`No panes in window "${activeWindow.name}"`);
      return null;
    }

    const activePane = panes.find(p => p.active) || panes[0];

    const newPane = await tmux.splitPane(
      activePane.id,
      'horizontal',
      50,
      workingDir
    );

    if (!newPane) {
      console.error(`Failed to create new pane`);
      return null;
    }

    return { paneId: newPane.id };
  } catch (error: any) {
    console.error(`Error spawning worker pane: ${error.message}`);
    return null;
  }
}

// ============================================================================
// Main Command
// ============================================================================

export async function spawnCommand(
  skillName: string | undefined,
  options: SpawnOptions = {}
): Promise<void> {
  const repoPath = process.cwd();

  // 1. Get skill (via picker or direct lookup)
  let skill: skillLoader.SkillInfo | null;

  if (!skillName) {
    // Interactive picker
    skill = await pickSkill(repoPath);
    if (!skill) {
      process.exit(1);
    }
  } else {
    // Direct lookup
    skill = await skillLoader.findSkill(skillName, repoPath);

    if (!skill) {
      // List available skills as help
      const available = await skillLoader.listSkills(repoPath);
      console.error(`Skill "${skillName}" not found.`);
      if (available.length > 0) {
        console.log('\nAvailable skills:');
        for (const s of available) {
          console.log(`  - ${s}`);
        }
      } else {
        console.log('\nNo skills found in .claude/skills/ or ~/.claude/skills/');
      }
      process.exit(1);
    }
  }

  console.log(`Skill: ${skill.name}`);
  if (skill.description) {
    console.log(`   ${skill.description}`);
  }

  // 2. Get session
  const session = options.session || await getCurrentSession();
  if (!session) {
    console.error('Not in a tmux session. Attach to a session first or use --session.');
    process.exit(1);
  }

  // 3. Handle taskId binding (optional)
  let workingDir = repoPath;
  let worktreePath: string | null = null;
  let issue: { id: string; title: string; description?: string } | null = null;

  if (options.taskId) {
    // Verify issue exists
    issue = await getBeadsIssue(options.taskId);
    if (!issue) {
      console.error(`Issue "${options.taskId}" not found. Run \`bd list\` to see issues.`);
      process.exit(1);
    }

    // Check not already assigned
    const existingWorker = useBeads
      ? await beadsRegistry.findByTask(options.taskId)
      : await registry.findByTask(options.taskId);

    if (existingWorker) {
      console.error(`${options.taskId} already has a worker (pane ${existingWorker.paneId})`);
      console.log(`   Run \`term kill ${existingWorker.id}\` first.`);
      process.exit(1);
    }

    // Create worktree if not disabled
    if (!options.noWorktree) {
      console.log(`Creating worktree for ${options.taskId}...`);
      worktreePath = await createWorktree(options.taskId, repoPath);
      if (worktreePath) {
        workingDir = worktreePath;
        console.log(`   Created: ${worktreePath}`);
      }
    }
  }

  // 4. Spawn Claude pane
  console.log(`Spawning Claude pane...`);
  const paneResult = await spawnWorkerPane(session, workingDir);
  if (!paneResult) {
    process.exit(1);
  }

  const { paneId } = paneResult;

  // 5. Build prompt with skill
  let prompt = skillLoader.buildSkillPrompt(skill, options.prompt);

  // Add issue context if bound to a task
  if (issue) {
    prompt += `\n\n---\n\nBound to beads issue ${issue.id}: "${issue.title}"`;
    if (issue.description) {
      prompt += `\n\n${issue.description}`;
    }
  }

  // 6. Generate Claude session ID for resume capability (only if task-bound)
  const claudeSessionId = options.taskId ? randomUUID() : undefined;

  // 7. Register worker (if taskId provided)
  if (options.taskId && issue) {
    const worker: registry.Worker = {
      id: options.taskId,
      paneId,
      session,
      worktree: worktreePath,
      taskId: options.taskId,
      taskTitle: issue.title,
      startedAt: new Date().toISOString(),
      state: 'spawning',
      lastStateChange: new Date().toISOString(),
      repoPath,
      claudeSessionId,
    };

    if (useBeads) {
      try {
        await beadsRegistry.ensureAgent(options.taskId, {
          paneId,
          session,
          worktree: worktreePath,
          repoPath,
          taskId: options.taskId,
          taskTitle: issue.title,
          claudeSessionId,
        });
        await beadsRegistry.bindWork(options.taskId, options.taskId);
        await beadsRegistry.setAgentState(options.taskId, 'spawning');
      } catch (error: any) {
        console.log(`   Beads registration failed: ${error.message} (non-fatal)`);
      }
    }

    await registry.register(worker);
  }

  // 8. Escape prompt for shell
  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  // Set BEADS_DIR so bd commands work in worktrees
  const beadsDir = join(repoPath, '.genie');

  // 9. Start Claude with prompt (include session ID if task-bound)
  const sessionIdArg = claudeSessionId ? `--session-id '${claudeSessionId}' ` : '';
  await tmux.executeCommand(paneId, `BEADS_DIR='${beadsDir}' claude ${sessionIdArg}'${escapedPrompt}'`, true, false);

  // 10. Update state if task-bound
  if (options.taskId) {
    if (useBeads) {
      await beadsRegistry.setAgentState(options.taskId, 'working').catch(() => {});
    }
    await registry.updateState(options.taskId, 'working');
  }

  // 11. Focus pane (unless disabled)
  if (options.focus !== false) {
    await tmux.executeTmux(`select-pane -t '${paneId}'`);
  }

  // 12. Output summary
  console.log(`\nSpawned Claude with skill: ${skillName}`);
  console.log(`   Pane: ${paneId}`);
  console.log(`   Session: ${session}`);
  if (worktreePath) {
    console.log(`   Worktree: ${worktreePath}`);
  }
  if (options.taskId) {
    console.log(`   Task: ${options.taskId}`);
    if (claudeSessionId) {
      console.log(`   Claude Session: ${claudeSessionId}`);
    }
    console.log(`\nCommands:`);
    console.log(`   term workers        - Check worker status`);
    console.log(`   term approve ${options.taskId}  - Approve permissions`);
    console.log(`   term close ${options.taskId}    - Close issue when done`);
  }
}

/**
 * List available skills
 */
export async function listSkillsCommand(): Promise<void> {
  const skills = await skillLoader.listSkills();

  if (skills.length === 0) {
    console.log('No skills found in .claude/skills/ or ~/.claude/skills/');
    return;
  }

  console.log('Available skills:\n');
  for (const skillName of skills) {
    const skill = await skillLoader.findSkill(skillName);
    if (skill?.description) {
      console.log(`  ${skillName}`);
      console.log(`    ${skill.description}\n`);
    } else {
      console.log(`  ${skillName}`);
    }
  }
}
