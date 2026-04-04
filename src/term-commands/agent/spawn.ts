/**
 * genie agent spawn <name> — Spawn a new agent by name.
 * Migrated from top-level `genie spawn` in agents.ts.
 */

import type { Command } from 'commander';
import { type SpawnOptions, handleWorkerSpawn } from '../agents.js';

export function registerAgentSpawn(parent: Command): void {
  parent
    .command('spawn <name>')
    .description('Spawn a new agent by name (resolves from directory or built-ins)')
    .option('--provider <provider>', 'Provider: claude, codex, or claude-sdk')
    .option('--team <team>', 'Team name', process.env.GENIE_TEAM ?? 'genie')
    .option('--model <model>', 'Model override (e.g., sonnet, opus)')
    .option('--skill <skill>', 'Skill to load (optional)')
    .option('--layout <layout>', 'Layout mode: mosaic (default) or vertical')
    .option('--color <color>', 'Teammate pane border color')
    .option('--plan-mode', 'Start teammate in plan mode')
    .option('--permission-mode <mode>', 'Permission mode (e.g., acceptEdits)')
    .option('--extra-args <args...>', 'Extra CLI args forwarded to provider')
    .option('--cwd <path>', 'Working directory for the agent (overrides directory entry)')
    .option('--session <session>', 'Tmux session name to spawn into')
    .option('--role <role>', 'Override role name for registration (avoids duplicate guard)')
    .option('--new-window', 'Create a new tmux window instead of splitting')
    .option('--window <target>', 'Tmux window to split into (e.g., genie:3)')
    .option('--no-auto-resume', 'Disable auto-resume on pane death')
    .option('--prompt <prompt>', 'Initial prompt (first user message)')
    .option('--sdk-max-turns <n>', 'SDK: max conversation turns', Number)
    .option('--sdk-max-budget <usd>', 'SDK: max budget in USD', Number)
    .option('--sdk-stream', 'SDK: enable streaming output (shortcut for --stream)')
    .option('--sdk-effort <level>', 'SDK: reasoning effort level (low, medium, high, max)')
    .action(async (name: string, options: SpawnOptions) => {
      if (options.prompt) options.initialPrompt = options.prompt;
      try {
        await handleWorkerSpawn(name, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}
