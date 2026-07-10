# Codex integration map — documented surfaces vs genie PR

Synthesized 2026-07-10 from three research passes (config/runtime, skills/prompts/extensibility, automation/programmatic) against the live official docs (`developers.openai.com/codex/*`, which 308-redirect to `learn.chatgpt.com/docs/*` — same corpus) and the `openai/codex` source (codex-rs, main branch, read 2026-07-10). PR under comparison: `feat(codex): add first-class runtime integration` (this worktree).

Headline: **the PR's core Codex surfaces are real** — the plugin manifest, hooks file, custom-agent TOMLs, and plugin CLI calls all match documented mechanisms, most field-for-field. Three things the PR carries are NOT documented Codex surfaces (section 2) and are correctness risks for review. The PR covers the *extensibility* surface well but touches almost none of the *automation* surface (section 3).

---

## 1. Verified surface table

Status legend: **used** = PR exercises it per spec · **partial** = exercised with gaps or unverified details · **unused** = documented, untouched by the PR · **INVENTED** = the PR relies on it but Codex does not document it.

### Config (`~/.codex/config.toml`)

| Surface | Doc | PR status |
|---|---|---|
| `[plugins."<name>@<marketplace>"] enabled` toggle | https://developers.openai.com/codex/config-reference | **used** — `setCodexPluginEnabled` writes the documented shape verbatim; preserves user-disabled state across refresh |
| `[otel]` exporter tables | https://developers.openai.com/codex/config-reference | **used (retirement)** — `migrateDeadGenieOtel` removes only genie's exact old exporter line, backed up first; deliberate contract change (hooks replace OTel as genie's state signal — verify the replacement actually lands) |
| `CODEX_HOME` root | config docs throughout | **used** — `getCodexHome()` honors it |
| `mcp_servers.<id>` (`required`, `default_tools_approval_mode`, `enabled_tools`) | https://developers.openai.com/codex/config-reference | **partial** — server registered via plugin manifest; `required = true` and approval-mode tuning unused |
| `--sandbox` flag / `sandbox_mode` values | https://developers.openai.com/codex/cli/reference | **used** — `launch.ts` passes `--sandbox workspace-write`; agent TOMLs use documented values. Gap: `launch.ts` silently drops the model pin (`_model` unused; `-m/--model` exists) |
| `notify = ["cmd", ...]` external notification command | https://developers.openai.com/codex/config-reference | **unused** |
| `shell_environment_policy` (`inherit`/`set`/...) | https://developers.openai.com/codex/config-reference | **unused** |
| `projects.<path>.trust_level`, project `.codex/config.toml` | https://developers.openai.com/codex/config-reference | **unused** |
| `[agents]` global knobs (`max_threads` default 6, `max_depth`, `job_max_runtime_seconds`, `interrupt_message`) | https://developers.openai.com/codex/config-reference | **unused** — genie waves wider than 6 silently queue |
| `[features]` flags (`hooks` default true, `multi_agent`, ...) | https://developers.openai.com/codex/config-reference | **unused** (defaults suffice today) |
| `requirements.toml` managed hooks / enterprise controls | https://developers.openai.com/codex/config-reference, /codex/hooks | **unused** — the only path to auto-trusted (fail-closed-parity) hooks |
| Model/provider/reasoning/history/TUI/profiles keys | https://developers.openai.com/codex/config-reference | **unused** (mostly n/a) |

### Plugins & marketplace

| Surface | Doc | PR status |
|---|---|---|
| `.codex-plugin/plugin.json` manifest (name/version/description/skills/hooks/interface.*) | https://developers.openai.com/codex/plugins/build | **used** — field-accurate |
| Inline `mcpServers` object in manifest | build docs + codex-rs `plugin/src/manifest.rs` (`PluginManifestMcpServers::Object`) | **used** — valid; docs lead with the `.mcp.json` pointer, but the inline map is accepted per source |
| `skills` component (`"./skills/"`) | https://developers.openai.com/codex/plugins/build | **partial** — `plugins/genie/skills` is a symlink to `../../skills`, escaping the plugin root; docs require component paths to "stay within plugin root". Whether install follows/rejects/dangles the symlink is undocumented — must be tested; a rejected copy means the plugin ships zero skills |
| Plugin `hooks/hooks.json` auto-detected path | https://developers.openai.com/codex/plugins/build, /codex/hooks | **used** |
| `.agents/plugins/marketplace.json` (repo + `~/.agents/plugins/`) | build docs + codex-rs `core-plugins/src/loader.rs` | **used** — real path and schema (`source: local`, `policy.installation`) |
| `codex plugin add\|list\|remove`, `codex plugin marketplace add\|list\|upgrade\|remove` (`--json`) | https://developers.openai.com/codex/cli/reference + codex-rs `cli/src/{plugin_cmd,marketplace_cmd}.rs` | **used** — `list --json` `{installed:[{pluginId,enabled,...}]}` parse matches serde camelCase in source; the `enabled` field and `--json` on `marketplace add` are plausible-not-doc-quoted — one live smoke test settles it |
| Plugin `apps` (`.app.json`) | build docs | **unused** (n/a) |
| Plugin hook env `PLUGIN_ROOT`/`PLUGIN_DATA` (+ `CLAUDE_PLUGIN_ROOT` compat aliases) | https://developers.openai.com/codex/hooks | **used** — `${PLUGIN_ROOT}` in commands; `session-context` keys output mode off it |
| Constraint: plugins CANNOT ship agents/subagents | https://learn.chatgpt.com/docs/build-plugins | **respected** — but `interface.capabilities` lists "Subagents", overclaiming: a `/plugins`-only install gets no `genie_*` agents (they arrive only via genie's CLI copy step) |

### Hooks

| Surface | Doc | PR status |
|---|---|---|
| Events used: SessionStart, PreToolUse, PermissionRequest, PostToolUse, UserPromptSubmit, Stop | https://developers.openai.com/codex/hooks | **used** — 6 of 10 documented events |
| Events unused: `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact` | same | **unused** — highest-value omissions (see §3) |
| PreToolUse output `permissionDecision: allow\|deny` (+`permissionDecisionReason`, `additionalContext`) | same | **used** — adapter strips Claude's `ask` to empty output → falls through to Codex's own approval flow. Docs disagree across pages on whether Codex PreToolUse accepts `ask`; stripping is the safe/defensible choice either way — deserves a code comment |
| PreToolUse `updatedInput` rewrite | same | **unused** — Codex-only power Claude lacks |
| PermissionRequest output `{hookSpecificOutput:{decision:{behavior:allow\|deny}}}` | same | **used** — schema-exact. Gap: deny omits the documented optional `message`, so omni denials surface with no explanation (one-line fix) |
| Matchers (regex on canonical tool names: `Bash`, `apply_patch` with aliases `Edit`/`Write`, `mcp__server__tool`) | same | **partial** — matcher also includes `Read` and `SendMessage`, which are NOT documented Codex tool names (see §2); `mcp__genie__.*` convention plausible but unverified against live Codex |
| `timeout` in **seconds** (default 600) | same | **used** — PR values 5–120s correct |
| Hook trust model: non-managed hooks (incl. plugin-bundled) require explicit `/hooks` review, SHA-recorded, invalidated on edit; infra failures are allow-by-default (nonzero exit → Codex continues) | same | **UNHANDLED** — biggest correctness risk. Until the user trusts genie's hooks, the entire guard chain (branch-guard, freshness, omni-approval) is silently inert on Codex; no doctor check, no install nudge. Genie's Claude-side fail-closed guarantee does not transfer |

### Subagents (custom agents)

| Surface | Doc | PR status |
|---|---|---|
| `~/.codex/agents/*.toml` (required `name`/`description`/`developer_instructions`; optional `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`, any config key — agent files are config layers) | https://developers.openai.com/codex/subagents | **used** — `installCodexAgents()` copies `genie-*.toml` from the genie-private staging dir `plugins/genie/codex-agents/` (a genie convention Codex never reads) into the real surface; `# Managed by Genie.` sentinel gates removal. All fields documented. Correct workaround for the no-plugin-agents rule |
| Project-scoped `.codex/agents/*.toml` | same (caveat: openai/codex#15250 visibility issue) | **unused** — genie roles are machine-global instead of repo-versioned |
| Agent-TOML config layering (e.g. `shell_environment_policy.set` per role) | subagents + config-reference | **unused** |
| `spawn_agents_on_csv` batch tool | subagents (experimental) | **unused** (correctly — experimental) |

### Skills

| Surface | Doc | PR status |
|---|---|---|
| User tier `~/.agents/skills`; repo `.agents/skills` (scanned CWD→root); admin `/etc/codex/skills` | https://developers.openai.com/codex/skills | **used** — agent-sync targets the user tier `~/.agents/skills` (manifest-managed; the invented `.curated` lane below is retired and migrated away on sync) |
| `$CODEX_HOME/skills` root | codex-rs `core-skills/src/loader.rs` | **partial/deprecated** — source marks it "Deprecated user skills location … kept for backward compatibility"; hidden subdirectories are pruned (`HiddenDirectoryPolicy::Skip`, regression test `skips_hidden_and_invalid`) |
| `~/.codex/skills/.curated/` as a discovery path | — none — | **INVENTED** (see §2) — fixed: retired legacy lane, one-time backup+migration to `~/.agents/skills` on sync |
| Skill `agents/openai.yaml` (`dependencies.tools`, `policy.allow_implicit_invocation`) | https://developers.openai.com/codex/skills | **unused** |
| Custom prompts `~/.codex/prompts/*.md` | https://developers.openai.com/codex/custom-prompts (**deprecated** — use skills; breakage ≥0.117.0: openai/codex#15941) | **correctly unused** |

### AGENTS.md & automation

| Surface | Doc | PR status |
|---|---|---|
| AGENTS.md chain (`~/.codex/AGENTS(.override).md` → git-root-down, 32 KiB `project_doc_max_bytes`, closer-to-cwd wins) | https://developers.openai.com/codex/guides/agents-md | **unused** — PR uses UserPromptSubmit re-injection instead |
| `codex exec` (`--json` JSONL events, `resume --last/<id>`, `--output-last-message`, `--output-schema`, `--ephemeral`, `CODEX_API_KEY`) | https://developers.openai.com/codex/noninteractive, openai/codex `docs/exec.md` | **unused** — the largest untouched surface |
| TypeScript SDK `@openai/codex-sdk` (threads, `runStreamed`, `outputSchema` via zod) | https://developers.openai.com/codex/sdk | **unused** |
| `codex mcp-server` (Codex AS an MCP server) | https://developers.openai.com/codex/cli/reference | **unused** |
| Cloud tasks (`codex cloud exec --attempts`, `codex apply`), GitHub `@codex review`, `openai/codex-action` | https://developers.openai.com/codex/cloud, /codex/integrations/github | **unused** |
| Sessions store `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `codex resume`, archive/delete | config-reference + developer-commands | **partial** — `src/lib/codex-logs.ts` parses Codex JSONL; verify against the current dated-directory layout |

---

## 2. Invented / undocumented surfaces — review-phase flags

These are things the PR (or code it retains) relies on that Codex does **not** document. Wrong assumptions here fail silently.

1. **`~/.codex/skills/.curated/` skills lane — INVENTED, and provably invisible to current Codex.** `.curated` is the *catalog layout of the github.com/openai/skills repo*, not a discovery path; the catalog's own installer copies to `$CODEX_HOME/skills/<name>` top-level. Two kill shots from codex-rs main: (a) skill discovery prunes hidden directories (`HiddenDirectoryPolicy::Skip` in `core-skills/src/loader.rs`; regression test `skips_hidden_and_invalid`), so everything under `.curated/` is never loaded; (b) the parent root `$CODEX_HOME/skills` is itself marked deprecated in source — the live user tier is `~/.agents/skills`. `src/lib/agent-sync.ts` still syncs to `join(codexDir, 'skills', '.curated')` and squats next to OpenAI's reserved `.system/`. With the plugin now shipping `"skills": "./skills/"`, the `.curated` lane is a dead duplicate. Fix direction: rely on plugin skills when installed; fall back to `~/.agents/skills/<name>` for CLI-only installs; keep the `.genie-sync.json` marker + backup discipline, change only the target.
2. **PreToolUse matcher tokens `Read` and `SendMessage` — not documented Codex tool names.** Documented canonical names: `Bash`, `apply_patch` (matcher aliases `Edit`, `Write`), `mcp__server__tool`. As regex alternatives they are harmless dead entries (and valid on the Claude side of the shared file), but any genie handler semantics keyed on intercepting Read/SendMessage get **zero events on Codex** — file reads arrive as `Bash` with different `tool_input` shapes, and the hook-visible names of the multi-agent send/spawn tools are undocumented. Verify empirically what `tool_name` values Codex emits (including whether `mcp__genie__.*` matches genie's MCP tools) and confirm dispatched handlers parse Codex-shaped `tool_input`.
3. **"Native follow-up messaging" to Codex subagents (`references/native-surfaces.md`) — not a documented surface.** Docs cover spawning, `[agents]` limits, and `interrupt_message`; no follow-up-message API to a running subagent is documented (`features.multi_agent` lists spawn/send/resume/wait/close *tools*, whose contracts are not in the public docs). Soften the claim or verify live. Same file also says `genie-*` where the actual agent `name`s are `genie_*` (cosmetic drift).

Adjacent review items (not invented, but unverified or lossy — carried here so the review phase sees one list): hook-trust gate unhandled (§1 Hooks — the single biggest behavioral risk); `plugins/genie/skills` symlink vs the stay-inside-plugin-root rule; `codex plugin list --json` `enabled` field and `marketplace add --json` not doc-quoted (smoke-test live); deny-without-`message` in `codexPermissionDecision`; `launch.ts` dropping the model pin; OTel retirement needs its hooks-based replacement confirmed landed. Explicitly NOT invented: `codex-agents/` staging dir (genie-private convention, correctly compensated by copy-install) and the inline `mcpServers` manifest object (valid per codex-rs source).

---

## 3. Unexploited opportunities — follow-up wish candidates (NOT scope for this PR)

Ranked by leverage; each sketch cites the documented surface it builds on.

1. **Headless Codex workers: `codex exec --json` + `exec resume` (+ `--output-schema`).** Today Codex is a *skin* for genie, not a *worker* genie can drive. Sketch: wave dispatch spawns `codex exec --json --sandbox workspace-write "$(cat brief)"`, tails the JSONL stream (`item.*`, `turn.completed` with token usage) into `genie task` stage logs, drives fix loops with `codex exec resume <SESSION_ID> "fix the review findings"`, uses `--output-last-message` for the completion report and `--ephemeral` for throwaway scouts. Pair with `--output-schema` (or `@openai/codex-sdk` + zod, already bundled) so reviewer/final-gate verdicts (`SHIP|FIX-FIRST|BLOCKED` + findings[]) are parsed, not regex-scraped. (noninteractive + sdk docs.)
2. **Hook-trust verification in `genie doctor` + managed-hooks story.** Detect the untrusted state (canary `codex exec` with a marker-injecting hook, or parse trust records under `$CODEX_HOME`) and fail loudly: "genie hooks NOT trusted; run /hooks in Codex". `genie install` prints the same nudge after `codex plugin add`. For teams, ship an optional `requirements.toml` snippet (`hooks.managed_dir`) so genie's guard chain is auto-trusted — the only path that restores Claude-parity fail-closed semantics. Note: stamping/editing installed hook files invalidates SHA-recorded trust. (hooks doc trust model.)
3. **`SubagentStart`/`SubagentStop` hooks → live task state.** Matcher `genie_.*` on `agent_type`: `SubagentStart` injects the task-claim brief via `additionalContext` (and records the spawn in genie.db); `SubagentStop` verifies the claimed task was released/done, flagging orphans — or `decision: "block"` forces continuation when a role exits without reporting. Turns the shipped TOML role prompts from advisory text into enforced lifecycle, and gives the board real-time spawn observability with zero polling. (hooks + subagents docs.)
4. **`notify` command for turn-boundary state + omni approval latency.** `notify = ["genie", "hook", "codex-notify"]` is a documented, near-zero-cost signal (`agent-turn-complete`, approval-needed) — restores the board-visibility the retired OTel relay provided, without a resident process, and pings the omni approval chat immediately instead of waiting on the queue poll. (config-reference/config-advanced.)
5. **Per-role identity via `shell_environment_policy.set` in agent TOMLs.** Agent files are full config layers: `[shell_environment_policy] set = { GENIE_AGENT_NAME = "genie_reviewer" }` makes `genie hook dispatch` and `genie task checkout --worker` self-identify inside every spawned role with zero prompt engineering — Codex currently has no reliable per-subagent identity source for genie. (config-reference + subagents.)
6. **Repo-scoped zero-install onboarding.** `genie init` scaffolds `<repo>/.codex/hooks.json`, `.codex/agents/*.toml`, and (already shipped) `.agents/plugins/marketplace.json`; a teammate who clones gets marketplace, project agents, and guard hooks with no `genie install`. Requires project trust (`projects.<path>.trust_level`, consent-gated) and watch openai/codex#15250 for project-agent visibility. (build-plugins + subagents + config-reference.)
7. **Genie MCP hardening: `required = true` + `default_tools_approval_mode = "auto"`.** Converts "board silently absent" into an explicit startup error and removes approval friction for read-only `mcp__genie__*` calls; declare skill↔MCP deps via `agents/openai.yaml` `dependencies.tools` so `$wish`/`$work` surface the server themselves. (config-reference + skills docs.)
8. **PreToolUse `updatedInput` auto-correction.** Codex-only: rewrite tool input instead of denying — append `--worker <id>`, reroute a write into the claimed worktree, prefix git commands with safety flags. Turns hard blocks into corrections. (hooks doc.)
9. **AGENTS.md layering + `PostCompact` re-orientation.** `genie init` writes a marked genie section into repo `AGENTS.md`; wish worktrees get a generated `AGENTS.override.md` naming the active wish/group — always-in-context, no trust gate, reaches subagents that never fire UserPromptSubmit. Add a `PostCompact` hook re-injecting the active-wish summary right after compaction destroys it. (agents-md + hooks docs.)
10. **Extra lanes: cloud + reverse-MCP + `[agents]` tuning.** `@codex review` on PRs and `codex cloud exec --attempts 4` + `codex apply` for best-of-n fixers; register `codex mcp-server` in Claude Code so a genie orchestrator can delegate bounded tasks to Codex threads without tmux; size `agents.max_threads` (default 6) to the ready-group width at `genie launch`. (cloud/github + cli-reference + config-reference.)

---

## 4. Sources

Official docs (developers.openai.com URLs are canonical; each 308-redirects to the learn.chatgpt.com equivalent):

- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/codex/subagents
- https://developers.openai.com/codex/hooks
- https://developers.openai.com/codex/plugins and https://developers.openai.com/codex/plugins/build
- https://developers.openai.com/codex/skills
- https://developers.openai.com/codex/custom-prompts (deprecated surface)
- https://developers.openai.com/codex/guides/agents-md
- https://developers.openai.com/codex/cli/reference
- https://developers.openai.com/codex/noninteractive and https://github.com/openai/codex/blob/main/docs/exec.md
- https://developers.openai.com/codex/sdk (npm `@openai/codex-sdk`)
- https://developers.openai.com/codex/cloud and https://developers.openai.com/codex/integrations/github (+ https://github.com/openai/codex-action)

Source code (github.com/openai/codex, main, read 2026-07-10 via GitHub API):

- `codex-rs/core-skills/src/loader.rs`, `loader_tests.rs` (hidden-dir pruning; deprecated `$CODEX_HOME/skills` root)
- `codex-rs/core-plugins/src/loader.rs`, `toggles.rs` (marketplace paths; `enabled` toggle shapes)
- `codex-rs/plugin/src/manifest.rs` (inline `mcpServers` object)
- `codex-rs/cli/src/plugin_cmd.rs`, `marketplace_cmd.rs` (`--json` envelopes)

Other:

- https://github.com/openai/skills (catalog repo — origin of the `.curated`/`.system` layout)
- https://github.com/openai/codex/issues/15250 (project-scoped agents visibility), #15941 (custom-prompt breakage), #12913 (`codex mcp-server` OTel gap)
