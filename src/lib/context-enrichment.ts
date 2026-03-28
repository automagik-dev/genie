/**
 * Context Enrichment — Query brain vault via rlmx for dispatch context.
 *
 * Before dispatching a worker, this module queries the agent's brain vault
 * with the wish/task context to find relevant prior knowledge. The result
 * is injected into buildContextPrompt() as an additional section.
 *
 * Design:
 * - Best-effort: if rlmx is not installed or fails, returns empty string
 * - Budget-capped: max $0.01 per enrichment query (Gemini Flash = ~$0.002)
 * - Fast: 30s timeout, max 5 iterations
 * - Non-blocking: dispatch proceeds even if enrichment fails
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Options for context enrichment. */
interface EnrichmentOptions {
  /** The wish or task description to use as the query. */
  query: string;
  /** Path to the brain vault directory. */
  brainPath?: string;
  /** Maximum cost in USD (default: 0.01). */
  maxCost?: number;
  /** Maximum iterations (default: 5). */
  maxIterations?: number;
  /** Timeout in ms (default: 30000). */
  timeout?: number;
}

/**
 * Detect the brain vault path for the current agent.
 * Checks: $AGENT_BRAIN vault via qmd, then ./brain/, then ~/brain/.
 */
function detectBrainPath(): string | null {
  // Try qmd to resolve the agent's brain
  const agentBrain = process.env.AGENT_BRAIN;
  if (agentBrain) {
    try {
      const vaultsOutput = execSync('qmd vaults 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      // Parse qmd vaults output to find the path
      for (const line of vaultsOutput.split('\n')) {
        if (line.includes(agentBrain)) {
          const pathMatch = line.match(/→\s*(.+)/);
          if (pathMatch) return pathMatch[1].trim();
        }
      }
    } catch {
      // qmd not available
    }
  }

  // Fallback: check common brain paths
  const candidates = [join(process.cwd(), 'brain'), join(homedir(), 'brain')];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

/**
 * Query the brain vault for context relevant to the given query.
 * Returns a markdown section with relevant excerpts, or empty string on failure.
 */
export function enrichContext(options: EnrichmentOptions): string {
  const brainPath = options.brainPath ?? detectBrainPath();
  if (!brainPath) return '';

  // Check if rlmx is available
  try {
    execSync('which rlmx', { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return ''; // rlmx not installed
  }

  const maxCost = options.maxCost ?? 0.01;
  const maxIterations = options.maxIterations ?? 5;
  const timeout = options.timeout ?? 30_000;

  // Build the rlmx query — ask for relevant context excerpts
  const rlmxQuery = `Given this task: "${options.query}"

Find the most relevant prior knowledge, decisions, and context from the brain vault.
Return ONLY a bulleted list of relevant excerpts with their source file paths.
Keep it under 500 words. If nothing is relevant, say "No relevant prior context."`;

  try {
    const result = execSync(
      `rlmx ${shellQuote(rlmxQuery)} --context ${shellQuote(brainPath)} --output json --max-iterations ${maxIterations} --max-cost ${maxCost}`,
      {
        encoding: 'utf-8',
        timeout,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const parsed = JSON.parse(result);
    const answer = parsed.answer?.trim();

    if (!answer || answer === 'No relevant prior context.' || answer.length < 20) {
      return '';
    }

    return `## Prior Context (from brain vault)\n\n${answer}\n`;
  } catch {
    // Best effort — enrichment failure should never block dispatch
    return '';
  }
}

/** Shell-quote a string. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
