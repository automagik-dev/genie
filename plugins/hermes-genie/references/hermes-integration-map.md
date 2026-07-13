# Hermes integration map

The single authoritative Claude / Codex / Hermes parity document for the Genie orchestration
surface. It describes the **TARGET** homogeneous state this wish (`hermes-homogeneous-integration`)
builds — groups 2–6 implement the code; this map is the north star. Every row is tagged
**current** (already shipped) or **target** (this wish's convergence goal). Where they differ,
both are shown so a reader can tell where we are from where we are going.

Companion docs:

- `plugins/genie/references/native-surfaces.md` — cross-client dispatch/isolation/follow-up.
- `plugins/genie/references/codex-integration-map.md` — the Codex-side equivalent this file mirrors.
- `plugins/hermes-genie/references/native-surface.md` — the current Hermes layer map + payload contract.
- `plugins/hermes-genie/references/mutation-gates.md` — the read-only boundary and human-gate rule.

Baseline evidence for the "current" columns lives in
`.genie/wishes/hermes-homogeneous-integration/reports/baseline.md`.

## Shipped surfaces per client

Parity target: Hermes is a first-class client alongside Claude and Codex — same 23 product
skills, same MCP tool set, same agent-sync convergence, same doctor coverage.

| Surface | Claude | Codex | Hermes (current) | Hermes (target) |
|---------|--------|-------|------------------|-----------------|
| Plugin manifest | `.claude-plugin/plugin.json` (Skills, Hooks, MCP) — **current** | `plugins/genie/.codex-plugin/plugin.json` — **current** | `plugins/hermes-genie/plugin.yaml` declares 7 native tools + hooks + commands + 4 skills — **current** | `plugins/hermes-genie/plugin.yaml` declares 3 native tools + MCP + hooks; skills sourced via `skills.external_dirs` — **target** |
| Skills path | canonical `skills/` (23) — **current** | `skills/` canonical + `plugins/genie/skills/` mirror (23) — **current** | 4 plugin-local skills (`genie`, `genie-work`, `genie-review`, `genie-khaw-bridge`) — **current** | the 23 product skills via `skills.external_dirs`; ≤1 thin cockpit adapter via `ctx.register_skill` — **target** |
| Hooks | Claude hook set — **current** | `codex-hooks.json` H3/H4/H6 — **current** | `on_session_start`, `pre_tool_call`, `post_tool_call` (advisory KHAW bridge) — **current** | same advisory hooks, read-only, no mutation — **target** |
| MCP | `.mcp.json` → `genie mcp` (5 read-only tools) — **current** | `plugins/genie/.mcp.json` → `genie mcp` (5 read-only tools) — **current** | none — native tools only — **current** | `genie mcp` wired as the shared 5-tool read-only server — **target** |
| Agent-sync lane | `syncClaude` — **current** | `syncCodex` — **current** | `syncHermes` symlinks `$HERMES_HOME/plugins/genie` → sibling `hermes-genie`, runs `hermes plugins enable genie` — **current** | same lane, now also converging the external skills dir + MCP wiring — **target** |
| Doctor coverage | `agent sync: claude` — **current** | `agent sync: codex` — **current** | `agent sync: hermes — linked → …` — **current** | Hermes lane + MCP + skills-dir checks in `genie doctor` — **target** |

## Tool map

Convergence target: the shared read-only **MCP** server (`genie mcp`) provides the board/wish/task
surface for every client; Hermes keeps only the tools that have no MCP equivalent. **No duplicates** —
a tool is either an MCP tool or a native Hermes tool, never both.

| Kind | Tool | Wraps (read-only) | Status |
|------|------|-------------------|--------|
| MCP (shared) | `genie_board` | `genie board --json` | **target** — provided by `genie mcp` |
| MCP (shared) | `genie_wish_status` | board slice + task list for one slug | **target** — provided by `genie mcp` |
| MCP (shared) | `genie_task` | task list / task detail | **target** — provided by `genie mcp` |
| MCP (shared) | `genie_active` | active wishes/tasks snapshot | **target** — provided by `genie mcp` |
| MCP (shared) | `genie_worktree_context` | resolved worktree/branch/cwd context | **target** — provided by `genie mcp` |
| Native Hermes | `genie_status` | `genie doctor --json` + `.genie/` presence | **target** — remains native |
| Native Hermes | `genie_work_plan` | `genie launch <slug> --dry-run` | **target** — remains native |
| Native Hermes | `genie_review_plan` | board/tasks + Success/QA criteria from WISH.md | **target** — remains native |

**Retired natives** (present in today's `plugin.yaml`, removed by this wish because the MCP tools
replace them — do not re-add): `genie_board`, `genie_wish_status`, `genie_task_list`,
`genie_task_status`.

**Transitional gate:** `GENIE_HERMES_LEGACY_TOOLS=1` re-exposes the retired native tools for one
migration window so a host pinned to the old surface does not break mid-upgrade. It is opt-in,
off by default, and slated for removal once all hosts are on the MCP path. It never changes the
read-only contract — every tool still reports `mutation: "none"`.

Current state (pre-wish): `plugin.yaml` ships all 7 tools natively and there is no MCP server on
the Hermes side. See baseline notes.

## Skill invocation

Target: Hermes drives the **same 23 product skills** as Claude and Codex — no forked skill copies.

- **First-class path — `skills.external_dirs`:** Hermes loads the 23 canonical product skills
  (including `/wish`, `/work`, `/brainstorm`) by pointing `skills.external_dirs` at the shared
  `skills/` root. This is how Hermes gets `/wish`, `/work`, `/brainstorm` and the rest without a
  divergent per-client skill payload. These skills appear in the host's `available_skills` index.
- **`ctx.register_skill` — reserved, ≤1 adapter:** at most **one** thin cockpit adapter may be
  registered programmatically via `ctx.register_skill`. It is **plugin-namespaced** and
  **hidden from the `available_skills` index** (it is an internal bridge, not a user-facing skill).
  It exists only to adapt cockpit affordances to the shared skills; it must not duplicate or shadow
  any of the 23 product skills.

Current state (pre-wish): Hermes ships 4 plugin-local skills in `plugin.yaml` rather than the 23
via `external_dirs`. Convergence to the external-dirs path is a target of this wish.

## Install / update paths

Convergence happens **only** through the canonical Genie lifecycle commands — there is **no** ad-hoc
manual dual system, and no lifecycle hook installs, updates, or synchronizes the Hermes surface.

| Path | Effect on Hermes |
|------|------------------|
| `genie install --integrations hermes` | Runs the `syncHermes` lane: symlinks `$HERMES_HOME/plugins/genie` → sibling `hermes-genie`, converges the external skills dir + MCP wiring, best-effort `hermes plugins enable genie`. |
| `genie update` | Re-runs the same convergence inside the already-reviewed parent process; refreshes the linked surface. |
| `genie setup` / `genie setup --hermes` | Configures + persists Hermes maintenance consent used by later explicit updates. |

Guardrails (inherited from the Codex convergence discipline):

- `--integrations none` mutates no client home.
- No SessionStart / lifecycle hook performs install, update, plugin refresh, or skill sync.
- Do not re-exec a freshly installed older binary for convergence (2026-07-11 downgrade incident).
- The manual `install-local.sh` symlink documented in the README is a dev convenience, not a second
  convergence system — production convergence is `genie install`/`update`/`setup` only.

## Trust / mutation gates

The entire Hermes surface is read-only: every tool, command, hook, and skill reports
`mutation: "none"` and performs no writes under `.genie/`. Mutation-capable operations
(`genie_task_checkout`, `genie_task_done`, executing a real `genie launch`, spawn/send) are
deferred and each individual invocation requires an explicit human-gate packet.

Full rules, the deferred-capability table, the human-gate packet contract, and the four
repo-state facts to verify before approving any mutation live in
**`plugins/hermes-genie/references/mutation-gates.md`**.
