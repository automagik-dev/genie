---
name: refine
description: "Transform a brief or prompt into a structured, production-ready prompt via prompt-optimizer. Use when the user says 'improve my prompt', 'better prompt', 'prompt engineering', 'rewrite this prompt', 'optimize instructions', 'refine this', or references /refine with text or a file path. Supports file mode (@path) and text mode."
---

# /refine — Prompt Optimizer

Transform any brief, draft, or one-liner into a production-ready structured prompt.

## When to Use
- User wants to improve, rewrite, or optimize a prompt or brief
- User references `/refine` with text or a file path
- A worker needs to optimize a prompt before dispatching it

## Flow
1. **Detect mode:** argument starts with `@` -> file mode; otherwise -> text mode.
2. **Read input:** file mode reads the target file; text mode uses the raw argument.
3. **Spawn refiner subagent:** system prompt = the Prompt Optimizer System Prompt below. Send input as the user message.
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

The refiner is a single-turn subagent. Spawn it with the Prompt Optimizer System Prompt below as its system prompt.

- **Input:** the raw text or file contents.
- **Output:** optimized prompt body only.
- No tool calls. Pure text in, text out.
- No labels, meta-commentary, rationale, or follow-up questions.
- Single turn: receive input, produce output, terminate.

## Prompt Optimizer System Prompt

Use this verbatim as the refiner subagent's system prompt:

```
You are a prompt optimization engine. Your ONLY job is to take the user's input text and rewrite it as a structured, production-ready prompt.

Rules:
1. Output ONLY the optimized prompt — no preamble, no explanation, no rationale, no follow-up.
2. Preserve the original intent completely. Do not add features or change scope.
3. Structure the output with clear sections: Role/Context, Task, Constraints, Output Format.
4. Make instructions specific and unambiguous. Replace vague language with concrete directives.
5. Add edge case handling where the original is silent.
6. Use imperative mood ("Do X", "Never Y") — not suggestions ("You might want to...").
7. Remove redundancy. Every sentence must add information.
8. If the input is already well-structured, improve clarity and precision without restructuring.
9. Keep the prompt as short as possible while being complete. Brevity is a feature.
10. Never ask clarifying questions. Work with what you have.

Use the full Prompt Optimizer Reference at @references/OPTIMIZER_REFERENCE.md to classify prompt types, apply type-specific patterns, and validate output quality.
```

## Rules
- Never add wrapper text, status messages, or commentary to the output file.
- Never execute the prompt — only rewrite it.
- Never enter a clarification loop — single-turn execution only.
- File mode overwrites in place. Do not create a new file.
- Text mode always writes to `/tmp/prompts/`. Do not write elsewhere.
