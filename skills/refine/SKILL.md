---
name: refine
description: "Transform a brief or prompt into a structured, production-ready prompt via prompt-optimizer. File or text mode."
---

# /refine — Prompt Optimizer

Transform any brief, draft, or one-liner into a production-ready structured prompt.

## When to Use
- User wants to improve a prompt or brief
- User references `/refine` with text or a file path
- A worker needs to optimize a prompt before dispatching it

## Flow
1. **Detect mode:** argument starts with `@` → file mode; otherwise → text mode.
2. **Read input:** file mode reads the target file; text mode uses the raw argument.
3. **Load the optimizer prompt:** at dispatch time, Read `prompts/optimizer.md` (relative to this skill's directory — `skills/refine/prompts/optimizer.md`). Its full contents are the refiner's system prompt.
4. **Dispatch refiner subagent:** system prompt = the full text of `prompts/optimizer.md`; user message = the input. Single turn.
5. **Write output:** file mode overwrites the source file in place; text mode writes to `/tmp/prompts/<slug>.md`.
6. **Report:** lead with the path of the written file — that is the deliverable.

## Modes

| | File mode | Text mode |
|---|-----------|-----------|
| Invocation | `/refine @path/to/file.md` | `/refine <text>` |
| Input | file contents (strip `@` prefix) | the raw argument |
| Output | overwrite the same file | `/tmp/prompts/<slug>.md` (`mkdir -p /tmp/prompts/` first) |
| Report | the updated file path | the created file path |

Slug: `<unix-timestamp>-<word1>-<word2>-<word3>` — first 3 words, lowercased, hyphenated. Example: `1708190400-fix-auth-bug`.

## Subagent Contract

The refiner is a single-turn subagent: input in, optimized prompt out.

- **System prompt:** the full contents of `prompts/optimizer.md` — passed whole, never summarized.
- **Input:** the raw text or file contents as the user message.
- **Output:** optimized prompt body only — no labels, meta-commentary, rationale, or follow-up questions.
- No tool calls. Receive input, produce output, terminate.

## Rules
- Preserve the original intent — the simplest rewrite that satisfies the input, no added features or scope.
- Never execute the prompt — only rewrite it.
- Never enter a clarification loop — act on what you have, single turn.
- Never add wrapper text or status messages to the output file.
- File mode overwrites in place; text mode writes only to `/tmp/prompts/`.
