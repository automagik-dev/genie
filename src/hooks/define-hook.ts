/**
 * defineHook — config-object helper for external hook authors.
 *
 * External hook files (~/.claude/teams/<team>/hooks/, <repo>/.genie/hooks/,
 * ~/.genie/hooks/) export a HandlerV1 object. Authors should not have to know
 * the full `Handler` type or the discriminated union — they declare the hook
 * via `defineHook({ name, event, ... })` and the helper fills in the
 * boilerplate (`version: '1'`, defaults).
 *
 * The loader sets `source` and `manifest_path` after import based on which
 * tier the file lives in; authors do NOT set these — any value passed for
 * `source` or `manifest_path` is overwritten by the loader.
 */

import type { HandlerResult, HandlerV1, HookEventName, HookPayload } from './types.js';

/**
 * Config accepted by `defineHook` — author-facing shape.
 *
 * Excludes `version` (always '1'), `source` (loader sets), and
 * `manifest_path` (loader sets). Matcher accepts a string (compiled to a
 * RegExp anchored on both ends) or a RegExp passed through verbatim.
 */
export interface DefineHookConfig {
  name: string;
  event: HookEventName;
  /**
   * Matched against `tool_name` for PreToolUse/PostToolUse events. A string
   * is interpreted as a regex source and compiled with no flags. To pass a
   * compiled RegExp directly (e.g. with case-insensitive flag), pass a
   * RegExp instance instead.
   */
  matcher?: string | RegExp;
  /** Lower priority runs first. Defaults to 100 (after every builtin handler). */
  priority?: number;
  /** Async function that receives the hook payload and returns a result. */
  run: (payload: HookPayload) => Promise<HandlerResult>;
}

/**
 * Build a `HandlerV1` from author-supplied config.
 *
 * The returned object has `source` and `manifest_path` set to placeholder
 * values; the loader overwrites them when registering. Calling `defineHook`
 * directly (e.g. in tests) and registering the result without going through
 * the loader is supported but the placeholder fields will be visible in
 * `genie hook list`.
 */
export function defineHook(config: DefineHookConfig): HandlerV1 {
  const matcher = typeof config.matcher === 'string' ? new RegExp(config.matcher) : config.matcher;
  return {
    version: '1',
    name: config.name,
    event: config.event,
    matcher,
    priority: config.priority ?? 100,
    fn: config.run,
    // Loader overwrites these. Direct callers see the placeholders.
    source: 'global',
    manifest_path: '<defineHook caller>',
  };
}
