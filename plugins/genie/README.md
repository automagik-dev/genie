# Genie plugin surfaces

This directory is the shared release payload for Claude Code and Codex. The two clients load different manifests, but the 23 product skills have one canonical source (`/skills`) and one committed, byte-checked plugin mirror (`plugins/genie/skills`).

## What Codex gets

| Surface | Delivery | Contract |
|---------|----------|----------|
| Product skills | The plugin contains 23 physical in-root skill directories, each with `SKILL.md` and `agents/openai.yaml` | Available to a plugin-only install; no escaping symlink and no user-tier copy required |
| Hooks | `.codex-plugin/plugin.json` points to `hooks/codex-hooks.json` | Three untrusted definitions only: H3 SessionStart context, H4 local PreToolUse guardrails, H6 PermissionRequest approval |
| MCP | `.mcp.json` starts `scripts/mcp-launcher.cjs` | The launcher accepts only the canonical `$GENIE_HOME/bin/genie` (default `~/.genie/bin/genie`) and fails closed if it is absent or unsafe |
| Role agents | Seven TOMLs are staged in `codex-agents/` | Plugins cannot install custom agents. `genie install` or `genie setup --codex` copies the optional profiles into `~/.codex/agents/` |

The CLI-managed product payload is not the user's personal skill library. A maintainer may separately have 36 adapted skills under `~/.agents/skills`; those are user-owned, are not bundled here, and must survive update/uninstall byte-for-byte when unmanaged or modified.

## Codex hook trust and side effects

Codex runs trusted commands on the host, outside the model sandbox. Plugin installation does not grant trust. After every setup, update, or hook edit:

1. Open `/hooks` in Codex.
2. Confirm that only H3, H4, and H6 are present and inspect each changed definition/hash.
3. Trust only the definitions you intend to run.
4. Start a new task; the current task does not adopt changed hook definitions.

Until that review, the hooks remain untrusted and do not run. Never use a trust-bypass flag.

| ID | Event | Exact behavior | Allowed side effect |
|----|-------|----------------|---------------------|
| H3 | `SessionStart` | Emits at most 2 KiB of validated wish slug/status/count context from at most eight local records | Read-only filesystem access |
| H4 | `PreToolUse` | Runs deterministic local guards for documented Bash/edit payloads through the plugin-local launcher | Repository/Git/GitHub reads; no Omni, install, update, global sync, or scaffolding |
| H6 | `PermissionRequest` | Applies the configured tool matcher and invokes Omni once only when approvals are explicitly enabled | Bounded/redacted approval-queue state; timeout, interruption, malformed output, and transport failure deny |

PreToolUse is a guardrail, not complete interception. Sandbox policy and server-side branch protection remain the hard controls. The six removed Codex commands performed startup install/sync, wrote `AGENTS.md`, validated wishes before/after writes, reinjected context on every prompt, or emitted an inert completion response; none belongs in the retained lifecycle.

## Explicit install and update paths

No hook installs or updates Genie. Operators use:

```bash
genie install --integrations codex  # installer-owned finishing path
genie setup --codex                 # install or repair Codex plugin, role agents, and MCP routing
genie update                        # explicit binary/payload/integration convergence
```

The update that first crosses from a pre-convergence binary may only deliver the new binary/payload because the already-running old process does not yet know the new convergence phase. After that command returns, run `genie update` once more explicitly. The second invocation runs the newly installed contract; later updates converge in one operator-driven path. Do not rely on SessionStart for this compatibility hop.

### 2026-07-11 update incident

One release-dogfood update exposed why that boundary matters. A `5.260710.13` process selected stale stable `5.260710.2`; its fresh child did not understand the environment-only sync request and performed another full update to `5.260711.3`. The ensuing legacy sync adopted 22 same-name personal skills and created a duplicate `review` skill.

Containment recovered all 22 adapted directories from Genie's automatic backup, quarantined both recreated `review` copies, removed the old hook trust, and verified the 36 personal-skill digests plus 14 custom-agent TOMLs against the pre-incident baseline. The code fix keeps post-update convergence in the reviewed parent process and preserves user-owned collisions. This note intentionally contains no machine-specific paths, process ids, or credentials.

## Skills and orchestration

The lifecycle is shared across clients:

```text
brainstorm -> wish -> review -> work -> review
```

Codex invokes `$brainstorm`, `$wish`, `$review`, and `$work`; Claude Code uses the equivalent slash skills. Native subagents do not imply separate worktrees. Every engineer first claims its assigned task with `genie task checkout <id> --worker <name>`, reports completion without mutating task state, and is reviewed by a different agent. Only the orchestrator calls `genie task done <id>` after a SHIP verdict and passing validation. Use `genie launch` when separate worktrees or a human-supervised Warp cockpit are required.

The seven optional Codex profiles are `genie_engineer_trivial`, `genie_engineer_standard`, `genie_engineer_complex`, `genie_scout`, `genie_fixer`, `genie_reviewer`, and `genie_final_gate`. A plugin-only install falls back to the client's available generic roles.

## Distribution and verification

`plugins/genie/skills/` is generated from root `skills/`; never edit the mirror directly.

```bash
bun scripts/sync-plugin-skills.ts --check
bun run skills:lint
bun scripts/fresh-install-smoke.ts
```

Release tarballs contain the compiled `genie` executable, the complete `plugins/` tree (including hooks, MCP launcher, role-agent staging, and the 23-skill mirror), root `skills/`, `templates/`, both runtime marketplace manifests, and `VERSION`. Build/version paths verify source-to-plugin parity, required component inventory, and version equality before packaging.

## Claude Code and Hermes

Claude Code consumes `.claude-plugin/plugin.json`, its conventional `hooks/hooks.json`, native agents, and the stamped council workflow. Hermes uses the sibling [`plugins/hermes-genie/`](../hermes-genie/README.md) read-only plugin. Both share Genie's documents and task database, but their native runtime surfaces remain client-specific.
