import type { Command } from 'commander';

export const MCP_RETIRED_DIAGNOSTIC =
  'Error: genie mcp has been retired; use `genie task` and `genie board`, or roll back to a pre-A7 signed release.';

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Report that the legacy Genie MCP server is retired')
    .action(() => {
      process.stderr.write(`${MCP_RETIRED_DIAGNOSTIC}\n`);
      process.exitCode = 1;
    });
}
