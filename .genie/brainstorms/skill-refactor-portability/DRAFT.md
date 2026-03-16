# Brainstorm: Genie Skill Refresh — Full Orchestration Model

**Slug:** `skill-refresh`
**Date:** 2026-03-14

## Problem

The genie skills and orchestration rules are stale and disconnected. The orchestration rules file (`~/.claude/rules/genie-orchestration.md`) references commands that don't exist. Skills don't auto-invoke each other. The full delivery lifecycle — from idea to QA-proven merge — isn't documented anywhere as a cohesive flow.

## Three-Layer Architecture

### Layer 1: Dispatch Commands (CLI verbs)
The leader calls these to spawn agents with context + skill injection:

```bash
genie brainstorm <agent> <slug>      # spawn with DRAFT.md context + /brainstorm skill
genie wish <agent> <slug>            # spawn with DESIGN.md context + /wish skill
genie work <agent> <slug>#<group>    # check deps → startGroup → spawn with group context + /work skill
genie review <agent> <slug>#<group>  # spawn with group + diff context + /review skill
```

State machine integration:
- `genie work` calls `wishState.startGroup()` — enforces dependency order
- `genie done slug#group` calls `completeGroup()` — marks done, unblocks dependents
- `genie status slug` — shows all groups with state/assignee
- `genie reset slug#group` — recovers stuck in_progress groups

### Layer 2: Skills (agent prompts)
What the spawned agent does when it runs. Each skill is self-contained instructions for one role:

| Skill | What the agent does | Invoked by |
|-------|-------------------|------------|
| `/brainstorm` | Interactive idea refinement via WRS | `genie brainstorm` dispatch or user |
| `/wish` | Create WISH.md with groups, deps, criteria | `genie wish` dispatch or user |
| `/work` | Execute assigned group: implement, local review, signal done | `genie work` dispatch |
| `/review` | Validate against criteria → SHIP/FIX-FIRST/BLOCKED | `genie review` dispatch or user |
| `/fix` | Fix-review loop, max 2 iterations | Auto-invoked by `/review` on FIX-FIRST |
| `/council` | 10-specialist advisory (lightweight or full spawn) | User or auto-suggested |
| `/refine` | Prompt optimization (single-turn) | Auto-invoked by `/work` |
| `/trace` | Read-only root cause investigation | `/report` or user |
| `/report` | Full bug report → GitHub issue | User |
| `/docs` | Documentation audit + generation | User or post-work |
| `/learn` | Diagnose + apply behavioral improvements | User (after mistakes) |
| `/brain` | Knowledge vault via notesmd-cli | Agent startup + session end |
| `/dream` | Batch overnight execution of multiple wishes | User |

### Layer 3: Orchestration Rules (leader's playbook)
Global knowledge in `~/.claude/rules/genie-orchestration.md`. The leader knows:

**The full lifecycle:**
1. Idea → `/brainstorm` (or `/wish` directly if clear enough)
2. Auto-detect: if request is fuzzy → auto `/brainstorm`, if clear → `/wish`
3. Design crystallized → auto `/review` (plan review)
4. Plan SHIP → `/wish` creates executable plan
5. Wish written → auto `/review` (plan review)
6. Plan SHIP → create team, hire members, start `/work`
7. Per group: `genie work` dispatches → monitor → `genie done` when complete
8. All groups done → general review → create PR to dev
9. Wait CI + read bot comments → judge critically → `/fix` valid issues
10. CI green + comments resolved → merge to dev
11. QA loop on dev: spawn tester → QA against wish criteria → `/fix` → QA → repeat until green
12. All criteria proven → mark task complete, disband team

**Team management:**
- `genie team create`, `genie team hire`, `genie team fire`, `genie team disband`
- Create team per wish/task, disband when complete

**CLI commands reference:**
- spawn, kill, stop, ls, send, broadcast, chat, done, status, reset, dir, update
- Never use native Agent/SendMessage/TeamCreate tools

**Rules:**
- Role separation: implementor ≠ reviewer ≠ fixer
- PR review: critically analyze bot comments, don't blindly accept
- CI must be green before merge
- Agents can merge to dev, never to main

## Skill-by-Skill Review

### 1. `/brainstorm` — NEEDS UPDATE
**Issues:**
- Line 81: `genie brainstorm crystallize` — dead command, remove
- Handoff says "Run /wish" — should auto-invoke `/review` first
- No `/council` suggestion when Decisions dimension stuck
- Trivial ideas get "verbal validation only" — should still persist a one-liner in jar

**Changes:**
- Remove `genie brainstorm crystallize` reference
- At WRS=100: auto-invoke `/review` (plan review on DESIGN.md)
- When Decisions ░ persists: suggest `/council` for advisory
- Trivial: still add to jar with a one-liner

### 2. `/wish` — NEEDS UPDATE
**Issues:**
- Step 7 "link tasks" is vague — should say "declare depends-on between groups"
- Handoff says "Run /work" — should auto-invoke `/review` (plan review) first
- Gate check only asks "does design exist?" not "was it reviewed?"
- No state initialization mention
- Should detect fuzzy requests and auto-trigger `/brainstorm` instead of trying to plan half-baked ideas

**Changes:**
- Fix step 7: "declare `depends-on` between execution groups"
- At wish completion: auto-invoke `/review` (plan review)
- Gate check: verify DESIGN.md exists AND passed review (or ask user to confirm)
- Add: when invoked with a fuzzy request (no design, unclear scope), auto-trigger `/brainstorm` first
- Mention that `genie work` auto-initializes state from the wish

### 3. `/work` — NEEDS UPDATE
**Issues:**
- No mention of `genie done slug#group` / `genie status slug` for state tracking
- "No state management" rule contradicts the need for state commands
- Missing: `/work` is what the implementor does, the leader orchestrates via dispatch commands

**Changes:**
- Clarify: `/work` is the implementor's skill, invoked via `genie work` dispatch
- Add: after completing assigned group work, signal to leader via `genie send`
- Add: leader uses `genie done` to mark groups complete (not the worker)
- The local `/review` within `/work` is the implementor self-checking against spec before signaling done
- Remove "no state management" rule confusion — worker signals completion, leader manages state

### 4. `/review` — reviewed, clean
- Three pipelines (plan, execution, PR) correct
- Council participation documented
- Verdict → next step needs clarification per context:
  - Plan review SHIP → proceed to `/wish` or `/work`
  - Execution review SHIP → proceed to PR
  - PR review SHIP → merge
  - FIX-FIRST → auto-invoke `/fix`

### 5. `/fix` — reviewed, clean
No changes needed.

### 6. `/council` — NEEDS UPDATE
**What it does:** 10-specialist advisory panel. Two modes:
- **Lightweight (simulated):** All perspectives generated in a single session. Fast, cheap, good for quick decisions.
- **Full spawn (real agents):** Leader hires council via `genie team hire council`, each member is a real agent with its own lens prompt. Topic posted to `genie chat`, members respond independently, leader synthesizes consensus.

**What's clean:**
- Dual-mode detection (check if council members in team)
- Smart routing table (architecture, security, API design, operations, etc.)
- "Advisory only, never block" rule
- Output format with votes + synthesis

**Issues:**
- No auto-invocation triggers — when should leader/skills auto-invoke council?
- Full spawn: no timeout/fallback if a council member doesn't respond
- No mention of `genie team hire council` as the setup step for full spawn
- Should clarify: lightweight = fast single-agent simulation, full spawn = real multi-agent deliberation via team chat reaching actual consensus

**Changes:**
- Add auto-invocation guidance: invoke during `/review` for architecture decisions, suggest during `/brainstorm` when Decisions stuck
- Full spawn setup: document `genie team hire council` → spawns all 10 with lens prompts
- Add timeout for full spawn: if member hasn't responded after reasonable wait, note as "no response" and proceed
- Clarify the two modes: simulated (one agent role-plays all perspectives) vs orchestrated (real agents deliberate via `genie chat` and reach consensus)

### 7. `/trace` — MINOR UPDATE
**What it does:** Read-only root cause investigation. Reproduces, hypothesizes, traces, isolates root cause. Hands structured report to `/fix`.

**What's clean:**
- Read-only enforcement (no Write, no Edit)
- Structured report format (root cause, evidence, causal chain, confidence)
- Strict separation from `/fix`
- Correct dispatch (`genie spawn tracer`)

**Issues:**
- No auto-invocation guidance — `/report` calls it, but `/review` should also invoke when failure found with unclear root cause
- Ambiguous: is the agent the tracer, or does it dispatch a tracer? Clarify: when spawned via dispatch, the agent IS the tracer. When leader invokes directly, they spawn a tracer.
- No mention of tracer reporting findings back via `genie send`

**Changes:**
- Add: tracer signals findings to leader via `genie send` when investigation complete
- Clarify: the spawned agent runs as the tracer (read-only investigation inline)
- Add auto-invocation note: `/review` can invoke `/trace` when root cause is unclear before handing to `/fix`

### 8. `/report` — MINOR UPDATE
**What it does:** Full bug investigation → GitHub issue. Cascades `/trace` for code analysis, browser evidence via `agent-browser`, observability data, compiles into `gh issue create`.

**What's clean:**
- Phase independence (each fails gracefully)
- `/trace` always runs as backbone
- Report template comprehensive
- Degradation rules well-designed

**Issues:**
- `agent-browser` should be a genie dependency — it's essential for QA and any browser-based validation, not just `/report`
- No connection to wish system — bug reports from QA loop could link to wish criteria failures
- No auto-invocation guidance — QA loop could auto-invoke `/report` for test failures needing investigation

**Changes:**
- Document `agent-browser` as a genie dependency (required for browser-based QA/validation)
- Add: when invoked during QA loop, link findings to specific wish acceptance criteria
- Add auto-invocation note: QA failures with unclear root cause → `/report` → `/trace` → `/fix`

### 9. `/docs` — NEEDS UPDATE
**What it does:** Audit docs, find gaps, generate, validate against code.

**What's clean:**
- Validation-first principle (verify every claim)
- No fiction rule
- Correct dispatch (`genie spawn docs`)

**Issues:**
- Very thin (35 lines) — almost a stub, no structure for doc types
- No mention of CLAUDE.md as a documentation surface (most important doc for agent behavior)
- No connection to wishes — after `/work` completes, could auto-run to document what was built
- No guidance on what kinds of docs: README, API docs, architecture, CHANGELOG, CLAUDE.md

**Changes:**
- Add doc types to audit: README, CLAUDE.md, API docs, architecture docs, inline JSDoc
- Add: CLAUDE.md is a first-class documentation surface — validate it reflects current codebase
- Add auto-invocation note: after `/work` completes a wish, suggest `/docs` to document what changed
- Add: when codebase changes significantly (new modules, removed commands, new patterns), flag CLAUDE.md as needing update

### 10. `/learn` — NEEDS REWRITE
**What it does:** Interactive behavioral tuning after user identifies a mistake or wants to teach the agent.

**What's broken:**
- Writable surfaces too narrow — lists specific files instead of diagnosing what needs to change
- Reads like "teach me about your project" wizard — should be "you made a mistake, figure out what behavioral surface to fix"
- No connection to Claude native memory system
- References `BOOTSTRAP.md` — doesn't exist, remove
- `~/.claude/rules/` not listed as writable — but that's where orchestration rules live
- Hooks not mentioned as a behavioral surface

**Changes — rewrite scope:**
- Primary trigger: user corrects a mistake → `/learn` diagnoses what must change to prevent recurrence
- Writable surfaces: anything that shapes behavior — the skill DIAGNOSES which surface:
  - `CLAUDE.md` — project conventions, commands, gotchas
  - `AGENTS.md` — agent identity, role, preferences
  - `SOUL.md` / `IDENTITY.md` — agent personality, values
  - `~/.claude/rules/` — global rules (orchestration, agent-bible)
  - `.claude/memory/` — persistent knowledge (Claude native memory)
  - `.claude/settings.json` — hooks, permissions
  - `memory/` — project-scoped memory files
  - Any config file that shapes agent behavior
- Remove `BOOTSTRAP.md` reference entirely (file doesn't exist)
- Connect to Claude native memory: learnings should be saved as feedback memories that persist across sessions
- The skill's job: analyze the mistake → determine root cause (wrong rule? missing knowledge? bad habit?) → propose the minimal change to the correct surface → apply with approval

### 11. `/refine` — NEEDS UPDATE
**What it does:** Single-turn prompt optimization. Text-in, production-ready prompt out.

**What's clean:**
- Simple, focused, does one thing well
- Single-turn contract clear
- Auto-invoked by `/work`

**Issues:**
- References `references/prompt-optimizer.md` as a separate file — when installed via npm, agent wastes time trying to find it. The reference content should be inlined into the SKILL.md itself so no external file lookup is needed.

**Changes:**
- Inline the `prompt-optimizer.md` content directly into the SKILL.md — no reference file dependency
- This applies to ALL skills that reference external files in `references/` — they should be self-contained for npm installs

### 12. `/brain` — NEEDS UPDATE
**What it does:** Persistent context graph via `notesmd-cli`. NOT memory — this is entity/relationship/domain knowledge building. Search before answering, write back when intel discovered.

**Distinction from memory:**
- **Memory** (Claude native + `memory/` files) = events, feedback, decisions. "What I learned."
- **Brain** (`brain/` vault via notesmd-cli) = entities, relationships, patterns, domain knowledge. "What I know about the world." A knowledge graph that grows over time.

**What's clean:**
- Vault structure (Daily, Domains, Intelligence, Playbooks) maps well to context graph
- 3 write-back triggers are disciplined
- Search-before-answering protocol
- Auto-sync optional

**Issues:**
- `notesmd-cli` installation friction — if not installed, skill is dead. Should auto-detect and offer to install
- No install guidance beyond "brew install" — should reference the repo and figure out install method dynamically
- Doesn't clarify the memory vs brain distinction — users/agents confuse them
- Provisioning templates overlap with `/learn`

**Changes:**
- Add auto-detection: check if `notesmd-cli` is on PATH. If not, offer to install by reading install instructions from https://github.com/Yakitrak/notesmd-cli
- Clarify brain vs memory distinction at the top of the skill: brain = context graph (entities, relationships, domain), memory = behavioral learnings (feedback, decisions)
- Remove provisioning template overlap with `/learn` — brain provisions the vault, learn handles behavioral surfaces
- Keep the name `/brain` — it's intuitive

### 13. `/dream` — NEEDS UPDATE
**What it does:** Overnight batch execution of multiple SHIP-ready wishes. Pick wishes, build dependency plan, execute, review, QA, merge — wake up to results.

**What's clean:**
- Team per dream session (isolation)
- Topological sort for dependency ordering
- Parallel dispatch by layer
- Worker self-refinement via `/refine`
- DREAM-REPORT.md as wake-up artifact

**Issues:**
- Stale ref: `Status: SHIPPED` — remove
- Workers create PRs directly — should be leader-managed (leader creates PR after reviewing work)
- CI fix loop has `sleep 5` — wasteful, should poll CI status instead
- No QA loop — stops at PR review. Must include full QA cycle on dev after merge
- No `genie done` / `genie status` for tracking wish group completion
- No `genie reset` for recovering stuck groups overnight
- Worker contract doesn't match the full lifecycle (missing: local review per group, leader PR management, QA on dev)

**Changes — align with full lifecycle:**
- Phase 1 (Execute): per wish, use `genie work` dispatch per group (not raw spawn). This gets state tracking for free. Leader monitors via `genie status`, marks done via `genie done`.
- Phase 2 (Review + PR): leader creates PR to dev after all groups done. Reads bot comments critically. `/fix` for valid issues. CI must be green.
- Phase 3 (Merge + QA): merge to dev (agents allowed). Spawn tester on dev branch. QA loop: test against wish criteria → `/fix` → test until green. Each fix round = new PR to dev.
- Phase 4 (Report): DREAM-REPORT.md with per-wish status: completed, merged, QA-verified, or blocked with reason.
- Remove `sleep 5` — use CI status polling or just re-run checks
- Add `genie reset` usage for overnight stuck group recovery
- Remove stale `Status: SHIPPED` ref

### All 13 skills reviewed.

## Cross-Cutting Issues

1. **Reference files break on npm install** — `/brainstorm` (design-template.md), `/refine` (prompt-optimizer.md), `/wish` (wish-template.md) all reference external files in `references/`. Agents waste time looking for them. All reference content must be inlined into SKILL.md.

2. **`agent-browser` as genie dependency** — essential for QA, `/report`, any browser validation. Should be documented as a required/recommended dependency.

3. **`notesmd-cli` auto-install** — `/brain` should detect if missing and offer to install from https://github.com/Yakitrak/notesmd-cli

4. **Memory vs Brain clarification** — every skill that touches persistence should know: memory = behavioral learnings (Claude native), brain = context graph (notesmd-cli vault). No confusion.

## Orchestration Rules Source of Truth

Hardcoded string constant in TWO places (must update both):
1. `plugins/genie/scripts/smart-install.js` line 243
2. `install.sh` line 655

Written to `~/.claude/rules/genie-orchestration.md` on install or version change.

## WRS Status

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```
