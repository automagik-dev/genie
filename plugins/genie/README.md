# Genie plugin surfaces

This directory is the shared release payload for Claude Code and Codex. The two clients load different manifests, but the 23 product skills have one canonical source (`/skills`) and one committed, byte-checked plugin mirror (`plugins/genie/skills`).

## What Codex gets

| Surface | Delivery | Contract |
|---------|----------|----------|
| Product skills | The plugin contains 23 physical in-root skill directories, each with `SKILL.md` and `agents/openai.yaml` | The **sole** Genie-managed skill provider; no escaping symlink and no user-tier copy — nothing is written to `~/.agents/skills` |
| Fallback retirement | Hidden `~/.agents/skills/.genie-codex-fallback-retirement/` quarantine transaction | Never written on fresh setup. Authenticated setup moves only provably clean, digest-owned historical copies here after one plugin health proof; `txn-<id>/evidence/` archives retain changed trees for recovery |
| Hooks | `.codex-plugin/plugin.json` points to `hooks/codex-hooks.json` | Three untrusted definitions only: H3 SessionStart context, H4 local PreToolUse guardrails, H6 PermissionRequest approval |
| MCP | Marker-owned project `.codex/config.toml` | Codex launches the stable absolute `$GENIE_HOME/bin/genie mcp` facade with no `cwd` override; the plugin declares no Codex MCP route |
| Role agents | Seven TOMLs are staged in `codex-agents/` | Plugins cannot install custom agents. Authenticated `genie setup --codex` copies the optional profiles into `~/.codex/agents/` after enabled-plugin health/retirement; an exact deliberately disabled plugin skips retirement but still repairs roles |

The plugin is the only Genie-managed skill provider. A fresh Codex install writes zero user-tier skills; bare `$<skill>` now resolves only a personal copy the user installed themselves. A maintainer may separately have 36 adapted skills under `~/.agents/skills`; those are user-owned, are not bundled here, and must survive update/uninstall byte-for-byte. An upgrade from a release that seeded digest-managed fallbacks retires only provably clean, Genie-owned copies into the hidden quarantine transaction after one health proof — a physical non-symlink directory with a valid versioned `.genie-sync.json`, a recomputed digest equal to the marker, and a match against the verified target payload or a committed verified-release historical tuple. Modified-managed, malformed-marker, symlinked, and unmanaged same-name collisions are preserved in place and reported, never adopted or deleted.

### Quarantine layout and manual recovery

```text
~/.agents/skills/.genie-codex-fallback-retirement/
  .retirement.lock          single-writer lock for the retirement root
  txn-<id>/journal.json     fsynced full-batch record of every retired identity
  txn-<id>/quarantine/<skill>/   retired skill trees, moved intact
  txn-<id>/evidence/<skill>/     changed trees archived aside during recovery races
```

The transaction is idempotent and crash-safe: repeated setup runs recognize the committed transaction (no second transaction, no accumulating quarantine); an interrupted run reverse-restores every pre-commit move without clobbering conflicts. Committed quarantine and journal evidence are retained. Manual recovery:

- **Restore a retired skill:** move it back from `txn-<id>/quarantine/<skill>/` to `~/.agents/skills/<skill>/` (only if you want a bare user-tier copy; the plugin already serves `$genie:<skill>`).
- **"Source changed after planning":** if the live skill was edited between the health proof and the move, retirement aborts before any move — the changed personal copy stays in place at `~/.agents/skills/<skill>`; nothing is moved or archived. Review it, then rerun.
- **"Changed evidence retained":** the republish-to-live + archive behavior belongs to this class — when a quarantined tree changed during restore or disposal, the changed copy is retained under `txn-<id>/evidence/<skill>/` (nested inside the transaction dir, beside `quarantine/`) as a durable backup of that exact content; diff it against the live path before removing it.

`genie doctor` reports the quarantined count and every preserved collision (name, classification, effective precedence, and remediation). Restart Codex after any Codex convergence so it drops stale bare providers and loads only owner-qualified `genie:*` plugin skills.

## Codex hook trust and side effects

Codex runs trusted commands on the host, outside the model sandbox. Plugin installation does not grant trust. After every setup, update, or hook edit:

1. Open `/hooks` in Codex.
2. Confirm that only H3, H4, and H6 are present and inspect each changed definition/hash.
3. Trust only the definitions you intend to run.
4. Start a new task; the current task does not adopt changed hook definitions.

Until that review, the hooks remain untrusted and do not run. Never use a trust-bypass flag.

H4 and H6 definitions carry the literal SHA-256 of `scripts/dispatch-runtime.cjs` plus a launcher-contract version. The launcher hashes its own physical (non-symlink) file before spawning Genie and returns an event-valid denial on any mismatch. Release checks regenerate/compare those literals, so changing launcher bytes necessarily changes the definitions presented by `/hooks`. This binds the reviewed definition to the plugin launcher, but not to the later mutable, platform-specific `$GENIE_HOME/bin/genie` binary: Codex's current hook schema hashes the normalized definition, not every transitive executable byte, and a single cross-platform plugin manifest cannot name all release-binary digests. Canonical-path/non-symlink checks remain defense in depth; this residual is why Genie does not auto-trust these hooks and still requires operator review after every update.

| ID | Event | Exact behavior | Allowed side effect |
|----|-------|----------------|---------------------|
| H3 | `SessionStart` | Inspects at most 64 candidate directories/256 KiB, then emits at most eight validated wish records and 2 KiB | Read-only filesystem access |
| H4 | `PreToolUse` | Verifies the definition-bound launcher, then runs branch/orchestration checks for Bash and audit-context for Write/Edit/apply_patch | Deterministic local repository/Git reads only; no Codex network lookup, freshness/identity handler, Omni, install, update, global sync, or scaffolding |
| H6 | `PermissionRequest` | Verifies the definition-bound launcher, applies the configured tool matcher, and invokes Omni once only when approvals are explicitly enabled | Bounded/redacted approval-queue state; timeout, interruption, malformed output, binding drift, and transport failure deny |

PreToolUse is a guardrail, not complete interception. Sandbox policy and server-side branch protection remain the hard controls. The six removed Codex commands performed startup install/sync, wrote `AGENTS.md`, validated wishes before/after writes, reinjected context on every prompt, or emitted an inert completion response; none belongs in the retained lifecycle.

## Explicit install and update paths

No hook installs or updates Genie. Operators use:

```bash
genie install --integrations codex  # verify and publish the Codex delivery
genie setup --codex                 # activate it, retire clean fallbacks, converge roles + project route
genie update                        # deliver a newer signed binary/payload; never activate Codex
```

A successful `genie setup --codex` persists Codex delivery scope. Future explicit updates use that scope to publish
authenticated delivery facts but never advance the plugin cache, change enabled state, reconcile the project route, or
write roles. When a delivered generation is pending, close or retire tasks pinned to the prior generation and run setup
from an external real terminal. Setup requires the matching record before its first prompt or mutation, activates the
exact delivered bytes, proves plugin health, retires only provably clean historical fallbacks, and then converges role
profiles and the marker-owned project route. Unmanaged, modified, and personal skills stay user-owned; persisted scope
does not authorize hooks or background updates.

### 2026-07-11 update incident

One release-dogfood update exposed why that boundary matters. A `5.260710.13` process selected stale stable `5.260710.2`; its fresh child did not understand the environment-only sync request and performed another full update to `5.260711.3`. The ensuing legacy sync adopted 22 same-name personal skills and created a duplicate `review` skill.

Containment recovered all 22 adapted directories from Genie's automatic backup, quarantined both recreated `review` copies, removed the old hook trust, and verified the 36 personal-skill digests plus 14 custom-agent TOMLs against the pre-incident baseline. The current contract preserves user-owned collisions and separates signed update delivery from setup-owned activation and convergence. This note intentionally contains no machine-specific paths, process ids, or credentials.

## Skills and orchestration

The lifecycle is shared across clients:

```text
brainstorm -> design review -> wish -> plan review -> work -> implementation review
```

For non-trivial work, brainstorm automatically invokes read-only design review before wish. The WISH then requires a
separate plan review and persisted `APPROVED` status before work, followed by an independent implementation review. Design SHIP is persisted in DESIGN.md with reviewer identity, UTC timestamp, and a SHA-256 of the exact reviewed content; wish creation and lint reject missing, non-SHIP, or stale evidence. Codex
invokes the plugin copies as `$genie:brainstorm`, `$genie:wish`, `$genie:review`, and `$genie:work`; bare selectors
intentionally select the user tier, which now only ever holds a separately installed personal copy. Claude Code uses the
equivalent slash skills. Native subagents do not imply separate worktrees. Every engineer first claims its assigned task
with `genie task checkout <id> --worker <name>`, reports completion without mutating task state, and is reviewed by a
different agent. Only the orchestrator calls `genie task done <id>` after a SHIP verdict and passing validation. Use
`genie launch` when separate worktrees or a human-supervised Warp cockpit are required.

Those selectors are for manual invocation. Each physical skill's `agents/openai.yaml` starter card is selector-free, so selecting a plugin-tier or user-tier card executes that already-selected physical skill instead of naming and potentially redirecting to the other tier.

The seven optional Codex profiles are `genie_engineer_trivial`, `genie_engineer_standard`, `genie_engineer_complex`, `genie_scout`, `genie_fixer`, `genie_reviewer`, and `genie_final_gate`. The matching Claude inventory is `engineer-trivial`, `engineer-standard`, `engineer-complex`, `scout`, `fixer`, `reviewer`, and `final-gate`. Release checks pin both exact seven-file inventories and their declared names in source, staged payload, extracted archive, and fresh-install copies. A plugin-only install falls back to the client's available generic roles.

## Distribution and verification

`plugins/genie/skills/` is generated from root `skills/`; never edit the mirror directly.

```bash
bun scripts/sync-plugin-skills.ts --check
bun run skills:lint
bun scripts/fresh-install-smoke.ts
```

Release tarballs contain the compiled `genie` executable, the complete `plugins/` tree (including hooks, MCP launcher, role-agent staging, and the 23-skill mirror), root `skills/`, `templates/`, both runtime marketplace manifests, and `VERSION`. Build/version paths verify source-to-plugin parity, required component inventory, generated-hook parity, and version equality before packaging, then extract the finished archive and repeat the inventory/mode/resource/version checks against the extracted payload.

## Claude Code and Hermes

Claude Code consumes `.claude-plugin/plugin.json`, its conventional `hooks/hooks.json`, native agents, and the stamped council workflow. Its SessionStart surface is one bounded, read-only `session-context.cjs` diagnostic: it does not run first-use setup, update, skill synchronization, council stamping, or project scaffolding. The retained `smart-install.js` and `first-run-check.cjs` filenames are inert compatibility diagnostics for stale cached manifests, not mutators. Operators must invoke `genie init`, `genie install`, `genie setup`, or `genie update` explicitly. Hermes uses the sibling [`plugins/hermes-genie/`](../hermes-genie/README.md) read-only plugin. Both share Genie's documents and task database, but their native runtime surfaces remain client-specific.
