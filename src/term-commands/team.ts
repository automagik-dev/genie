/**
 * Team Namespace — CRUD for team lifecycle with worktree management.
 *
 * Commands:
 *   genie team create <name> --repo <path> [--branch dev]
 *   genie team hire <agent> [--team <name>]
 *   genie team fire <agent> [--team <name>]
 *   genie team ls [<name>]
 *   genie team disband <name>
 */

import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { TeamConfig } from '../lib/team-manager.js';
import * as teamManager from '../lib/team-manager.js';

export function registerTeamNamespace(program: Command): void {
  const team = program.command('team').description('Team lifecycle management');

  // team create
  team
    .command('create <name>')
    .description('Create a new team with a git worktree')
    .requiredOption('--repo <path>', 'Path to the git repository')
    .option('--branch <branch>', 'Base branch to create from', 'dev')
    .option('--wish <slug>', 'Wish slug — auto-spawns a task leader with wish context')
    .option('--tmux-session <name>', 'Tmux session to place team window in (default: derived from repo path)')
    .option('--session <name>', 'Alias for --tmux-session (deprecated)')
    .option('--no-spawn', 'Create team and copy wish without spawning the leader (useful for testing)')
    .addHelpText(
      'after',
      `
Examples:
  genie team create my-feature --repo .                          # Create team in current repo
  genie team create my-feature --repo . --wish my-feature-slug   # Create team with a wish
  genie team create hotfix --repo . --branch main                # Create from main branch`,
    )
    .action(
      async (
        name: string,
        options: {
          repo: string;
          branch: string;
          wish?: string;
          tmuxSession?: string;
          session?: string;
          spawn?: boolean;
        },
      ) => {
        try {
          // --session is a deprecated alias for --tmux-session
          const merged = { ...options, tmuxSession: options.tmuxSession ?? options.session };
          await handleTeamCreate(name, merged);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Error: ${message}`);
          process.exit(1);
        }
      },
    );

  // team hire
  team
    .command('hire <agent>')
    .description('Add an agent to a team ("council" hires all 10 council members)')
    .option('--team <name>', 'Team name (auto-detects from leader context if omitted)')
    .action(async (agent: string, options: { team?: string }) => {
      try {
        const teamName = options.team ?? (await autoDetectTeam());
        if (!teamName) {
          console.error('Error: Could not detect team. Use --team <name> to specify.');
          process.exit(1);
        }

        const added = await teamManager.hireAgent(teamName, agent);
        if (added.length === 0) {
          console.log(`Agent "${agent}" is already a member of "${teamName}".`);
        } else if (agent === 'council') {
          console.log(`Hired ${added.length} council members to "${teamName}":`);
          for (const name of added) {
            console.log(`  + ${name}`);
          }
        } else {
          console.log(`Hired "${agent}" to team "${teamName}".`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team fire
  team
    .command('fire <agent>')
    .description('Remove an agent from a team')
    .option('--team <name>', 'Team name (auto-detects from leader context if omitted)')
    .action(async (agent: string, options: { team?: string }) => {
      try {
        const teamName = options.team ?? (await autoDetectTeam());
        if (!teamName) {
          console.error('Error: Could not detect team. Use --team <name> to specify.');
          process.exit(1);
        }

        const removed = await teamManager.fireAgent(teamName, agent);
        if (removed) {
          console.log(`Fired "${agent}" from team "${teamName}".`);
        } else {
          console.error(`Agent "${agent}" is not a member of "${teamName}".`);
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team ls — no arg = list teams, with arg = list members
  team
    .command('ls [name]')
    .alias('list')
    .description('List teams or members of a team')
    .option('--all', 'Include archived teams')
    .option('--json', 'Output as JSON')
    .action(async (name: string | undefined, options: { all?: boolean; json?: boolean }) => {
      try {
        if (name) {
          await printMembers(name, options.json);
        } else {
          await printTeams(options.json, options.all);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team archive
  team
    .command('archive <name>')
    .description('Archive a team (preserves all data, kills members)')
    .action(async (name: string) => {
      try {
        const archived = await teamManager.archiveTeam(name);
        if (archived) {
          console.log(`Team "${name}" archived.`);
        } else {
          console.error(`Team "${name}" not found.`);
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team unarchive
  team
    .command('unarchive <name>')
    .description('Restore an archived team')
    .action(async (name: string) => {
      try {
        const restored = await teamManager.unarchiveTeam(name);
        if (restored) {
          console.log(`Team "${name}" unarchived.`);
        } else {
          console.error(`Team "${name}" not found.`);
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team disband (now archives instead of deleting)
  team
    .command('disband <name>')
    .description('Disband a team (archives — preserves data). Use `genie team archive` directly.')
    .action(async (name: string) => {
      try {
        const disbanded = await teamManager.disbandTeam(name);
        if (disbanded) {
          console.log('Note: disband now archives the team. Use `genie team archive` directly.');
          console.log(`Team "${name}" disbanded (archived).`);
        } else {
          console.error(`Team "${name}" not found.`);
          process.exit(1);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team done
  team
    .command('done <name>')
    .description('Mark a team as done and kill all members')
    .action(async (name: string) => {
      try {
        await teamManager.setTeamStatus(name, 'done');
        await teamManager.killTeamMembers(name);
        console.log(`Team "${name}" marked as done. All members killed.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team blocked
  team
    .command('blocked <name>')
    .description('Mark a team as blocked and kill all members')
    .action(async (name: string) => {
      try {
        await teamManager.setTeamStatus(name, 'blocked');
        await teamManager.killTeamMembers(name);
        console.log(`Team "${name}" marked as blocked. All members killed.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team cleanup
  team
    .command('cleanup')
    .description('Kill tmux windows for done/archived teams')
    .option('--dry-run', 'Show what would be cleaned without doing it')
    .action(async (options: { dryRun?: boolean }) => {
      try {
        await handleTeamCleanup(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}

// ============================================================================
// Team Create Handler (extracted for cognitive complexity)
// ============================================================================

export async function handleTeamCreate(
  name: string,
  options: { repo: string; branch: string; wish?: string; tmuxSession?: string; spawn?: boolean },
): Promise<void> {
  const resolvedRepo = resolve(options.repo);

  // Validate wish exists before creating team — auto-copy from cwd if needed
  if (options.wish) {
    const wishPath = join(resolvedRepo, '.genie', 'wishes', options.wish, 'WISH.md');
    if (!existsSync(wishPath)) {
      // Auto-copy: search cwd for the wish
      const cwdWishDir = join(process.cwd(), '.genie', 'wishes', options.wish);
      const cwdWishPath = join(cwdWishDir, 'WISH.md');
      if (existsSync(cwdWishPath)) {
        const destDir = join(resolvedRepo, '.genie', 'wishes', options.wish);
        await mkdir(destDir, { recursive: true });
        await cp(cwdWishDir, destDir, { recursive: true });
        console.log(`Wish: copied ${options.wish}/WISH.md to repo`);
      } else {
        console.error(`Error: Wish not found at ${wishPath}`);
        process.exit(1);
      }
    }
  }

  const config = await teamManager.createTeam(name, options.repo, options.branch);

  // Always resolve tmuxSessionName — prevents session explosion on parallel creates
  // Resolution: explicit --tmux-session → PG agent session → repo path mapping
  const { findSessionByRepo } = await import('../lib/agent-directory.js');
  const { resolveRepoSession } = await import('../lib/tmux.js');
  config.tmuxSessionName =
    options.tmuxSession ?? (await findSessionByRepo(resolvedRepo)) ?? (await resolveRepoSession(resolvedRepo));
  if (options.wish) {
    config.wishSlug = options.wish;
  }
  await teamManager.updateTeamConfig(name, config);

  console.log(`Team "${config.name}" created.`);
  console.log(`  Worktree: ${config.worktreePath}`);
  console.log(`  Branch: ${config.name} (from ${config.baseBranch})`);
  if (config.tmuxSessionName) {
    console.log(`  Session: ${config.tmuxSessionName}`);
  }
  if (config.nativeTeamsEnabled) {
    console.log('  Native teams: enabled');
  }

  if (options.wish && options.spawn !== false) {
    await spawnLeaderWithWish(config, options.wish, options.repo, options.tmuxSession);
  }
}

// ============================================================================
// Wish-based Leader Spawn
// ============================================================================

/**
 * Copy wish into worktree, hire leader, build context, and auto-spawn.
 *
 * Resolves the tmux session name BEFORE spawning workers and stores it
 * in the team config so all subsequent spawns use the same session.
 */
async function spawnLeaderWithWish(
  config: TeamConfig,
  slug: string,
  repoPath: string,
  sessionOverride?: string,
): Promise<void> {
  const { handleWorkerSpawn } = await import('./agents.js');
  const { findSessionByRepo } = await import('../lib/agent-directory.js');
  const { resolveRepoSession } = await import('../lib/tmux.js');
  const resolvedRepo = resolve(repoPath);

  // Use already-resolved session from handleTeamCreate, with fallback chain for safety
  const tmuxSession =
    sessionOverride ??
    config.tmuxSessionName ??
    (await findSessionByRepo(resolvedRepo)) ??
    (await resolveRepoSession(resolvedRepo));
  config.tmuxSessionName = tmuxSession;
  await teamManager.updateTeamConfig(config.name, config);

  // Resolve leader from project's leader_agent, spawner = caller identity
  const { getProjectByRepoPath } = await import('../lib/task-service.js');
  const project = await getProjectByRepoPath(resolvedRepo);
  const leaderAgent = project?.leaderAgent || slug;
  config.leader = leaderAgent;
  config.spawner = process.env.GENIE_AGENT_NAME || 'cli';
  await teamManager.updateTeamConfig(config.name, config);

  // Locate WISH.md in source repo
  const sourceWishPath = join(resolvedRepo, '.genie', 'wishes', slug, 'WISH.md');
  if (!existsSync(sourceWishPath)) {
    console.error(`Error: Wish not found at ${sourceWishPath}`);
    process.exit(1);
  }

  // Copy wish into worktree (.genie/ is gitignored so worktree won't have it)
  const destWishDir = join(config.worktreePath, '.genie', 'wishes', slug);
  await mkdir(destWishDir, { recursive: true });
  const destWishPath = join(destWishDir, 'WISH.md');
  await copyFile(sourceWishPath, destWishPath);
  console.log(`  Wish: copied ${slug}/WISH.md into worktree`);

  // Hire the standard team: leader (team-lead template) + engineer + reviewer + qa + fix
  const standardRoles = ['team-lead', 'engineer', 'reviewer', 'qa', 'fix'];
  for (const role of standardRoles) {
    await teamManager.hireAgent(config.name, role);
  }
  console.log(`  Team: hired ${standardRoles.join(', ')}`);

  // Spawn leader — use team-lead template for behavior, leaderAgent for identity
  const members = standardRoles.filter((r) => r !== 'team-lead').join(', ');
  const spawner = config.spawner || 'cli';
  const kickoffPrompt = `Your team is "${config.name}". Repo: ${config.repo}. Branch: ${config.name}. Worktree: ${config.worktreePath}. Wish slug: ${slug}. Your team members are: ${members} (already hired — genie work will spawn them automatically). Report completion to: ${spawner} (via genie send --to ${spawner}). Read the wish at .genie/wishes/${slug}/WISH.md and execute the full lifecycle autonomously.`;
  await handleWorkerSpawn('team-lead', {
    provider: 'claude',
    team: config.name,
    role: leaderAgent,
    cwd: config.worktreePath,
    session: tmuxSession,
    initialPrompt: kickoffPrompt,
  });

  // Deliver kickoff prompt via mailbox as backup (durable, queued to disk)
  const protocolRouter = await import('../lib/protocol-router.js');
  const result = await protocolRouter.sendMessage(config.worktreePath, 'cli', leaderAgent, kickoffPrompt);
  if (!result.delivered) {
    console.warn(`⚠ Backup delivery to ${leaderAgent} failed: ${result.reason ?? 'unknown'}`);
  }
  console.log(`  Leader: ${leaderAgent} spawned as ${slug}`);
}

// ============================================================================
// Helpers
// ============================================================================

/** Auto-detect team name from GENIE_TEAM env var. */
async function autoDetectTeam(): Promise<string | null> {
  const envTeam = process.env.GENIE_TEAM;
  if (envTeam) return envTeam;

  const teams = await teamManager.listTeams();
  if (teams.length === 1) return teams[0].name;

  return null;
}

/** Print members of a specific team. */
async function printMembers(name: string, json?: boolean): Promise<void> {
  const members = await teamManager.listMembers(name);
  if (members === null) {
    console.error(`Team "${name}" not found.`);
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify(members, null, 2));
    return;
  }

  if (members.length === 0) {
    console.log(`Team "${name}" has no members. Hire agents with: genie team hire <agent> --team ${name}`);
    return;
  }

  console.log('');
  console.log(`MEMBERS of "${name}"`);
  console.log('-'.repeat(60));
  for (const m of members) {
    console.log(`  ${m}`);
  }
  console.log('');
}

/** Print all teams. */
async function printTeams(json?: boolean, includeArchived?: boolean): Promise<void> {
  const teams = await teamManager.listTeams(includeArchived);

  if (json) {
    console.log(JSON.stringify(teams, null, 2));
    return;
  }

  if (teams.length === 0) {
    console.log('No teams found. Create one with: genie team create <name> --repo <path>');
    return;
  }

  console.log('');
  console.log('TEAMS');
  console.log('-'.repeat(60));
  for (const t of teams) {
    printTeamSummary(t);
  }
  console.log('');
}

/** Print a single team summary line. */
function printTeamSummary(t: TeamConfig): void {
  const status = t.status ?? 'in_progress';
  const dimmed = status === 'archived' ? '\x1b[90m' : '';
  const reset = status === 'archived' ? '\x1b[0m' : '';
  console.log(`  ${dimmed}${t.name}  [${status}]${reset}`);
  console.log(`    Repo: ${t.repo}`);
  console.log(`    Branch: ${t.name} (from ${t.baseBranch})`);
  console.log(`    Worktree: ${t.worktreePath}`);
  console.log(`    Members: ${t.members.length}`);
}

// ============================================================================
// Team Cleanup Handler
// ============================================================================

/** Find the tmux window matching a team name (handles dot-sanitized names). */
async function findTeamWindow(sessionName: string, teamName: string): Promise<{ name: string } | null> {
  const tmuxLib = await import('../lib/tmux.js');
  const session = await tmuxLib.findSessionByName(sessionName);
  if (!session) return null;

  try {
    const windows = await tmuxLib.listWindows(sessionName);
    return windows.find((w) => w.name === teamName || w.name === teamName.replace(/\./g, '_')) ?? null;
  } catch {
    return null;
  }
}

/** Try to kill a team's tmux window. Returns a log message or null. */
async function cleanupTeamWindow(t: TeamConfig, dryRun: boolean): Promise<string | null> {
  if (!t.tmuxSessionName) return null;
  const match = await findTeamWindow(t.tmuxSessionName, t.name);
  if (!match) return null;

  if (dryRun) {
    return `  [dry-run] Would kill window "${match.name}" in session "${t.tmuxSessionName}" (team "${t.name}" [${t.status}])`;
  }

  const tmuxLib = await import('../lib/tmux.js');
  const killed = await tmuxLib.killWindow(t.tmuxSessionName, match.name);
  if (!killed) return null;
  return `  Killed window "${match.name}" in session "${t.tmuxSessionName}" (team "${t.name}")`;
}

/** Kill tmux windows for done/archived teams. */
async function handleTeamCleanup(options: { dryRun?: boolean }): Promise<void> {
  const allTeams = await teamManager.listTeams(true);
  const cleanable = allTeams.filter((t) => t.status === 'done' || t.status === 'archived');

  if (cleanable.length === 0) {
    console.log('No done/archived teams to clean up.');
    return;
  }

  let cleaned = 0;
  for (const t of cleanable) {
    const msg = await cleanupTeamWindow(t, options.dryRun === true);
    if (msg) {
      console.log(msg);
      cleaned++;
    }
  }

  const verb = options.dryRun ? 'Would clean' : 'Cleaned';
  if (cleaned === 0) {
    console.log('No tmux windows found for done/archived teams.');
  } else {
    console.log(`\n${verb} ${cleaned} window${cleaned === 1 ? '' : 's'}.`);
  }
}
