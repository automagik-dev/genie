import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function getInitialAgentFilePath(): string {
  const genieHome = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(genieHome, 'tui-initial-agent');
}

/** Read and clear the one-shot initial-agent signal written by the thin client. */
export function consumeInitialAgentSignal(): string | undefined {
  const filePath = getInitialAgentFilePath();
  if (!existsSync(filePath)) return undefined;

  try {
    const agent = readFileSync(filePath, 'utf-8').trim();
    unlinkSync(filePath);
    return agent || undefined;
  } catch {
    return undefined;
  }
}
