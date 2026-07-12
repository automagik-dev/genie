# Codex integration map

Updated 2026-07-11 after the Ultra review of PR #2545 and its follow-up remediation. The original PR merged via `6f682e2b` from promoted source `10ceb2c0`; remediation continues on `fix/pr2545-ultra-gate` targeting `dev`. This document describes the follow-up code, not the older installed cache, and does not imply hook trust or stable-release approval.

Official references:

- [Build plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Build skills](https://learn.chatgpt.com/docs/build-skills)
- [Hooks](https://learn.chatgpt.com/docs/hooks)
- [Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [App server](https://learn.chatgpt.com/docs/app-server)

## Shipped surfaces

| Surface | Location | Current contract |
|---------|----------|------------------|
| Plugin manifest | `plugins/genie/.codex-plugin/plugin.json` | Declares Skills, Hooks, and MCP only. Plugins do not ship custom agents |
| Product skills | `skills/` canonical; `plugins/genie/skills/` committed mirror | Exactly 23 physical, in-root skills with valid `name`/`description` frontmatter and `agents/openai.yaml`; source/package parity is fail-closed |
| Hooks | `plugins/genie/hooks/codex-hooks.json` | Exactly H3 SessionStart, H4 PreToolUse, H6 PermissionRequest; all require explicit `/hooks` review and a new task after definition changes |
| MCP | `plugins/genie/.mcp.json` -> `scripts/mcp-launcher.cjs` | Starts only canonical `$GENIE_HOME/bin/genie mcp`; no PATH/shell fallback; unsafe/missing binary fails closed |
| Optional roles | `plugins/genie/codex-agents/*.toml` -> `~/.codex/agents/` | Seven CLI-installed profiles. Plugin-only installations have no `genie_*` agents |
| CLI-managed user-tier fallback | `~/.agents/skills/<name>` | Codex-selected install/update may manage up to 23 digest-proven Genie copies; plugin-only install does not need it, and unmanaged, malformed, symlinked, or modified collisions are preserved |
| Personal migration | 36 adapted skills and 14 custom agents in the maintainer's user tier | Separate user-owned installation; not part of the 23-skill product payload |

Codex invokes plugin skills with the owner-qualified `$genie:<skill>` selector.
Bare `$<skill>` selectors intentionally select the user tier, which may be a
CLI-managed fallback or separately installed personal copy. Owner-qualified
`$genie:<skill>` prevents a same-name user workflow from silently winning
manual plugin invocation.

Starter-card metadata is different: every physical skill's `agents/openai.yaml` prompt is selector-free. The card is already attached to one discovered physical directory, so it must not name either tier and trigger a second resolution step.

## Hook contract

Codex hook trust is hash-specific and commands run outside the model tool sandbox. Repository or plugin edits do not update an installed cache. After explicit setup/update, operators inspect `/hooks` and start a new task; until then all changed definitions remain untrusted. H4/H6 definitions include the literal SHA-256 and contract version of the physical plugin launcher; the launcher verifies those values before any child spawn, and release gates reject definition/launcher drift. The remaining `$GENIE_HOME/bin/genie` executable is mutable and platform-specific. The current hook schema hashes normalized definitions rather than transitive executable bytes, so the universal plugin manifest cannot content-bind every release binary. Canonical-path and non-symlink checks narrow that residual but do not justify automatic trust.

| ID | Event | Matcher | Contract |
|----|-------|---------|----------|
| H3 | `SessionStart` | `startup|resume|clear|compact` | One local read-only pass over at most 64 candidates/256 KiB; emits at most eight wish records and 2 KiB of validated slug/status/count context |
| H4 | `PreToolUse` | `Bash|Write|Edit|apply_patch` | Definition-bound launcher verification, then branch/orchestration for Bash plus audit-context for edit inputs; deterministic and network-free in Codex; no freshness/identity handler or Omni |
| H6 | `PermissionRequest` | `*` at the host, narrowed by configured registry matcher | Definition-bound launcher verification; Omni at most once when explicitly enabled; bounded/redacted preview; valid allow/deny envelope; binding/failure/interruption/timeout denies |

PreToolUse cannot intercept every possible mutation. It is defense in depth, not branch protection or a sandbox. The removed six commands installed/synchronized software, scaffolded `AGENTS.md`, validated at the wrong lifecycle points, repeatedly injected repository text, or emitted a protocol-inert Stop response.

## Installation and convergence

`genie install --integrations codex`, `genie setup --codex`, and `genie update` are the only installation/update paths.
A successful setup persists Codex maintenance consent; later explicit updates use that scope to refresh Codex integration
and clean digest-managed user-tier fallbacks while preserving unmanaged, modified, and personal skills. Persisted scope
does not authorize a hook or background updater. SessionStart performs no setup, update, plugin refresh, skill
synchronization, or project write.

An update crossing from a release older than `5.260711.6` to `5.260711.6` or later can deliver the new payload without the old process knowing the new convergence phase. Run one explicit `genie update` after that first command returns; the newly installed binary then converges product integrations. Current update code performs post-swap convergence inside the already-reviewed parent process and never re-enters a freshly installed older binary as `genie update`.

The 2026-07-11 dogfood incident demonstrated the failure mode: `5.260710.13` selected stale stable `5.260710.2`; an environment-only sync request was misread by the fresh old child as another full update to `5.260711.3`; legacy adoption then replaced 22 same-name personal skills and created a duplicate `review`. Automatic backups restored all 22 adapted directories, both recreated review copies were quarantined, old hook trust was removed, and the 36 skill plus 14 agent baselines matched exactly. The follow-up prevents adoption of user-owned collisions and leaves final post-test baseline comparison as a release-gate action.

## Native orchestration

The active client supplies its native spawn/follow-up/wait/interrupt tools; shared skills do not name undocumented functions. Codex uses installed `genie_*` profiles when available, but native subagents share the caller's workspace unless the runtime explicitly provides isolation. For guaranteed per-group Git isolation, use `genie launch`/worktrees.

Each engineer claims with `genie task checkout <task-id> --worker <name>`, reports completion, and remains `in_progress`. An independent reviewer validates the group. Only the orchestrator calls `genie task done` after SHIP and passing evidence.

Reviewer verdicts and WISH status are distinct. Reviewers return read-only
SHIP/FIX-FIRST/BLOCKED evidence; the invoking orchestrator appends it and owns
durable `DRAFT` → `FIX-FIRST`/`APPROVED` → `IN_PROGRESS` → `SHIPPED`
transitions (with `BLOCKED` only for a recorded blocker).

## Automation boundary

The review workflow uses isolated Git worktrees and can use `codex exec --ephemeral --json --output-schema` for schema-checked, non-interactive specialist lanes. Reviewers use built-in `:read-only` permissions against the repository, temporary-hosted worktrees, temporary directories, caches, and live homes; a write-requiring test is reported as blocked and may rely on separately captured exact-tree CI evidence. App-server and SDK surfaces are not required by the shipped plugin and should not be claimed as current product behavior.

## Known release boundary

Source/extracted payload parity, hook protocol, and user-asset ownership belong to this follow-up. Inherited publication risks—arbitrary-ref stable publish, unvalidated privileged inputs/artifact provenance, mutable third-party actions, and the inherited live-binary transaction gap—remain BLOCKING in `stable-release-security-gate`. PR-scope remediation cannot authorize stable release.
