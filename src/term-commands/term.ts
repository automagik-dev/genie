/**
 * Term Namespace — Low-level tmux operations, namespaced under
 * `genie term` per DEC-1.
 *
 * This is a passthrough to the original `term` CLI surface.
 */

import { Command } from 'commander';

export function registerTermNamespace(program: Command): void {
  const term = program
    .command('term')
    .description('Low-level tmux session/pane operations (DEC-1: namespaced under genie)');

  // term session — placeholder for full session management
  const session = term
    .command('session')
    .description('tmux session management');

  session
    .command('ls')
    .description('List tmux sessions')
    .action(async () => {
      try {
        const { execSync } = require('child_process');
        const output = execSync("tmux list-sessions -F '#{session_name}: #{session_windows} windows' 2>/dev/null", { encoding: 'utf-8' });
        console.log(output.trim() || 'No tmux sessions.');
      } catch {
        console.log('No tmux server running.');
      }
    });

  session
    .command('new <name>')
    .description('Create a new tmux session')
    .option('-d, --detached', 'Create in detached mode')
    .action(async (name: string, options: { detached?: boolean }) => {
      try {
        const { execSync } = require('child_process');
        const flag = options.detached ? '-d' : '';
        execSync(`tmux new-session ${flag} -s '${name}'`, { stdio: 'inherit' });
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });
}
