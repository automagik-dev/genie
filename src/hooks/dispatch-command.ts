/**
 * CLI command: genie hook dispatch
 *
 * Reads a CC hook payload from stdin, runs the handler chain in-process, and
 * writes the decision to stdout. Designed for minimal startup time.
 *
 * **Dispatch model (v5):**
 *
 * In-process dispatch is the only path. Each hook event is a short-lived bun
 * fork that reads stdin, calls `dispatch()` against the module-level handler
 * registry, writes the JSON decision, drains stdout, and exits. The fork does
 * NO database work — the old hook daemon (and the PG-connection indirection it
 * existed to contain) is gone, so there is no pool to leak and nothing to boot.
 *
 * **Fail-closed at the entry:**
 *
 * CC reads empty PreToolUse stdout as allow-by-default. A payload we cannot
 * parse, or a `dispatch()` that throws unexpectedly, must therefore NOT produce
 * empty stdout — that would silently bypass every guard (branch-guard,
 * orchestration-guard, ...). `computeDispatchOutput` wraps the dispatch flow so
 * both cases emit a NON-EMPTY, non-allow envelope instead (see
 * `buildFailClosedResponse` in ./index.ts for the exact shape and the
 * AskUserQuestion inline-picker carve-out). A legitimate empty result from
 * `dispatch()` (unmatched event, allow, or the AskUserQuestion carve-out) still
 * passes through untouched.
 */

import type { Command } from 'commander';
import { registerHookTrustCommand } from '../term-commands/hook/trust.js';
import { adaptCodexPreToolUseOutput, dispatchCodexPermissionRequest } from './codex-adapter.js';
import { buildFailClosedResponse, dispatch, installDispatchRegistry } from './index.js';
import type { HookPayload } from './types.js';

async function readStdin(): Promise<string> {
  // Bun-native stdin read
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

interface ParsedEntry {
  ok: boolean;
  event?: string;
  tool?: string;
}

/**
 * Best-effort parse at the entry — independent of `dispatch()`'s own parse so
 * that a post-parse `dispatch()` throw can still name the event/tool when it
 * builds the fail-closed envelope. `dispatch()` re-parses the same string; the
 * double parse costs nothing measurable and keeps `dispatch()`'s contract
 * (returns '' on malformed JSON) unchanged.
 */
function parseEntry(stdin: string): ParsedEntry {
  try {
    const obj = JSON.parse(stdin) as Record<string, unknown>;
    return {
      ok: true,
      event: typeof obj.hook_event_name === 'string' ? obj.hook_event_name : undefined,
      tool: typeof obj.tool_name === 'string' ? obj.tool_name : undefined,
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Compute the stdout payload for one hook event, failing CLOSED on both
 * unparseable input and an unexpected `dispatch()` throw.
 *
 * `dispatch` is injectable so tests can stub a throwing dispatcher without
 * mutating the real handler registry; production always uses the real one.
 */
export async function computeDispatchOutput(
  stdin: string,
  dispatchFn: (input: string) => Promise<string> = dispatch,
  runtime: 'claude' | 'codex' = 'claude',
): Promise<string> {
  const parsed = parseEntry(stdin);

  if (!parsed.ok) {
    // Truly-unparseable stdin — near-impossible in practice (CC always emits
    // valid JSON). Event/tool are unknown, so we cannot rule out the
    // AskUserQuestion carve-out; buildFailClosedResponse emits the neutral,
    // carve-out-safe form for undefined event/tool.
    return buildFailClosedResponse(undefined, undefined, 'genie hook: unparseable payload on stdin');
  }

  try {
    if (runtime === 'codex' && parsed.event === 'PermissionRequest') {
      return await dispatchCodexPermissionRequest(JSON.parse(stdin) as HookPayload);
    }
    const output = await dispatchFn(stdin);
    return runtime === 'codex' ? adaptCodexPreToolUseOutput(output) : output;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[genie-hook] dispatch threw: ${msg}`);
    // Event/tool are known from the entry parse, so this can be the
    // event-appropriate deny/ask envelope (except for carve-out tools).
    return buildFailClosedResponse(parsed.event, parsed.tool, `genie hook: dispatch error: ${msg}`);
  }
}

interface DispatchOptions {
  runtime?: 'auto' | 'claude' | 'codex';
}

/**
 * Resolve the wire protocol for this dispatch.
 *
 * Precedence: explicit `--runtime` flag → `GENIE_HOOK_RUNTIME` env →
 * auto-detect (Codex plugin hosts export `PLUGIN_ROOT`; Claude Code does not)
 * → 'claude'.
 *
 * The shipped hooks files select the runtime via the env prefix
 * (`env GENIE_HOOK_RUNTIME=codex genie hook dispatch`), NOT the flag: hook
 * command lines must stay OLD-BINARY-COMPATIBLE. A deployed binary that
 * predates `--runtime` rejects the unknown flag at parse time — on a
 * plugin-first rollout every PreToolUse fork would error and the fail-closed
 * envelope would deny tools fleet-wide. Old binaries ignore the env var and
 * parse `hook dispatch` fine. The flag is kept for forward compat and manual
 * invocation only.
 */
export function resolveDispatchRuntime(
  flag: DispatchOptions['runtime'],
  env: NodeJS.ProcessEnv = process.env,
): 'claude' | 'codex' {
  if (flag === 'claude' || flag === 'codex') return flag;
  const envRuntime = env.GENIE_HOOK_RUNTIME;
  if (envRuntime === 'claude' || envRuntime === 'codex') return envRuntime;
  return env.PLUGIN_ROOT ? 'codex' : 'claude';
}

async function dispatchAction(options: DispatchOptions): Promise<void> {
  const stdin = await readStdin();
  if (!stdin.trim()) {
    // No payload (e.g. TTY / empty pipe) → nothing to dispatch, allow cleanly.
    process.exit(0);
  }

  // Config-gated registry install at dispatch boot: swaps in the omni-approval
  // handler only when the feature is enabled. No-op (byte-identical output)
  // otherwise. Must run before computeDispatchOutput so the registry the
  // fail-closed wrapper dispatches against already includes the omni handler.
  await installDispatchRegistry();

  const runtime = resolveDispatchRuntime(options.runtime);
  const output = await computeDispatchOutput(stdin, dispatch, runtime);
  if (output) {
    process.stdout.write(output);
  }
  await drainStdout();
  process.exit(0);
}

/**
 * Wait for stdout to flush — required before relying on process exit when the
 * caller wrote a payload that mustn't be truncated. Resolves on the next
 * 'drain' event, or immediately when the buffer is already empty.
 */
function drainStdout(): Promise<void> {
  return new Promise((resolve) => {
    // Bun + node accept an empty write whose callback fires after the buffer
    // is flushed. This is the documented way to ensure data reaches the pipe
    // before exit; avoids the race where process.exit truncates a deny
    // decision into an empty allow.
    process.stdout.write('', () => resolve());
  });
}

export function registerHookNamespace(program: Command): void {
  const hook = program.command('hook').description('Hook middleware for Claude Code and Codex integrations');

  hook
    .command('dispatch')
    .description('Dispatch a lifecycle hook event (reads JSON from stdin, writes decision to stdout)')
    .option('--runtime <runtime>', 'Wire protocol: auto, claude, or codex', 'auto')
    .action(dispatchAction);

  // Group 1 of hookify-third-party-absorption: trust subcommand. Subsequent
  // groups extend this namespace with `list`, `scaffold`, `test`, `reload`,
  // `quarantine`, `import`, `prune`. Registered synchronously so commander's
  // parse pass sees it; the trust handler itself only runs when the user
  // invokes `genie hook trust` so the dispatch hot path doesn't pay for it.
  registerHookTrustCommand(hook);
}
