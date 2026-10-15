/**
 * The termination protocol every FINAL-terminated run needs in its system
 * prompt.
 *
 * Why this module exists: a pack's own `SYSTEM.md` *replaces* the scaffolded
 * template rather than extending it — both `buildSystemPrompt` (`src/rlm.ts`)
 * and `buildCachedSystemPrompt` (`src/cache.ts`) start from `config.system`
 * verbatim. The ```repl``` fence contract and the `FINAL()` / `FINAL_VAR()`
 * contract lived *only* in `src/templates/default/SYSTEM.md`, so an agent that
 * shipped a hand-written prompt was never told how to stop: it emitted prose,
 * `detectFinal` never fired, and the run burned to `max_iterations`.
 *
 * The text below is authored for the runtime rather than copied from the
 * template — templates stay untouched, and the two are free to diverge in
 * voice.
 *
 * Deliberately absent, unlike the template: `SHOW_VARS()`. This section is
 * appended to *every* custom prompt, so it stays a minimal termination
 * contract — how to run code, how to stop, and the one ordering mistake that
 * breaks stopping. `SHOW_VARS()` is a debugging convenience rather than part
 * of terminating, and enumerating REPL helpers here would compete with
 * whatever inventory the pack's own prompt already gives. (It is bound at
 * every tool level — `python/repl_server.py` — so this is an editorial choice,
 * not an availability one.)
 *
 * Consumers must go through `appendStopProtocol` so the dedupe and opt-out
 * rules stay in one place.
 */
import { isGoogleProvider } from "./gemini.js";
/**
 * Check if structured output mode is active: `output.schema` set and the
 * provider is Google (Gemini). In this mode the run loop treats the
 * schema-constrained API response itself as the final answer — `detectFinal`
 * is never consulted — so the FINAL protocol must not be taught. Lives here
 * so `shouldAppendStopProtocol` and the run loop (`src/rlm.ts`) share one
 * definition.
 */
export function isStructuredOutputMode(config) {
    return config.output.schema !== null && isGoogleProvider(config.model.provider);
}
/**
 * Substring that marks a system prompt as already teaching the protocol.
 *
 * Matched against `config.system` — the pack's *base* text — and never against
 * the partially built prompt, which by construction contains the appended
 * section itself and would suppress every subsequent append.
 */
export const STOP_PROTOCOL_SENTINEL = "FINAL(";
/**
 * The appended section: ```repl``` fence contract, `FINAL()` / `FINAL_VAR()`
 * contract with the ordering warning, and the iteration-0 note mirroring the
 * runtime safeguard `buildUserPrompt` already injects into the first user
 * message (`src/rlm.ts`).
 */
export const STOP_PROTOCOL_SECTION = `## REPL & Final Answer Protocol

To run Python in the REPL environment, wrap the code in triple backticks with the \`repl\` language identifier. For example:
\`\`\`repl
chunk = context[:10000]
answer = llm_query(f"What is the magic number in the context? Here is the chunk: {chunk}")
print(answer)
\`\`\`

IMPORTANT: When the iterative process is done, you MUST deliver your final answer inside a FINAL function — not as ordinary prose, and not inside a code block. You have two options:
1. \`FINAL(your final answer here)\` returns the answer directly.
2. \`FINAL_VAR(variable_name)\` returns a variable you already built in the REPL as your final output.

WARNING — COMMON MISTAKE: \`FINAL_VAR\` retrieves an EXISTING variable. Create and assign that variable in a \`\`\`repl\`\`\` block FIRST, then call \`FINAL_VAR\` in a SEPARATE later step.

On iteration 0 you have not touched the REPL or seen your context yet, so investigate first — do not answer with FINAL straight away.`;
/**
 * Whether `config` wants the protocol appended.
 *
 * Three ways to get `false`:
 * - `prompt.append-stop-protocol: false` (mikro.yaml, or an agent.yaml
 *   override applied by `applyAgent`) — an explicit opt-out.
 * - Structured output mode (`output.schema` + a Google provider): the run
 *   loop finalizes the schema-constrained JSON response directly and never
 *   looks for `FINAL()`, so teaching it would demand two mutually exclusive
 *   output shapes — the model may wrap `FINAL(...)` inside schema string
 *   fields or fail structured generation altogether.
 * - `config.system` already contains `FINAL(` — the pack teaches the protocol
 *   itself, which is true of both shipped templates.
 *
 * An absent or empty `config.system` (zero-config runs included) gets the bare
 * section. That is intended: an empty system prompt otherwise leaves the model
 * with no way to terminate at all.
 */
export function shouldAppendStopProtocol(config) {
    if (config.prompt?.appendStopProtocol === false)
        return false;
    if (isStructuredOutputMode(config))
        return false;
    return !(config.system ?? "").includes(STOP_PROTOCOL_SENTINEL);
}
/**
 * Append the protocol to a partially built system prompt, honouring the
 * dedupe and opt-out rules. `prompt` is the prompt built so far; the decision
 * is made from `config` alone, never from `prompt`.
 */
export function appendStopProtocol(prompt, config) {
    if (!shouldAppendStopProtocol(config))
        return prompt;
    return prompt ? `${prompt}\n\n${STOP_PROTOCOL_SECTION}` : STOP_PROTOCOL_SECTION;
}
//# sourceMappingURL=stop-protocol.js.map