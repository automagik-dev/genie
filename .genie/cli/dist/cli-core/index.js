/**
 * CLI Core Module - Pure handlers with zero side effects on import
 *
 * Addresses Genie RISK-1: genie.ts main() execution on import
 * Addresses Genie RISK-2: Session store concurrency via SessionService with file locking
 */
export { SessionService } from './session-service';
import { createRunHandler } from './handlers/run';
import { createResumeHandler } from './handlers/resume';
import { createViewHandler } from './handlers/view';
import { createStopHandler } from './handlers/stop';
import { createListHandler } from './handlers/list';
/**
 * Factory function for creating CLI command handlers
 *
 * Returns an object with handler functions that can be called by both CLI and MCP server.
 * Handlers are pure functions that don't execute on import.
 */
export function createHandlers(context) {
    return {
        run: createRunHandler(context),
        resume: createResumeHandler(context),
        list: createListHandler(context),
        view: createViewHandler(context),
        stop: createStopHandler(context)
    };
}
