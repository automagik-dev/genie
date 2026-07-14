# Design: Hermes ↔ Genie homogeneous integration

| Field | Value |
|-------|-------|
| **Slug** | `hermes-homogeneous-integration` |
| **Date** | 2026-07-12 |
| **WRS** | 100/100 |

## Problem

Hermes ships only a thin, noisy WIP Genie bridge (symlink + enable, 7 read-only CLI tools, 4 meta-skills, advisory hooks) while Claude Code and Codex get the full homogeneous product surface — 23 shared skills, lifecycle hooks, and MCP task-state. Operators on Hermes experience duplicate tools, missing `/wish`-style workflows, and terminal-scraping fallbacks instead of the same Genie operating model.

## Scope

### IN
- Make the Hermes Genie integration parity-shaped with the Claude/Codex product surfaces: skills + hooks + MCP + install/update convergence
- Deliver the 23 product skills to Hermes via its first-class skill path (`skills.external_dirs` preferred, digest-managed copies as fallback)
- Register `genie mcp` (5 tools: `genie_board`, `genie_wish_status`, `genie_task`, `genie_active`, `genie_worktree_context`) via `mcp_servers.genie` in Hermes config, fail-closed on the canonical binary
- Replace advisory/no-op hooks with a Codex-shaped minimal set: bounded `pre_llm_call` session context + non-blocking `pre_tool_call` scrape guard; delete the dead `post_tool_call`
- Slim `plugins/hermes-genie` native tools to MCP gaps only: `genie_status`, `genie_work_plan`, `genie_review_plan`
- Expand the `agent-sync` hermes lane beyond symlink/enable: plugin link + enable + MCP config + skills path, all covered by `genie doctor`
- Drop `genie-khaw-bridge` from the product hermes-genie payload (re-home to KHAW plugin ownership)
- Align `plugin.yaml` version with the Genie `VERSION` file

### OUT
- Replacing Genie SQLite truth (`genie.db`) with Hermes Kanban
- Shipping mutation tools (`task checkout/done`, live `launch`) without human-gate packets — read-only boundary stays
- Merging hermes-genie into Nous core (stays a standalone product plugin)
- Making Hermes impersonate Claude Code (no fake Agent tool names in skills)
- Auto-trust of hooks where Hermes requires operator consent
- Porting Claude Stop/PostToolUse wish validators 1:1 before MCP+skills land
- Shipping Codex role-agent TOMLs into Hermes profiles

## Approach

**Homogeneous product triangle for Hermes — the same Skills + Hooks + MCP shape Codex ships — with `hermes-genie` reduced to a thin native adapter and `agent-sync` as the single convergence engine.**

```
Genie source of truth
  skills/  (23 product)  ──agent-sync──► Hermes skills.external_dirs or managed copies
  genie mcp (5 tools)    ──agent-sync──► mcp_servers.genie in config.yaml
  hermes-genie adapter   ──agent-sync──► plugins/genie symlink + enable
  hooks (session+guard)  ──in hermes-genie──► pre_llm_call + pre_tool_call
```

Alternatives considered and rejected:
- **Grow the native plugin into a parallel product** (more native tools, more meta-skills, `ctx.register_skill` for everything): rejected because plugin-registered skills are namespaced `plugin:skill` and hidden from the available_skills index — `/wish`-style discovery is impossible, and the dual native/MCP tool surface is exactly the noise being removed.
- **Copy all 23 skills into `$HERMES_HOME/skills/` as the primary path**: rejected as primary because `skills.external_dirs` gives live updates from the release-synced tree without 23 duplicated trees; copying survives only as a digest-managed fallback for older Hermes versions.
- **Skip MCP and keep the 7 native CLI wrapper tools**: rejected because Claude/Codex already consume the same `genie mcp` server; native wrappers duplicate it with drifting names and no shared contract.

Each unit is independently testable: config-merge helpers (`hermes-mcp-config.ts`, `hermes-skills-config.ts`) are pure idempotent YAML transforms with their own bun tests; the `pre_llm_call` hook is a bounded pure function over a repo snapshot with pytest coverage; agent-sync composes them behind one lane function; doctor only reads.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Primary structured state = **Genie MCP** (same 5 tools as Claude/Codex), registered via `mcp_servers.genie` config, fail-closed on the canonical `$GENIE_HOME/bin/genie` binary | One shared server and contract across all three clients; Hermes has no plugin MCP-register API — config is the supported path |
| 2 | Primary workflows = **23 product skills** delivered through Hermes' first-class skill path (`skills.external_dirs` preferred; digest-managed copies fallback) | `ctx.register_skill` is plugin-namespaced and hidden from the available_skills index — first-class `/skill-name` discovery requires external_dirs or real skill dirs |
| 3 | `ctx.register_skill` only for at most one thin Hermes cockpit adapter skill | Product skills must not depend on plugin registration; adapter covers Hermes-specific mapping only |
| 4 | Native tools slim to MCP gaps: `genie_status` (doctor), `genie_work_plan` (`launch --dry-run`), `genie_review_plan` (WISH.md criteria); board/task natives retired (optionally one release behind `GENIE_HERMES_LEGACY_TOOLS=1`) | Duplicate native+MCP tools with the same job confuse the model and double the schema surface |
| 5 | Hooks: `pre_llm_call` injects a bounded board/wish snapshot (≤ 8 lines / ≤ 2 KiB, Codex H3 bounds) only when `.genie/` is present; `pre_tool_call` stays a non-blocking scrape advisory; dead `post_tool_call` removed | `pre_llm_call` is Hermes' real session-context hook; unbounded injection burns tokens; a declared no-op hook is pure noise |
| 6 | `genie-khaw-bridge` leaves the hermes-genie product payload; ownership moves to the KHAW plugin | Felipe/KHAW-specific glue is not Genie product; shipping it to every operator is noise |
| 7 | `agent-sync` hermes lane converges all three legs (plugin link+enable, MCP config, skills path) idempotently, with backup-first config writes and sticky-profile-aware config path resolution | One explicit `genie install`/`genie update` convergence path, matching the Codex lane contract; never clobber unrelated config keys |
| 8 | `plugin.yaml` version tracks Genie `VERSION` (e.g. `5.260712.2`) at release time | Claude/Codex manifests already pin the release version; eternal `0.1.0` defeats doctor version checks |
| 9 | Doctor expands to prove all three legs (link, MCP command exists + executable, skills dir present/count) rather than symlink-only | "Installed" must mean the homogeneous surface, not one leg of it |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Dual tool surfaces during transition confuse the model (native + MCP same names) | Medium | Retire overlapping natives (optional one-release legacy flag); single tool map documented in `hermes-integration-map.md`; confirm Hermes MCP tool-name prefixing during Task 1–3 |
| 2 | `ctx.register_skill` hides skills from the index | High (design-invalidating if ignored) | Use `skills.external_dirs` / managed skill dirs as the product path; plugin registration only for the thin adapter |
| 3 | Mutating `~/.hermes/config.yaml` from agent-sync is invasive | Medium | Idempotent merge touching only `mcp_servers.genie` and the one skills entry; backup before write; never delete user entries |
| 4 | Sticky Hermes profile (`active_profile`) loads config/skills from the profile home, not `$HERMES_HOME` | Medium | Resolve the live profile home the same way the existing plugin-link lane already does; write that profile's `config.yaml`; test explicitly on the isit profile |
| 5 | Skill prose contains Claude/Codex-specific verbs | Low | Skills stay runtime-neutral; Hermes mapping lives in the integration map; thin overlay skill only if needed |
| 6 | Hook injection token cost | Low | Hard caps mirroring Codex H3 (≤ 8 wish/task lines, ≤ 2 KiB); inject nothing on failure; never block |
| 7 | `$GENIE_HOME/skills` may not exist as a stable populated path on hosts (open question 1) | Medium | Resolve during Tasks 1–3: verify release layout; if absent, agent-sync publishes the product skills to a stable absolute path before external_dirs points at it |
| 8 | aarch64/OrbStack binary quirks pick a wrong `genie` | Low | Fail-closed launcher: absolute canonical binary, no shell string, no PATH hunting |

Assumptions: Hermes `skills.external_dirs` is available on the target Hermes version (fallback exists if not); `genie mcp` stdio server behaves identically regardless of the invoking client; the read-only mutation boundary (`mutation-gates.md`) stays authoritative for phase 2.

## Success Criteria

- [ ] After `genie update` / agent-sync on a host with Hermes: plugin linked+enabled, `mcp_servers.genie` present and probeable, product skills visible in `hermes skills list` and invocable `/wish`-style
- [ ] In a Hermes session inside a `.genie/` repo: bounded Genie context arrives without terminal scraping; the model prefers MCP/native structured tools over `tmux capture-pane`
- [ ] Product skill count parity with the Claude/Codex payload (23 skills), not only hermes meta-skills
- [ ] No KHAW-specific skill in product hermes-genie
- [ ] `genie doctor` reports hermes skills + MCP + plugin link health, not only the symlink
- [ ] Contract tests + smoke green: plugin register, MCP config merge (incl. dry-run/idempotency), skill discovery, hook injection unit tests (bun + pytest)
- [ ] Mutation boundary intact: no task checkout/done/launch without a human gate

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `505eab85bc29d2a878a69147a77a5e3fc1244081dc4c5763c3546ccd5482c772`
- **Reviewer:** genie:reviewer/design-review-hermes-homogeneous-integration
- **Reviewed at:** 2026-07-13T00:53:12.000Z
<!-- genie-design-review:end -->
