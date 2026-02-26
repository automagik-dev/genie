/**
 * Team Namespace — CRUD for team lifecycle.
 *
 * Commands:
 *   genie team create <name> [--blueprint <bp>]
 *   genie team list
 *   genie team delete <name>
 */

import { Command } from 'commander';
import * as teamManager from '../lib/team-manager.js';

export function registerTeamNamespace(program: Command): void {
  const team = program
    .command('team')
    .description('Team lifecycle management');

  // team create
  team
    .command('create <name>')
    .description('Create a new team (optionally from a blueprint)')
    .option('-b, --blueprint <name>', 'Blueprint to use (work, dream, review, fix, debug)')
    .action(async (name: string, options: { blueprint?: string }) => {
      try {
        const repoPath = process.cwd();
        const config = await teamManager.createTeam(repoPath, name, options.blueprint);
        console.log(`Team "${config.name}" created.`);
        if (config.blueprint) {
          console.log(`  Blueprint: ${config.blueprint}`);
        }
        if (config.roles.length > 0) {
          console.log(`  Roles: ${config.roles.map(r => r.name).join(', ')}`);
        }
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
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
          console.log('No teams found. Create one with: genie team create <name> --blueprint work');
          return;
        }

        console.log('');
        console.log('TEAMS');
        console.log('-'.repeat(60));
        for (const t of teams) {
          const roles = t.roles.map(r => r.name).join(', ') || '(no roles)';
          const bp = t.blueprint ? ` [${t.blueprint}]` : '';
          console.log(`  ${t.name}${bp}`);
          console.log(`    Roles: ${roles}`);
        }
        console.log('');
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
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
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });

  // team blueprints
  team
    .command('blueprints')
    .description('List available blueprints')
    .action(() => {
      const names = teamManager.listBlueprints();
      console.log('Available blueprints:');
      for (const name of names) {
        const bp = teamManager.getBlueprint(name);
        if (bp) {
          const roles = bp.roles.map(r => r.name).join(', ');
          console.log(`  ${name}: ${roles}`);
        }
      }
    });
}
