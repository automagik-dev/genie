# Wish: Genie CLI Teams — Provider-Selectable Genie Orchestration

**Status:** DRAFT
**Slug:** `genie-cli-teams`
**Created:** 2026-02-24

---

## Problem

Current orchestration can drift into provider-native coordination, but we need a Genie-owned orchestration core with explicit per-worker provider selection (`claude` or `codex`) over tmux.

---

## Summary

Build a `genie`-first orchestration stack (`team/task/worker/msg/term`) where Genie owns mailbox, protocol routing, worker state, and task coupling. Worker launch is provider-selectable per worker with fixed adapters: Claude routes roles through `--agent`, and Codex loads `$skill` instructions for task behavior. Runtime transport stays tmux-only, with mosaic/tiled layout as the default for readability.

---

## Dependencies

- **depends-on:** `none`
- **blocks:** `none`

---

## Scope

### IN
- `genie` single-entry CLI namespaces: `team`, `task`, `worker`, `msg`, `term`
- tmux-only worker runtime and pane orchestration
- Per-worker provider selection: `genie worker spawn --provider <claude|codex>`
- Fixed built-in provider adapters (no arbitrary shell adapter)
- Claude adapter uses public CLI surface with `--agent <role>`
- Codex adapter uses public CLI surface with `$skill` instructions as the task contract
- Worker registry persists provider + transport metadata
- Mailbox-first messaging and protocol routing owned by Genie
- Default mosaic/tiled layout, optional vertical compatibility flag
- New `genie-pilot` skill as canonical orchestration skill

### OUT
- Standalone `term` backward-compat alias/wrapper
- Hidden/internal provider teammate flags as runtime dependencies
- Provider-native orchestration ownership (Teams/Codex-native routing)
- Non-tmux transports (`auto`, `in-process`, non-tmux backends)
- Arbitrary user-defined shell command adapters for providers
- Rewriting beads internals

---

## Decisions

- **DEC-1:** Keep one entrypoint (`genie`), with `genie term` as namespaced low-level tmux operations. Rationale: no split command surface.
- **DEC-2:** Provider is selected per worker (`--provider`) with fixed adapter implementations. Rationale: flexibility without unbounded adapter drift.
- **DEC-3:** Claude adapter binds role-specific behavior using public `claude --agent <role>`. Rationale: explicit role routing without hidden internal flags.
- **DEC-4:** Codex adapter binds behavior using `$skill` instructions at spawn; `--role` is advisory metadata only. Rationale: skill-driven contract fits Codex CLI surface.
- **DEC-5:** Genie owns orchestration semantics (mailbox, protocol router, worker state, task coupling) independent of provider. Rationale: consistent behavior across providers.
- **DEC-6:** tmux-only runtime with default mosaic/tiled layout (vertical opt-in). Rationale: deterministic transport and better human readability at higher worker counts.
- **DEC-7:** Mailbox-first delivery with state-aware queueing before pane injection. Rationale: durability plus safer delivery under active output.

---

## Success Criteria

- [ ] `genie worker spawn --provider claude --team work --role implementor` launches worker and records provider metadata
- [ ] Claude launches through public role routing (`--agent implementor`) with no hidden teammate flags
- [ ] `genie worker spawn --provider codex --team work --skill work --role tester` launches worker and records provider metadata
- [ ] Codex workers receive `$skill` instructions at spawn and do not depend on agent-name routing
- [ ] Worker registry stores `provider`, `transport`, `session`, `window`, and `paneId`
- [ ] `genie msg send --to <worker>` writes mailbox entries and pushes delivery for both provider-backed workers
- [ ] Default worker layout is mosaic/tiled; vertical layout only applies when explicitly requested
- [ ] Invalid provider or invalid provider-specific argument combinations fail fast with actionable errors
- [ ] `genie-pilot` skill exists and documents provider selection + Genie-owned orchestration boundary

---

## Assumptions

- **ASM-1:** Claude environments expose a usable `--agent` path for configured agent roles.
- **ASM-2:** Codex environments can reliably execute skill-driven instruction payloads for worker behavior.
- **ASM-3:** tmux is available on target environments where orchestration runs.
- **ASM-4:** Existing worker/task libraries are reusable with focused refactors.

## Risks

- **RISK-1:** Provider CLI flags/semantics evolve and break adapters. Mitigation: adapter tests + versioned launch builders.
- **RISK-2:** Skill definition drift degrades Codex worker behavior. Mitigation: explicit skill contract in `genie-pilot` and validation checks.
- **RISK-3:** Message injection can garble during active output. Mitigation: mailbox-first writes + state-aware queued delivery.
- **RISK-4:** Operator confusion from per-worker provider differences. Mitigation: strict argument validation + clear dashboard metadata.

---

## Execution Groups

### Group A: CLI Surface + Contract Validation

**Goal:** Add explicit worker spawn contract for provider/role/skill selection under `genie`.

**depends-on:** `none`  
**blocks:** `B, C, D, E, F`

**Deliverables:**
- `genie worker spawn` accepts `--provider`, `--role`, and `--skill` (provider-aware validation rules)
- Invalid combinations rejected (for example missing `--skill` for Codex path)
- Updated CLI help for provider-aware worker commands

**Acceptance Criteria:**
- [ ] `genie worker spawn --help` documents provider/role/skill flags
- [ ] Invalid provider values fail with actionable error
- [ ] Invalid provider-specific argument combinations fail before spawn

**Validation:** `genie worker spawn --help | rg -n 'provider|role|skill'`

---

### Group B: Team Model + Blueprint Defaults

**Goal:** Keep team lifecycle and blueprints compatible with per-worker provider metadata.

**depends-on:** `A`  
**blocks:** `C, D, E, F`

**Deliverables:**
- Team CRUD stays intact under `genie team`
- Blueprint schema supports role descriptors that can inform spawn defaults (without forcing team-level provider lock)
- Team config persists role metadata used by worker spawn UX

**Acceptance Criteria:**
- [ ] `genie team create work-team --blueprint work` creates a valid team config
- [ ] `genie team list` shows team presence and member/role info
- [ ] `genie team delete work-team` succeeds when no workers are active

**Validation:** `genie team create work-team --blueprint work && genie team list && genie team delete work-team`

---

### Group C: Provider Adapters (Claude + Codex)

**Goal:** Implement fixed provider launch adapters with explicit role/skill contracts.

**depends-on:** `A, B`  
**blocks:** `D, E, F`

**Deliverables:**
- `src/lib/provider-adapters.ts` (or equivalent) with `claude` and `codex` launch builders
- Claude adapter uses public CLI role routing (`--agent <role>`)
- Codex adapter injects `$skill` instructions as task contract; role remains metadata
- Preflight checks for provider binaries (`claude`, `codex`)
- Unit tests for adapter command construction and invalid argument combinations

**Acceptance Criteria:**
- [ ] Claude adapter launch path includes `--agent <role>` and excludes hidden teammate flags
- [ ] Codex adapter requires `--skill` and produces skill-driven launch payload
- [ ] Preflight failures return actionable errors per provider

**Validation:** `bun test src/lib/provider-adapters.test.ts`

---

### Group D: Tmux Worker Runtime + Layout

**Goal:** Run provider-backed workers in tmux with stable lifecycle and readable default layout.

**depends-on:** `A, B, C`  
**blocks:** `E, F`

**Deliverables:**
- Worker spawn/list/kill/shutdown hooks wired through adapter output into tmux panes
- Worker registry persists `provider`, `transport`, `session`, `window`, `paneId`, `role`, and `skill` metadata
- Mosaic/tiled default layout with optional vertical compatibility flag
- Spawn preflight errors for missing tmux/session constraints

**Acceptance Criteria:**
- [ ] Spawned workers from both providers appear in `genie worker list` with provider metadata
- [ ] Default layout is mosaic/tiled without specifying a layout flag
- [ ] Vertical layout activates only when explicitly requested
- [ ] Shutdown removes pane and updates registry cleanly

**Validation:** `genie worker list && jq '.workers[] | {provider,transport,session,window,paneId,role,skill}' ~/.config/genie/workers.json`

---

### Group E: Mailbox + Protocol Router

**Goal:** Keep mailbox/protocol behavior consistent across provider-backed workers.

**depends-on:** `A, B, C, D`  
**blocks:** `F`

**Deliverables:**
- Durable mailbox store and unread/read semantics
- Protocol router remains Genie-owned and provider-agnostic
- State-aware queued delivery before tmux injection
- Delivery receipts/visibility in worker message history

**Acceptance Criteria:**
- [ ] Messages persist to mailbox before push delivery for all providers
- [ ] Mid-turn workers receive queued delivery when idle
- [ ] `genie msg inbox <worker>` reflects accurate message history

**Validation:** `genie msg send --to implementor 'ping' && genie msg inbox implementor`

---

### Group F: Integration + Genie Pilot Skill

**Goal:** Ship cohesive orchestration UX with task integration and skill docs.

**depends-on:** `A, B, C, D, E`  
**blocks:** `none`

**Deliverables:**
- `genie task` integration remains dependency-aware (`ready` vs `blocked`)
- Unified worker dashboard includes provider metadata and message/task visibility
- Create `skills/genie-pilot/SKILL.md` as canonical orchestration skill
- Document provider contract:
  - Claude uses `--agent <role>`
  - Codex uses `$skill` task instructions
  - Genie owns orchestration state/protocol

**Acceptance Criteria:**
- [ ] `genie task list` differentiates ready and blocked tasks
- [ ] Dashboard surfaces provider + worker state + task + message context
- [ ] `skills/genie-pilot/SKILL.md` documents provider contracts and boundaries

**Validation:** `genie task list && genie worker dashboard && test -f skills/genie-pilot/SKILL.md`

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```text
# New files
src/genie.ts
src/lib/provider-adapters.ts
src/lib/mosaic-layout.ts
src/lib/mailbox.ts
src/lib/protocol-router.ts
src/lib/team-manager.ts
src/lib/provider-adapters.test.ts
.genie/teams/work.json
.genie/teams/dream.json
.genie/teams/review.json
.genie/teams/fix.json
.genie/teams/debug.json
skills/genie-pilot/SKILL.md

# Modified files
src/term.ts
src/lib/worker-registry.ts
src/term-commands/work.ts
src/term-commands/workers.ts
src/term-commands/orchestrate.ts
src/term-commands/task/commands.ts
package.json
```
