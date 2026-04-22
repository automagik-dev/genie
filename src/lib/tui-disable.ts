/**
 * TUI disable flag — user-side safety valve for the OpenTUI kqueue hot-loop
 * observed on local macOS ptys with `@opentui/core-darwin-arm64@0.1.102`.
 *
 * Symptom: launching the TUI locally (not over SSH) pegs one core at ~101%
 * because the native input poll never yields. No keystrokes reach the JS
 * layer, so Ctrl-Q cannot exit and SIGTERM is ignored — only SIGKILL works.
 *
 * This flag lets users short-circuit every TUI bootstrap path BEFORE any
 * `@opentui/core` (FFI) import runs. The guard is intentionally minimal and
 * env/arg-driven so it is safe to consult from top-level module code that
 * runs before Commander has parsed argv.
 *
 * Activation (any of):
 *   - `GENIE_TUI_DISABLE=1` (or any truthy value: 1/true/yes/on, case-insensitive)
 *   - `--no-tui` anywhere in process.argv
 *
 * Callers MUST check this BEFORE any `import('./tui/...')` or
 * `import('@opentui/core')` — otherwise the native dylib loads and the spin
 * can still happen if something later tries to create a renderer.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Return true when the TUI bootstrap should be skipped. */
export function isTuiDisabled(): boolean {
  const envVal = process.env.GENIE_TUI_DISABLE;
  if (envVal && TRUTHY.has(envVal.trim().toLowerCase())) return true;
  if (process.argv.includes('--no-tui')) return true;
  return false;
}

/**
 * Emit a one-line stderr notice explaining that a TUI path was skipped and why.
 * `context` is a short label for the call site (e.g. "renderer", "attach",
 * "serve"). Kept as a single helper so the message stays consistent.
 */
export function noticeTuiSkipped(context: string): void {
  // Single line, stderr, no ANSI — easy to grep from logs and CI output.
  const reason = process.env.GENIE_TUI_DISABLE ? 'GENIE_TUI_DISABLE is set' : '--no-tui flag present';
  console.error(
    `genie: TUI ${context} skipped (${reason}). See https://github.com/automagik-dev/genie for status of the upstream OpenTUI kqueue spin on macOS.`,
  );
}
