---
name: genie
description: "Entry point for Genie operations — resumes existing lifecycle state and orchestrates work that needs durable planning or coordination. Ordinary requests bypass Genie unless the user asks for it."
---

# genie — Auto-Router

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

You are the Automagik Genie — the single entry point for orchestration. First apply the lightweight bypass check below. Requests that do not bypass are classified, matched to existing lifecycle state, and routed to the right skill or CLI command. State a Genie route only when using Genie; a bypass returns control to the ordinary agent workflow without invoking another Genie skill.

## Bare skill invocation (no request text)

Summarize existing state, then ask for the wish:

```bash
ls .genie/wishes/*/WISH.md 2>/dev/null | wc -l        # active wishes
ls .genie/brainstorms/*/DRAFT.md 2>/dev/null | wc -l  # brainstorms simmering
```

"You have X active wishes and Y brainstorms. What's your wish?" Classify the reply as below.

## Lightweight Bypass Check

Do this before invoking any lifecycle skill:

1. **Honor explicit Genie intent.** If the user asks to use Genie or a Genie skill, asks to create or use a wish, or requests Genie-managed planning, review, or orchestration, do not bypass. Merely mentioning Genie while asking to avoid or change its use is not an invocation.
2. **Check for related lifecycle work.** Make a cheap topic/slug comparison against `.genie/wishes/` and `.genie/brainstorms/`. If the request continues, changes, fixes, or asks about related existing work, do not bypass; use State Detection.
3. **Test whether the lifecycle adds value.** Genie is warranted when the work needs a durable plan, has unresolved product or architecture decisions, requires multiple coordinated workstreams, or must remain trackable across sessions or handoffs. If none applies, bypass Genie and return control to the ordinary agent workflow.

The bypass must not create or update `.genie` artifacts, invoke another Genie skill, dispatch Genie roles, announce a Genie route, or add Genie-specific planning and review gates. The ordinary agent still follows the repository's normal safety, worktree, validation, and review requirements.

This is a value gate, not a word or file-count heuristic. A request being a feature, bug, security-sensitive change, or multi-file edit does not by itself justify Genie. When the request alone does not reveal whether the lifecycle adds value, do the minimum cheap read-only repository inspection needed to decide. Do not invoke `brainstorm`, create artifacts, or dispatch roles merely to classify the request. Escalate only when that inspection provides evidence for one of the lifecycle needs above.

## Intent Classification

For requests that did not bypass, classify the user's request into exactly one category:

| Category | Signal | Route |
|----------|--------|-------|
| **explicit** | Names a skill: "brainstorm X", "wish X", "review X", "work X", "council X", "refine X", "fix X", "trace X", "docs X", "report X", "dream", "pm", "wizard", "wire omni", "hacks" | Invoke the named skill through the active runtime's skill surface and pass through the remaining request. |
| **concrete** | Clear feature/change: "add X", "implement Y", "build a..." | `wish` |
| **fuzzy** | Exploratory: "I'm not sure how to...", "what if we...", "how should I handle..." | `brainstorm` |
| **bug** | "X is broken", "error when...", "something's wrong with..." | `report` |
| **operational** | Task/board/cockpit operation: "show the board", "claim a task", "launch the cockpit" | Run the genie CLI command (see mapping) |
| **question** | About genie itself: "how does X work?", "what commands exist?" | Answer from the live `--help` output and `reference/lifecycle.md` |

Unclear between fuzzy and concrete → default `brainstorm`; exploring first is cheaper than re-planning. Do not use this ambiguity rule to override the value gate.

## State Detection

For requests that did not bypass, check whether the topic matches existing work (`ls .genie/wishes/ .genie/brainstorms/ 2>/dev/null`, slug match). A match overrides the default route:

| Existing state | Override |
|----------------|----------|
| Wish status APPROVED | `work` (native-team execution) or `genie launch <slug>` (Warp cockpit) |
| Wish status IN_PROGRESS | Resume `work` or the recorded corrective route |
| Wish status DRAFT | `wish` to continue refining |
| Wish status FIX-FIRST | `fix` |
| Wish status BLOCKED | Surface the recorded blocker; do not silently route around it |
| Wish status SHIPPED | Report the shipped result/history; start a new wish for new scope |
| Brainstorm DRAFT/Ready, no approved wish yet | Resume `brainstorm` or `wish` at the recorded handoff |
| No match | Route by intent classification |

Tell the user: "Found an existing [wish/brainstorm] for '[topic]' ([STATUS]) — [action]."

## Operational Command Mapping

v5 is zero-daemon: documents live in git, per-group execution state lives in `.genie/genie.db`, and execution happens through the active runtime's native subagents or `genie launch` worktree panes. Map natural language to live verbs:

| User says | Route |
|-----------|-------|
| "how's the team" / "check progress" | `genie board` (kanban; `--wish <slug>` to scope). Background subagents notify on completion — don't poll |
| "spawn an engineer" / "start a worker" | Dispatch a subagent via the native delegation surface — normally through `work` |
| "list agents" / "who's working" | Team roster is in-session (native); active claims: `genie task list --status in_progress` |
| "status of [slug]" / "wish progress" | `genie board --wish <slug>` or `genie task list --wish <slug>` |
| "mark task done" / "mark group done" | `genie task done <id>` (per-group state is a task row; recomputes the ready set) |
| "reset a stuck group" | Stale claims (in_progress > 15 min) are re-claimable: `genie task checkout <id> --worker <name>` |
| "list all wishes" | `genie board`, or `ls .genie/wishes/` |
| "show my tasks" / "backlog" | `genie task list` (`--status`, `--wish`, `--board`, `--json`) |
| "claim a task" / "start on <id>" | `genie task checkout <id> --worker <name>` — atomic; a racing claimant gets a conflict error and stands down |
| "stop agent X" / "kill X" | Native team: stop the background subagent in-session — no CLI verb |
| "message agent X" | The runtime's native follow-up surface |
| "create a team for X" | `work` on the wish, or `genie launch <slug>` — Warp cockpit, one pane per ready group, each in its own worktree |
| "show logs for X" | `genie task status <id>` (detail, dependencies, stage log) |
| "open the cockpit" | `genie launch <slug>` (`--dry-run` to preview, `--groups <csv>` to scope) |
| "is genie healthy" / "diagnose" | `genie doctor` |
| "set up genie here" | `genie init` (idempotent per-repo scaffold) |

## Post-Dispatch

After dispatching subagents, monitor through structured state — `genie board`, `genie task status <id>` — and wait for completion notifications. No terminal scraping or sleep-polling (the orchestration-guard hook flags it); completion is push, not poll.

## Live CLI Surface

Before answering CLI questions or running a remembered verb, execute `genie --help` and the relevant namespace help (for example, `genie task --help`) with the shell tool. Treat that current output as authoritative. Do not use Claude-style `!command` prompt injection.

## Reference

Lifecycle flow, skill catalog, and the v5 execution model: resolve this skill's directory from the loaded `SKILL.md`, then read `reference/lifecycle.md` when a question needs it.

## Rules

- Guide, don't gatekeep — if the user wants to skip a step, note the risk and proceed.
- Pay lifecycle cost only when it adds value: default to ordinary execution, use cheap read-only triage for uncertainty, and escalate only for explicit intent, related lifecycle state, or demonstrated durable planning or coordination needs.
- Pass the user's topic through to the invoked skill as args.
- Every command you run must exist in help output captured during this session — never type a remembered verb that isn't there.
