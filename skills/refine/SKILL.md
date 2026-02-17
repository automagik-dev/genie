---
name: refine
description: "Transform any brief or prompt into a production-ready structured prompt. Standalone and embedded in workers."
---

## Refiner Subagent

The refiner is a dedicated subagent spawned for each `/refine` invocation. Its system prompt is set to the full contents of `references/prompt-optimizer.md`, and its only job is to convert the provided input into an optimized prompt.

Behavior contract:
- Single-turn execution: receive input, produce optimized prompt, terminate.
- No follow-up turns, no clarification loop, no multi-step dialog.

Output contract:
- Return the prompt body ONLY.
- Do not prepend labels such as "Here’s the prompt:".
- Do not add meta-commentary, rationale, or explanation.

Portability / model-agnostic contract:
- Use pure text input/output.
- Perform no tool calls.
- This keeps behavior consistent across OpenClaw, Claude Code, and Codex.

Spawning mechanism by environment:
- OpenClaw: use `sessions_spawn` with system prompt = contents of `references/prompt-optimizer.md`.
- Claude Code: use the `Task` tool with system prompt = contents of `references/prompt-optimizer.md`.
- Codex: use `sessions_spawn` (or equivalent) with a system prompt override set to `references/prompt-optimizer.md` contents.

## File Mode

Invocation:
- `/refine @path/to/file.md`

Input behavior:
- Treat any argument starting with `@` as file mode.
- Parse the path after `@` as the target file path (example: `@.genie/wishes/my-wish/WISH.md`).
- Read the current contents of that file as the refiner input.

Processing behavior:
- Send the file contents to the refiner subagent.
- Receive optimized prompt body from the refiner.

Output behavior:
- Rewrite the same target file in place.
- Final file contents must be the optimized prompt body only (no wrapper text, no status text).
- Return/print the same file path that was updated.

Example:
- `/refine @.genie/wishes/my-wish/WISH.md`

## Text Mode

Invocation:
- `/refine <text>`

Input behavior:
- Treat non-`@` input as raw text mode.
- Accept any brief, prompt draft, or one-liner as direct text input.

Setup before writing:
- Run `mkdir -p /tmp/prompts/`.

Output file behavior:
- Write output to `/tmp/prompts/<slug>.md`.
- Build `<slug>` as `<unix-timestamp>-<word1>-<word2>-<word3>`.
- `word1..word3` are the first 3 words of the input text, lowercased and hyphenated.
- Example slug: `1708190400-fix-auth-bug`.

Processing behavior:
- Send the raw text input to the refiner subagent.
- Receive optimized prompt body from the refiner.
- Write that optimized prompt body to the generated `/tmp/prompts/<slug>.md` file.

Return behavior:
- Return/print the created output file path.

## Worker Integration
