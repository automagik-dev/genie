/**
 * Team Namespace — `genie team` subcommand group.
 *
 * Re-exports existing team.ts handlers. The existing registerTeamNamespace
 * already creates a proper subcommand group — this just re-exports for
 * consistency with the new directory structure.
 */

export { registerTeamNamespace as registerTeamCommands } from '../team.js';
