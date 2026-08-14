/**
 * Genie v5 acting-identity resolution — the ONE place the environment is read
 * to answer "who is writing this card change, and from what runtime".
 *
 * Every writer shares these resolvers: the CLI verbs in
 * `src/term-commands/v5-task.ts` and the operative MCP write tools in
 * `mcp-tools.ts`. They were duplicated once (the MCP copy was byte-for-byte the
 * CLI's) and the chains inside the CLI itself diverged before that — the claim
 * chain ignored `GENIE_AGENT_ID` and floored at 'cli' while the complete chain
 * preferred NAME then ID and floored at null, so a `GENIE_AGENT_ID`-only runtime
 * claimed as 'cli' but attributed its events to the ID. One module, one chain,
 * no drift.
 *
 * Pure env reads: nothing here touches `bun:sqlite` (the `EventAuthor` import is
 * type-only and erased), so importing it costs the lazy-loaded MCP surface
 * nothing.
 */

import type { EventAuthor } from './task-state.js';

/**
 * Resolve the worker identity from the environment: `GENIE_AGENT_NAME`, then
 * `GENIE_AGENT_ID`, flooring at 'cli'. Shared by the claim side (`task
 * checkout`'s worker → `claimed_by`) and the complete side
 * (`resolveEventAuthor().author` → event attribution), so the two sides always
 * record the same identity for the same runtime. NOTE: completion is NOT
 * identity-fenced — completeTask deliberately has no claimed_by check (`task
 * done` is the orchestrator's verb, routinely run by a non-claimant); a shared
 * resolver only keeps claim rows and event attribution consistent.
 */
export function resolveWorkerIdentity(): string {
  return process.env.GENIE_AGENT_NAME ?? process.env.GENIE_AGENT_ID ?? 'cli';
}

/**
 * Infer the acting runtime kind from the environment. An explicit
 * `GENIE_AGENT_KIND` always wins; otherwise the coding-agent markers are probed
 * in order (Claude Code, Codex, Hermes), falling back to 'human'.
 */
export function resolveAuthorKind(): string {
  const env = process.env;
  if (env.GENIE_AGENT_KIND) return env.GENIE_AGENT_KIND;
  if (env.CLAUDECODE || env.CLAUDE_CODE) return 'claude-code';
  if (env.CODEX_THREAD_ID) return 'codex';
  if (env.HERMES || env.HERMES_HOME) return 'hermes';
  return 'human';
}

/**
 * Resolve the acting author for a card event: identity via
 * {@link resolveWorkerIdentity} (so a no-env CLI writes 'cli', matching what
 * checkout wrote to `claimed_by`), kind via {@link resolveAuthorKind}. The
 * single author resolver behind every authored verb and `moveTask` — on the CLI
 * per invocation, on the MCP server only when a call supplies no explicit
 * `author`/`worker` argument.
 */
export function resolveEventAuthor(): EventAuthor {
  return {
    author: resolveWorkerIdentity(),
    authorKind: resolveAuthorKind(),
  };
}
