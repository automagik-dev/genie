# Brainstorm: Hermes ↔ Genie homogeneous integration

**Slug:** hermes-homogeneous-integration  
**Status:** Raw → Ready (WRS 100)  
**Date:** 2026-07-12  
**Sources:** dedicated clone `.scratch/genie-hermes-plugin-plan`, Hermes plugin/MCP/hooks/skills docs, Claude+Codex plugin surfaces

## Problem

Hermes has a WIP native Genie plugin (`plugins/hermes-genie`) that is a thin read-only CLI bridge. Claude Code and Codex already get a **homogeneous product surface**: shared skills, lifecycle hooks, and MCP task-state. Hermes only gets a symlink + enable + 4 meta-skills + advisory hooks. Operators experience noise (duplicate tools, incomplete workflows, no `/wish`/`/brainstorm` product path) instead of the same Genie operating model.

## Scope

### IN
- Make Hermes Genie integration parity-shaped with Claude/Codex product surfaces (skills + hooks + MCP + install/update convergence)
- Deduplicate noise between native tools, MCP tools, and skills
- Expand `agent-sync` hermes lane beyond symlink/enable
- Align plugin version/doctor checks with Genie releases
- Preserve read-only mutation gates for task claim/done/launch until explicit human-gated phase

### OUT
- Replacing Genie SQLite truth with Hermes Kanban
- Shipping mutation tools without human-gate packets
- Merging hermes-genie into Nous core (stays standalone product plugin)
- Making Hermes pretend to be Claude Code (no fake Agent tool names in skills)
- Auto-trust of hooks without operator consent where Hermes requires it

## Decisions

1. **Primary structured state = Genie MCP** (`genie mcp` → tools `genie_board`, `genie_wish_status`, `genie_task`, `genie_active`, `genie_worktree_context`). Same server Claude/Codex use. Hermes registers via `mcp_servers.genie` (config), fail-closed on non-canonical binary.
2. **Primary workflows = product skills** (23 under `skills/` / `plugins/genie/skills/`). Hermes must load them as **first-class skills** (system prompt index + `/skill-name`), not only as read-only `plugin:skill` (which are hidden from the available_skills index).
3. **Skill delivery mechanism for Hermes:** prefer `skills.external_dirs` pointing at the release-synced product skill tree under `$GENIE_HOME` (or plugin skills mirror), managed by `genie-agent-sync`. Fallback: digest-managed copies into `$HERMES_HOME/skills/genie/*` if external_dirs is unavailable on older Hermes. Do **not** rely solely on `ctx.register_skill` for product skills.
4. **Native `plugins/hermes-genie` tools slim down** to MCP-gap / operator CLI only: keep `genie_status` (doctor), `genie_work_plan` (launch --dry-run), `genie_review_plan` (WISH.md criteria). Drop or demote duplicates of MCP board/task tools from the always-on tool schema to cut noise.
5. **Hooks:** replace no-op/noisy advisories with Codex-shaped minimal set:
   - Session context: `pre_llm_call` injects bounded board/wish snapshot when `.genie/` present (parity to `session-context.cjs`)
   - Guardrails: `pre_tool_call` advisory (or soft block only for clearly unsafe scrape patterns if Hermes blocking is opted-in later)
   - Remove dead `post_tool_call` passthrough until there is a real evidence footer
6. **KHAW bridge skill is not product Genie.** Move ownership to KHAW plugin; stop shipping `genie-khaw-bridge` as part of hermes-genie product payload.
7. **agent-sync hermes lane expands** to: link plugin, enable plugin, ensure MCP config, ensure skills external_dir (or copies), doctor checks for all three.
8. **Version:** `plugin.yaml` version tracks Genie `VERSION` (e.g. `5.260712.2`), not permanent `0.1.0`.

## Risks

| Risk | Mitigation |
|------|------------|
| Dual tool surfaces confuse the model (native + MCP same names) | Name MCP tools as shipped; rename/retire overlapping native tools; document single map |
| `ctx.register_skill` hides skills from index | Use external_dirs / skills dir convergence instead of plugin-only register |
| MCP config mutation of `~/.hermes/config.yaml` is invasive | Idempotent merge under `mcp_servers.genie` only; backup before write; never clobber unrelated keys |
| Sticky Hermes profile (`active_profile`) loads plugins/skills from profile home | agent-sync must target sticky profile HERMES_HOME resolution (already partially done for plugin link) |
| Skill content uses Claude/Codex-specific verbs | Keep runtime-neutral skill prose; Hermes mapping table in `native-surfaces.md` + thin Hermes overlay skill only if needed |
| Hook injection token cost | Bound like Codex H3: max wishes/bytes; first-turn or when `.genie/` present |
| aarch64 OrbStack binary issues | Keep using release `genie` + profile-local aarch64 hermes bins; no x86 uv/tirith |

## Criteria (acceptance)

1. After `genie update` / agent-sync on a host with Hermes: plugin linked+enabled, MCP `genie` present and probeable, product skills visible in `hermes skills list` / `/wish` style invocation path.
2. In a Hermes session inside a `.genie/` repo: session gets bounded Genie context without terminal scraping; model prefers MCP/native structured tools over `tmux capture-pane`.
3. Product skill count parity with Claude/Codex product payload (23 skills), not only 4 hermes meta-skills.
4. No KHAW-specific skill in product hermes-genie.
5. Doctor reports hermes skills + MCP + plugin link health, not only symlink.
6. Contract tests + smoke: register, MCP config dry-run, skill discovery, hook injection unit tests.
7. Mutation boundary remains: no task checkout/done/launch without human gate.

## Recommended approach

**Homogeneous product triangle for Hermes (same as Codex): Skills + Hooks + MCP**, with `hermes-genie` as the thin Hermes-native adapter + agent-sync convergence — not a parallel incomplete product.

```
Geniesource of truth
  skills/  (23 product)  ──agent-sync──► Hermes skills.external_dirs or managed copies
  genie mcp (5 tools)    ──agent-sync──► mcp_servers.genie in config.yaml
  hermes-genie adapter   ──agent-sync──► plugins/genie symlink + enable
  hooks (session+guard)  ──in hermes-genie──► pre_llm_call + pre_tool_call
```

## WRS

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

Ready to pour into an implementation plan (Hermes `/plan` artifact).
