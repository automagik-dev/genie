import * as logReader from '../lib/log-reader.js';
import { getTerminalConfig } from '../lib/genie-config.js';
import { resolveTarget } from '../lib/target-resolver.js';

export interface ReadOptions {
  lines?: string;
  from?: string;
  to?: string;
  range?: string;
  search?: string;
  grep?: string;
  follow?: boolean;
  all?: boolean;
  reverse?: boolean;
  json?: boolean;
}

export async function readSessionLogs(target: string, options: ReadOptions): Promise<void> {
  try {
    // Use target resolver (DEC-1 from wish-26)
    const resolved = await resolveTarget(target);
    const resolvedPaneId = resolved.paneId;
    // If resolved via worker or raw pane, we pass the paneId to the log reader
    // The log reader needs a session name for follow mode, so use resolved.session if available
    const sessionName = resolved.session || target;

    // Use config default if no lines specified
    const termConfig = getTerminalConfig();
    const defaultLines = termConfig.readLines;

    // Parse options
    const readOptions: logReader.ReadOptions = {
      lines: options.lines ? parseInt(options.lines, 10) : defaultLines,
      from: options.from ? parseInt(options.from, 10) : undefined,
      to: options.to ? parseInt(options.to, 10) : undefined,
      range: options.range,
      search: options.search,
      grep: options.grep,
      follow: options.follow,
      all: options.all,
      reverse: options.reverse,
      pane: resolvedPaneId,
    };

    // Handle follow mode
    if (options.follow) {
      console.log(`Following "${target}" (Ctrl+C to stop)...`);
      console.log('');

      const stopFollowing = await logReader.followSessionLogs(sessionName, (line) => {
        console.log(line);
      }, { pane: resolvedPaneId });

      // Handle Ctrl+C
      process.on('SIGINT', () => {
        stopFollowing();
        console.log('\nStopped following');
        process.exit(0);
      });

      // Keep process running
      await new Promise(() => {});
      return;
    }

    // Regular read mode
    const content = await logReader.readSessionLogs(sessionName, readOptions);

    if (options.json) {
      const lines = content.split('\n');
      console.log(JSON.stringify({
        target,
        session: sessionName,
        lineCount: lines.length,
        content: lines,
      }, null, 2));
      return;
    }

    console.log(content);
  } catch (error: any) {
    console.error(`Error reading logs: ${error.message}`);
    process.exit(1);
  }
}
