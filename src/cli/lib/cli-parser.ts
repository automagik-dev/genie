import type { CLIOptions, ParsedCommand } from './types';

/**
 * Parses command-line arguments into a structured command object.
 *
 * Extracts the command name and processes flags like --help, --full, --live.
 * Arguments after `--` are preserved as-is without flag parsing.
 *
 * @param {string[]} argv - Raw command-line arguments (typically from process.argv.slice(2))
 * @returns {ParsedCommand} - Object containing command, commandArgs, and options
 *
 * @example
 * // Basic command with flags
 * parseArguments(['run', 'plan', 'prompt text', '--full'])
 * // Returns: { command: 'run', commandArgs: ['plan', 'prompt text'], options: { full: true, ... } }
 *
 * @example
 * // Arguments preserved after --
 * parseArguments(['run', 'agent', '--', '--flag-for-agent'])
 * // Returns: { command: 'run', commandArgs: ['agent', '--flag-for-agent'], options: { ... } }
 */
export function parseArguments(argv: string[]): ParsedCommand {
  const raw = argv.slice();
  const command = raw.shift()?.toLowerCase();
  const options: CLIOptions = {
    rawArgs: argv.slice(),
    background: undefined,
    backgroundExplicit: false,
    backgroundRunner: false,
    requestHelp: undefined,
    full: false,
    live: false,
    executor: undefined,
    model: undefined,
    name: undefined,
    forgePort: undefined,
    geniePort: undefined
  };

  const filtered: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    if (token === '--help' || token === '-h') {
      options.requestHelp = true;
      continue;
    }
    if (token === '--full') {
      options.full = true;
      continue;
    }
    if (token === '--live') {
      options.live = true;
      continue;
    }
    if (token === '--background' || token === '-b') {
      options.background = true;
      options.backgroundExplicit = true;
      continue;
    }
    if (token === '--no-background') {
      options.background = false;
      options.backgroundExplicit = true;
      continue;
    }
    if (token === '--executor' || token === '-x') {
      const nextToken = raw[i + 1];
      if (nextToken && !nextToken.startsWith('-')) {
        options.executor = nextToken;
        i++;
        continue;
      }
    }
    if (token === '--model' || token === '-m') {
      const nextToken = raw[i + 1];
      if (nextToken && !nextToken.startsWith('-')) {
        options.model = nextToken;
        i++;
        continue;
      }
    }
    if (token === '--name' || token === '-n') {
      const nextToken = raw[i + 1];
      if (nextToken && !nextToken.startsWith('-')) {
        options.name = nextToken;
        i++; // Skip next token
        continue;
      }
    }
    if (token === '--forge-port') {
      const nextToken = raw[i + 1];
      if (nextToken && !nextToken.startsWith('-')) {
        options.forgePort = nextToken;
        i++; // Skip next token
        continue;
      }
    }
    if (token === '--genie-port' || token === '--mcp-port') {
      const nextToken = raw[i + 1];
      if (nextToken && !nextToken.startsWith('-')) {
        options.geniePort = nextToken;
        i++; // Skip next token
        continue;
      }
    }
    if (token === '--') {
      filtered.push(...raw.slice(i + 1));
      break;
    }
    filtered.push(token);
  }

  return { command, commandArgs: filtered, options };
}
