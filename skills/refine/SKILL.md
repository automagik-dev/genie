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

## Text Mode

## Worker Integration
