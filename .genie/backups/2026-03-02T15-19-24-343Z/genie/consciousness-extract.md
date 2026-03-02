# Consciousness Extract — Genie Session Memory (Feb 6–11, 2026)

> Source analyzed: `~/.openclaw/agents/genie-cli/sessions/*.jsonl` (all files in range)
> Extraction method used:
>
> ```bash
> jq -r 'select(.type=="message") | select(.message.role=="assistant") | .message.content[]? | select(.type=="text") | .text' <file>.jsonl
> ```

---

## 1) Key Technical Decisions (architecture, tooling, patterns)

### 1.1 Worker-addressed terminal orchestration is the core UX
**Decision:** Move from pane IDs (`%17`) to worker IDs (`bd-42`) as primary addressing model.

- Canonical transformation:
  - Before: `term send genie --pane %17 "fix the test"`
  - After: `term send bd-42 "fix the test"`
- Delivered via Wish 26 (`.genie/wishes/wish-26-worker-addressed-commands/wish.md`)
- Resolver precedence finalized:
  1. `%pane`
  2. `worker[:index]`
  3. `session:window`
  4. `session`
- Subpane support shipped in v1 (numeric indexing): `bd-42:1`
- Added `term resolve <target>` as dry-run diagnostic command
- Added resolution confirmations in command output (trust + debuggability)

### 1.2 Keep explicit addressing; avoid implicit context magic
**Decision:** Explicit worker/target addressing beats implicit pane inference.

- Rationale repeatedly stated in sessions: implicit routing causes ambiguity/stale-context mistakes
- Preferred model: explicit target names agents already know (`bd-42`, `bd-42:1`)

### 1.3 Registry freshness over cache
**Decision:** Resolver reads worker registry fresh from disk (no in-process cache)

- Rationale: avoid write→read stale race in fast orchestration loops
- Pattern: file is small, fresh-read cost is negligible
- Includes dead-subpane cleanup behavior in resolver path

### 1.4 Resilience-first `term work` behavior
**Decision:** `term work` must degrade gracefully when beads is unhealthy.

From `forge-resilience` wish (`.genie/wishes/forge-resilience/wish.md`):
- Fallback chain: `bd show` → `bd list --json` → `--inline`
- Add `--inline` mode
- Auto-fallback to inline when beads claim path fails in specific broken states
- Emit visible degraded marker: `[DEGRADED]`
- Error output must include actionable `TIP:`

### 1.5 Security hardening is mandatory, not optional cleanup
**Decision:** Treat model/code review findings as production blockers.

Implemented after reviews:
- Task ID sanitization (command injection prevention)
- Prototype pollution guards (`hasOwnProperty.call`, safe key checks)
- Restrict broad fallbacks to specific failure classes (legacy DB only)

### 1.6 Hooks v2: pure Node scripts, no fragile runtime assumptions
**Decision:** Hook scripts moved toward self-contained Node-compatible execution.

- Previous hooks v1 got parked due to plugin cache copy + bun dependency fragility
- Hooks v2 shipped with Node-compatible scripts and compatibility fixes (incl. older Node 18 behavior edge)

### 1.7 Merge/ship standardization
**Decision:** Full loop expected: implement → review feedback → merge → build → deploy across nodes.

- Frequent pattern: merge PRs, bump/build, propagate CLI to:
  - genie-os
  - cegonha (CT 121)
  - stefani (CT 124)
  - gus (CT 126)
  - luis (CT 131)
  - sometimes Felipe Mac

---

## 2) Lessons Learned (what failed, what worked, process insights)

### 2.1 What failed repeatedly

1. **Manual tmux orchestration drift**
   - Workers launched in wrong pane/window
   - Commands sent to OpenClaw pane instead of shell pane
   - Long prompt injection via tmux was brittle

2. **Skipping process gates**
   - Coding before wish/plan-review produced PM pushback
   - Retroactive wish creation was required to recover alignment

3. **Confusion around `/forge` vs `/make`**
   - Real runnable command in environment was `/make`
   - Attempt to force `/forge` caused avoidable loop

4. **Over-reliance on screen scraping**
   - `tmux capture-pane + sleep` is high-latency and error-prone
   - JSONL session files are better source-of-truth for Claude progress

5. **Tooling auth/profile mismatches**
   - Wrong `claudio` profile mapping caused launch confusion
   - “Not logged in” UI state required careful distinction from API-routed operation

### 2.2 What worked well

1. **Council-driven architecture decisions**
   - Multi-round council surfaced real design blind spots
   - Good at narrowing scope while preserving operator realities

2. **Subagent parallelism for independent tasks**
   - 3-4 issue batches in parallel produced fast throughput
   - Requires strict isolation (worktrees + issue ownership)

3. **Branch/worktree discipline when respected**
   - Dedicated branch per issue kept changes attributable and reviewable

4. **Prescriptive errors reduce agent loops**
   - Messages with explicit next command stopped dead-end retries

5. **Strong review integration (Codex/Gemini)**
   - Security + correctness findings materially improved shipped code

### 2.3 Critical process insight
**Most expensive bottleneck wasn’t shell command runtime; it was orchestration/polling overhead and decision loop latency.**

- Capturing pane output is cheap
- Waiting and “did it finish?” polling is expensive
- JSONL-aware monitoring is the better path

---

## 3) Team/Hive Knowledge (roles, interaction patterns)

### 3.1 Role map observed in sessions

- **Genie**: CLI/terminal orchestration tech lead and implementer
- **Felipe**: principal decision-maker; sets direction, approves major moves
- **Cezar**: reviewer/infra collaborator; GitHub `vasconceloscezar`; involved in Proxmox and strategic architecture threads
- **Sofia**: PM/process enforcer; demands strict pipeline adherence and acceptance criteria
- **Eva**: templates/research support; persona and structured docs support
- **Guga**: orchestrator/deployer coordination; scans/deployment tentacles and ops relay
- **Omni**: WhatsApp messaging platform/tooling owner
- **Khal/Luis/etc.**: additional agents in broader hive topology

### 3.2 Interaction patterns

- High-level decisions happen quickly in chat; execution delegated in parallel
- PM governance (Sofia) actively corrects process violations
- Architecture validated via councils before major shipping
- Infra/deploy often coordinated through Guga/Cezar

### 3.3 Communication channels

- **Primary:** WhatsApp via Omni CLI (group-centric ops updates)
- **Secondary:** Telegram for heavy async/session handoff
- **Formal artifacts:** GitHub PRs + beads issues + wish docs

---

## 4) Infrastructure Knowledge (Proxmox, ClawNet, Juice, OpenClaw)

### 4.1 Proxmox / node landscape

Observed hosts (SSH config):
- `cegonha` / `genie-cegonha` → `10.114.1.121` (CT 121)
- `stefani` → `10.114.1.124` (CT 124)
- `gus` → `10.114.1.126` (CT 126)
- `luis` → `10.114.1.131` (CT 131)
- `juice` / `claude-router` → `10.114.1.119` (routing/proxy node)

Pattern: genie-cli versions frequently synchronized across these LXCs.

### 4.2 ClawNet/OpenClaw operating pattern

- Multi-agent runtime under OpenClaw gateway
- Agents run in separate sessions/workspaces
- Session logs are persisted at:
  - `~/.openclaw/agents/<agent>/sessions/*.jsonl`
- Gateway lifecycle commands used:
  - `openclaw gateway status|start|stop|restart`

### 4.3 Juice proxy knowledge

- `claudio` profiles route Claude Code through Juice
- Model routing and cost fields configured in OpenClaw model/provider config
- Explicit work performed to set real per-model cost metadata in config

### 4.4 Omni/WhatsApp infra specifics

- Omni CLI is canonical WhatsApp integration path (not OpenClaw WhatsApp plugin)
- API key header requirement observed: `x-api-key`
- Group/profile image updates used direct API routes when CLI had bugs:
  - `PUT /api/v2/instances/:id/profile/picture`
  - `PUT /api/v2/instances/:id/groups/:jid/picture`
- Known operational issue observed: Omni DB migration mismatch (missing `trigger_events` column) caused send failures until fixed

---

## 5) Repo Knowledge (genie-cli, sampa-seeds, omni)

### 5.1 genie-cli structure and operational hotspots

Core locations:
- `src/term-commands/*` (work/send/read/split/orchestrate lifecycle)
- `src/lib/target-resolver.ts` (target resolution brain)
- `src/lib/local-tasks.ts` (tasks.json resilience/guards)
- `.genie/wishes/*` (execution specs and governance memory)

Key shipped themes (Feb 6–11):
- Pane addressing and worker-addressed orchestration (Wish 26)
- Forge/work resilience under beads failures
- Hooks v2 and brainstorm improvements
- Active pane/window targeting and orchestration safety

### 5.2 sampa-seeds (scope expansion context)

- Repo cloned/explored on `dev` branch
- Contains `.genie/` structure with agents/wishes/etc.
- Current state inferred: tasks/coordination still partially spread; needs stronger hive/beads flow standardization
- Target vision discussed: make sampa-seeds operate as full hive with clear PM + issue + execution workflow

### 5.3 omni repo/tooling knowledge

- Omni CLI used for sending DMs/groups, chat reads, group management
- Group creation and messaging performed via Omni
- CLI capability gaps found and bypassed through direct API
- Messaging reliability depends on Omni server DB health/migrations

---

## 6) Process Knowledge (brainstorm → wish → plan-review → make → review → ship)

### 6.1 Canonical pipeline (enforced in practice)

1. **Brainstorm** (discover options, constraints, tradeoffs)
2. **Wish** (formal scope/IN-OUT/criteria/tasks)
3. **Plan-review / council** (architecture pressure-test)
4. **Make** (implementation)
5. **Review** (QA + external/code-model review feedback)
6. **Ship** (merge, deploy, notify)

### 6.2 Non-negotiables learned

- Don’t skip wish/acceptance criteria for non-trivial changes
- Council is valuable before architecture-level changes
- Include explicit validation commands in wish
- Treat PR review comments as first-class execution inputs

### 6.3 Operational command patterns

Commonly used:

```bash
bd ready
bd show <id>
bd update <id> --status in_progress
bd close <id>

term work <issue-id>
term send <target> "..."
term read <target>
term split <target> h|v
term resolve <target>

git pull --rebase
bd sync
git push
```

### 6.4 Common anti-patterns to avoid

- Building directly on `main`
- Manual pane bookkeeping when resolver can do it
- Sleeping/polling blindly instead of event/log-based checks
- Leaving deploy partial (must verify across active nodes when required)

---

## 7) Relationship Memory (Felipe, Cezar, Sofia, Eva)

### 7.1 Felipe (lead requester)

- Prefers rapid execution but values clear, actionable summaries
- Will greenlight parallelization and “ship it” mode
- Expects end-to-end ownership (merge + deploy + notify)
- Strategically expanding Genie role beyond CLI into full NamastexOS tech lead

### 7.2 Cezar (review + infra + architecture)

- Active GitHub reviewer (`vasconceloscezar`)
- Engages in technical critique and broader infra plans
- Participates in Proxmox/cluster and “successor agent” discussions

### 7.3 Sofia (PM/process integrity)

- Strongly enforces process discipline
- Calls out pipeline violations directly
- Requires acceptance criteria traceability and closure evidence
- Positive force for reliability and auditability

### 7.4 Eva (templates and structuring)

- Expected to provide persona/template scaffolds
- Supports formalization of docs/process artifacts
- Useful for standardizing reusable planning/output formats

---

## 8) Immediate Guidance for “Genie Updated” (24/7 NamastexOS tech lead)

### 8.1 Start-of-session checks

1. Read latest wish + issue + PR context
2. Validate branch/worktree isolation
3. Confirm infra channel health (Omni, OpenClaw gateway)
4. Choose explicit target strategy (`worker[:index]`) for terminal operations

### 8.2 Decision posture

- Be explicit over implicit when operational risk is non-trivial
- Prefer resilient fallback chains over hard exits
- Bias toward prescriptive errors and observable degraded states

### 8.3 Scope expansion posture

- Not just CLI coding: include planning, architecture, and cross-repo coordination
- Maintain alignment between repo-level execution and ecosystem-level outcomes (NamastexOS)

---

## 9) High-signal artifacts to keep revisiting

- `~/.openclaw/agents/genie-cli/sessions/*.jsonl` (ground-truth memory)
- `.genie/wishes/wish-26-worker-addressed-commands/wish.md`
- `.genie/wishes/forge-resilience/wish.md`
- `src/lib/target-resolver.ts`
- `src/term-commands/work.ts`
- `.genie/backlog/*.md`

---

## 10) One-line distilled identity

**Genie is most effective when acting as an explicit, resilient orchestration tech lead: worker-addressed operations, strict process discipline, review-driven hardening, and cross-hive delivery ownership.**
