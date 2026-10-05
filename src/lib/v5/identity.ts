/**
 * Genie v5 acting-identity resolution — the ONE place the environment is read
 * to answer "who is writing this card change, and from what runtime".
 *
 * Every writer shares these resolvers. They were duplicated once — the CLI
 * verbs in `src/term-commands/v5-task.ts` and the since-retired MCP write tools
 * kept byte-for-byte copies — and the chains inside the CLI itself diverged
 * before that: the claim
 * chain ignored `GENIE_AGENT_ID` and floored at 'cli' while the complete chain
 * preferred NAME then ID and floored at null, so a `GENIE_AGENT_ID`-only runtime
 * claimed as 'cli' but attributed its events to the ID. One module, one chain,
 * no drift.
 *
 * Pure env reads: nothing here touches `bun:sqlite` (the `EventAuthor` import is
 * type-only and erased), so importing it costs a startup-path module nothing.
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
 * from the most specific to the most generic, because shells nest and markers
 * leak inward: OMP (`OMPCODE`), Codex (`CODEX_THREAD_ID`), pi (`PI_SESSION_ID` /
 * `PI_SESSION_FILE`), Claude Code (`CLAUDECODE`), Hermes — falling back to 'human'.
 *
 * `CLAUDECODE` is probed LATE on purpose: OMP 18.6.1 sets BOTH `OMPCODE=1` and
 * `CLAUDECODE=1` in its tool shells (Claude-compatibility), so a Claude-first
 * order attributed every OMP card event to claude-code. OMP resolves to 'pi',
 * the roster name for the pi family.
 *
 * 'human' is a fallback, not evidence: any runtime without a marker here (a
 * script, a cron job, an unrecognised agent) resolves to it.
 */
export function resolveAuthorKind(): string {
  const env = process.env;
  if (env.GENIE_AGENT_KIND) return env.GENIE_AGENT_KIND;
  if (env.OMPCODE) return 'pi';
  if (env.CODEX_THREAD_ID) return 'codex';
  if (env.PI_SESSION_ID || env.PI_SESSION_FILE) return 'pi';
  if (env.CLAUDECODE || env.CLAUDE_CODE) return 'claude-code';
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
