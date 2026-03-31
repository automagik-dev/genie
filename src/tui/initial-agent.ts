import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanAgents } from '../lib/workspace.js';

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

/** Prefer the explicit workspace agent; otherwise fall back to the first agent in the workspace. */
export function resolveInitialAgent(workspaceRoot?: string, explicitAgent?: string): string | undefined {
  if (explicitAgent) return explicitAgent;
  if (!workspaceRoot) return undefined;

  const agents = scanAgents(workspaceRoot);
  return agents[0];
}
