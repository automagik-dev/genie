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
1. **Detect mode:** argument starts with `@` -> file mode; otherwise -> text mode.
2. **Read input:** file mode reads the target file; text mode uses the raw argument.
3. **Spawn refiner subagent:** system prompt = contents of `references/prompt-optimizer.md`. Send input as the user message.
4. **Receive output:** the subagent returns the optimized prompt body only.
5. **Write output:** file mode overwrites the source file in place; text mode writes to `/tmp/prompts/<slug>.md`.
6. **Report:** print the path of the written file.

## Modes

### File Mode

Invocation: `/refine @path/to/file.md`

| Step | Action |
|------|--------|
| Parse | Strip `@` prefix to get target file path |
| Read | Load file contents as refiner input |
| Write | Overwrite the same file with optimized output |
| Return | Print the file path that was updated |

### Text Mode

Invocation: `/refine <text>`

| Step | Action |
|------|--------|
| Setup | `mkdir -p /tmp/prompts/` |
| Slug | `<unix-timestamp>-<word1>-<word2>-<word3>` (first 3 words, lowercased, hyphenated) |
| Write | Save optimized output to `/tmp/prompts/<slug>.md` |
| Return | Print the created file path |

Example slug: `1708190400-fix-auth-bug`

## Subagent Contract

The refiner is a single-turn subagent. Spawn it with system prompt set to `references/prompt-optimizer.md` contents.

- **Input:** the raw text or file contents.
- **Output:** optimized prompt body only.
- No tool calls. Pure text in, text out.
- No labels, meta-commentary, rationale, or follow-up questions.
- Single turn: receive input, produce output, terminate.

## Rules
- Never add wrapper text, status messages, or commentary to the output file.
- Never execute the prompt — only rewrite it.
- Never enter a clarification loop — single-turn execution only.
- File mode overwrites in place. Do not create a new file.
- Text mode always writes to `/tmp/prompts/`. Do not write elsewhere.
