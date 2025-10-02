/**
 * CLI Core Module - Pure handlers with zero side effects on import
 *
 * Addresses Twin RISK-1: genie.ts main() execution on import
 * Addresses Twin RISK-2: Session store concurrency via SessionService with file locking
 */

export { SessionService } from './session-service';
export type {
  SessionServiceOptions
} from './session-service';

export type { HandlerContext, Handler } from './context';

import { createRunHandler } from './handlers/run';
import { createResumeHandler } from './handlers/resume';
import { createViewHandler } from './handlers/view';
import { createStopHandler } from './handlers/stop';
import { createListHandler } from './handlers/list';
import type { HandlerContext } from './context';

/**
 * Factory function for creating CLI command handlers
 *
 * Returns an object with handler functions that can be called by both CLI and MCP server.
 * Handlers are pure functions that don't execute on import.
 */
export function createHandlers(context: HandlerContext) {
  return {
    run: createRunHandler(context),
    resume: createResumeHandler(context),
    list: createListHandler(context),
    view: createViewHandler(context),
    stop: createStopHandler(context)
  };
}
