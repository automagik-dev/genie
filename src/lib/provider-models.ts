/**
 * Provider/model compatibility validator for `genie spawn`.
 *
 * Council recommendation P0 (council deliberation 2026-04-28):
 * "`genie spawn --provider codex --model opus` must hard-fail at parse with
 *  a clear error naming valid codex models."
 *
 * Tonight's failure: spawning council members with `--provider codex --model
 * opus` forwarded `opus` (a Claude model name) to `codex --model opus`. Codex
 * rejected the unknown model and the agent died on startup, leaving the
 * council with `error`-state members and silent partial degradation.
 *
 * This module is the parser-level gate: classify the model name by provider
 * pattern. If the model unambiguously belongs to a different provider than
 * the requested one, reject. Unknown / unrecognized model names are ALLOWED
 * to pass through — model identifiers evolve faster than our table and we
 * prefer letting the underlying CLI surface a clear error over false-rejecting
 * a future model name.
 *
 * The check only fires when BOTH `--provider` and `--model` are explicit. If
 * either is absent the user is opting into provider defaults and we don't
 * second-guess them.
 */

export type ProviderName = 'claude' | 'claude-sdk' | 'codex' | string;

/** Patterns that uniquely identify a Claude model. */
const CLAUDE_MODEL_PATTERNS: RegExp[] = [
  /^opus(-\d+(\.\d+)?)?$/i, // opus, opus-4, opus-4.5
  /^sonnet(-\d+(\.\d+)?)?$/i, // sonnet, sonnet-4, sonnet-4.5
  /^haiku(-\d+(\.\d+)?)?$/i, // haiku, haiku-4
  /^claude-/i, // claude-3-opus-20240229, claude-opus-4-7, claude-sonnet-*
];

/** Patterns that uniquely identify a Codex / OpenAI-line model. */
const CODEX_MODEL_PATTERNS: RegExp[] = [
  /^gpt-/i, // gpt-4o, gpt-5, gpt-5-codex
  /^o[134](?:-|$)/i, // o1, o1-mini, o3, o3-mini, o4
  /^codex(?:-|$)/i, // codex, codex-mini
];

/**
 * Classify a model name by which provider's pattern it matches.
 * Returns `null` if no pattern matches (unknown / pass-through).
 */
function classifyModel(model: string): 'claude' | 'codex' | null {
  for (const re of CLAUDE_MODEL_PATTERNS) {
    if (re.test(model)) return 'claude';
  }
  for (const re of CODEX_MODEL_PATTERNS) {
    if (re.test(model)) return 'codex';
  }
  return null;
}

/**
 * Provider family — claude and claude-sdk share the same model namespace.
 * Returns `null` for unrecognized providers (pass-through).
 */
function providerFamily(provider: ProviderName | undefined | null): 'claude' | 'codex' | null {
  if (!provider) return null;
  const p = provider.toLowerCase();
  if (p === 'claude' || p === 'claude-sdk') return 'claude';
  if (p === 'codex') return 'codex';
  return null;
}

export interface ValidateProviderModelArgs {
  provider?: string | null;
  model?: string | null;
}

export class CrossProviderModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossProviderModelError';
  }
}

/**
 * Validate that `--model` is plausible for `--provider`.
 *
 * Throws `CrossProviderModelError` with a clear, actionable message when the
 * model name unambiguously belongs to a different provider family than the
 * one requested. Returns silently on:
 *   - Either field missing (user opted into provider defaults)
 *   - Unknown provider (we don't gatekeep providers we don't recognize)
 *   - Unknown model (model names evolve faster than this table; defer to
 *     the underlying CLI to surface its own error)
 *   - Model and provider in the same family (the happy path)
 */
export function validateProviderModel(args: ValidateProviderModelArgs): void {
  const { provider, model } = args;
  if (!provider || !model) return; // user opted into defaults; skip

  const requestedFamily = providerFamily(provider);
  if (requestedFamily === null) return; // unknown provider — pass through

  const modelFamily = classifyModel(model);
  if (modelFamily === null) return; // unknown model — defer to underlying CLI

  if (modelFamily === requestedFamily) return; // happy path

  // Hard mismatch — build a clear error.
  const wantedExamples =
    requestedFamily === 'claude' ? 'opus, sonnet, haiku, claude-opus-4-7' : 'gpt-5-codex, gpt-4o, o3-mini, codex-mini';
  const lines = [
    `--model "${model}" is a ${modelFamily} model name but --provider is "${provider}" (${requestedFamily} family). This was the source of the council-deliberation incident on 2026-04-28: "genie spawn --provider codex --model opus" forwarded "opus" to codex CLI, which rejected it, killing the agent on startup with no useful error to the operator.`,
    '',
    'Either:',
    "  - Drop --model to use the provider's default, OR",
    `  - Pass a ${requestedFamily}-family model (e.g., ${wantedExamples}), OR`,
    '  - Switch --provider to match the model family.',
  ];
  throw new CrossProviderModelError(lines.join('\n'));
}
