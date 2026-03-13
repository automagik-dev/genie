/**
 * Team Namespace — CRUD for team lifecycle.
 *
 * Commands:
 *   genie team create <name>
 *   genie team list / ls
 *   genie team delete / rm <name>
 */

import type { Command } from 'commander';
import * as teamManager from '../lib/team-manager.js';

export function registerTeamNamespace(program: Command): void {
  const team = program.command('team').description('Team lifecycle management');

  // team create
  team
    .command('create <name>')
    .description('Create a new team')
    .action(async (name: string) => {
      try {
        const repoPath = process.cwd();
        const config = await teamManager.createTeam(repoPath, name);
        console.log(`Team "${config.name}" created.`);
        if (config.nativeTeamsEnabled) {
          console.log('  Native teams: enabled (CC detected)');
          console.log(`  Session: ${config.nativeTeamParentSessionId ?? '(pending)'}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team list
  team
    .command('list')
    .alias('ls')
    .description('List all teams')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const repoPath = process.cwd();
        const teams = await teamManager.listTeams(repoPath);

        if (options.json) {
          console.log(JSON.stringify(teams, null, 2));
          return;
        }

        if (teams.length === 0) {
          console.log('No teams found. Create one with: genie team create <name>');
          return;
        }

        console.log('');
        console.log('TEAMS');
        console.log('-'.repeat(60));
        for (const t of teams) {
          console.log(`  ${t.name}`);
          console.log(`    Created: ${t.createdAt}`);
        }
        console.log('');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });

  // team delete
  team
    .command('delete <name>')
    .alias('rm')
    .description('Delete a team')
    .action(async (name: string) => {
      try {
        const repoPath = process.cwd();
        const deleted = await teamManager.deleteTeam(repoPath, name);
        if (deleted) {
          console.log(`Team "${name}" deleted.`);
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
