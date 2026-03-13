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
    .action(async (name: string, options: { repo: string; branch: string }) => {
      try {
        const config = await teamManager.createTeam(name, options.repo, options.branch);
        console.log(`Team "${config.name}" created.`);
        console.log(`  Worktree: ${config.worktreePath}`);
        console.log(`  Branch: ${config.name} (from ${config.baseBranch})`);
        if (config.nativeTeamsEnabled) {
          console.log('  Native teams: enabled');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team hire
  team
    .command('hire <agent>')
    .description('Add an agent to a team ("council" hires all 10 council members)')
    .option('--team <name>', 'Team name (auto-detects from leader context if omitted)')
    .action(async (agent: string, options: { team?: string }) => {
      try {
        const repoPath = process.cwd();
        const teamName = options.team ?? (await autoDetectTeam(repoPath));
        if (!teamName) {
          console.error('Error: Could not detect team. Use --team <name> to specify.');
          process.exit(1);
        }

        const added = await teamManager.hireAgent(teamName, agent, repoPath);
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
        const repoPath = process.cwd();
        const teamName = options.team ?? (await autoDetectTeam(repoPath));
        if (!teamName) {
          console.error('Error: Could not detect team. Use --team <name> to specify.');
          process.exit(1);
        }

        const removed = await teamManager.fireAgent(teamName, agent, repoPath);
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
    .option('--json', 'Output as JSON')
    .action(async (name: string | undefined, options: { json?: boolean }) => {
      try {
        const repoPath = process.cwd();
        if (name) {
          await printMembers(repoPath, name, options.json);
        } else {
          await printTeams(repoPath, options.json);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team disband
  team
    .command('disband <name>')
    .description('Disband a team: kill members, remove worktree, delete config')
    .action(async (name: string) => {
      try {
        const repoPath = process.cwd();
        const disbanded = await teamManager.disbandTeam(repoPath, name);
        if (disbanded) {
          console.log(`Team "${name}" disbanded.`);
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
}

// ============================================================================
// Helpers
// ============================================================================

/** Auto-detect team name from GENIE_TEAM env var. */
async function autoDetectTeam(repoPath: string): Promise<string | null> {
  const envTeam = process.env.GENIE_TEAM;
  if (envTeam) return envTeam;

  const teams = await teamManager.listTeams(repoPath);
  if (teams.length === 1) return teams[0].name;

  return null;
}

/** Print members of a specific team. */
async function printMembers(repoPath: string, name: string, json?: boolean): Promise<void> {
  const members = await teamManager.listMembers(repoPath, name);
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
async function printTeams(repoPath: string, json?: boolean): Promise<void> {
  const teams = await teamManager.listTeams(repoPath);

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
  console.log(`  ${t.name}`);
  console.log(`    Repo: ${t.repo}`);
  console.log(`    Branch: ${t.name} (from ${t.baseBranch})`);
  console.log(`    Worktree: ${t.worktreePath}`);
  console.log(`    Members: ${t.members.length}`);
}
