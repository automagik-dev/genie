# Claude Sonnet 5.5 overlay

Loaded after `claude.md` when the destination is a worker prompt for Claude Sonnet 5.5 (`--target sonnet`). It selects guidance, not a runtime model. Official source checked 2026-09-28: [Sonnet 5.5 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5). The following is our concise adaptation, not vendor quotation. The target is a worker inside a saved workflow whose agent returns a JSON schema; apply each clause only where the stage shape fits.

## Add when the stage fits

- **Carry-through, for multipart or tool-using stages:** tell the worker to keep going until everything asked is done, and to stop and ask only when it cannot continue without the caller or before a risky step. Existing approval boundaries stay untouched.
- **Stop and report within scope, for any stage that produces work:** once the requested work is done and checked, the worker stops and reports. It adds no features, tests, files, docs or refactors that were not asked for; a useful extra is mentioned at the end of the result instead of done. If the prompt has no scope-creep rule, add this one.
- **Verification, for stages that change runnable, buildable or type-checkable code:** before reporting done, run a real check that exercises the change: the project's tests, type-checker or build, or the changed command. A syntax-only check, or a check that failed to start, does not count. If only declared dependencies are missing, install them with the project's own package manager and lockfile, never via sudo or the system package manager, unless told not to. If no real check can run, name the one not run and why instead of reporting done. Keep any full gate the prompt already requires.
- **Structured output, for stages that return a schema:** end the prompt with the single line `Think the problem through before you answer.` It makes thinking before the answer more likely on tasks that need a few steps of working out. Do not add it to stages that only fetch or copy.

## Remove when present

- Any request to put reasoning, a rationale or a chain of thought in the answer. It invites `reasoning_extraction` refusals; the schema carries the result, and the runtime reads reasoning from thinking blocks. Keep fields that report evidence or findings the task asks for.
- "Minimize tool calls", "only use tools when strictly necessary" and similar tool-discouraging wording. Where a stage needs current facts, say to check them with the available tools rather than answer from memory.
- "Hold all findings for the final response". Progress remarks between tool calls are fine; the schema still governs the final result.
- Any instruction that tells the model not to think or to answer without thinking; it makes stray internal tags in the output more likely.

## Report, never inject

Effort level, `max_tokens`, `thinking` mode (including `between_tools`, which cannot combine with `xhigh` or `max` and gives no up-front thinking for tool-free schema stages), progress-update display and harness reminders are runtime settings. Report what a stage should run with, for example that a schema stage without tools needs adaptive thinking and a `max_tokens` with room for thinking plus the JSON, and that a `max_tokens` stop is a failed attempt. Never write these controls, or placeholders for them, into the prompt body.
