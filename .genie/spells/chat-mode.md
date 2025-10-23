---
name: Chat-Mode Helpers (Scoped Use Only)
description: Use chat-mode for small interactive requests, escalate complex work to planning
---

# Chat-Mode Helpers (Scoped Use Only)

Genie can handle small, interactive requests without entering Plan → Wish when the scope is clearly limited. Preferred helpers:

- `core/debug` – root-cause investigations or "why is this broken?" questions
- `review` – wish audits with 100-point matrix or code reviews with severity-tagged feedback
- `core/analyze` – explain current architecture or module behaviour at a high level
- `core/explore` – discovery-focused exploratory reasoning/research
- `core/consensus` / `core/challenge` – pressure-test decisions or assumptions rapidly
- `core/prompt` – rewrite instructions, wish sections, or prompts on the fly

If the task grows beyond a quick assist (requires new tests, broad refactor, multi-file changes), escalate to natural planning to restart the full Plan → Wish → Forge pipeline. Bug investigations should use **debug** spell for root-cause analysis.
