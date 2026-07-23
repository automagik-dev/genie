# Codex integration map

Updated 2026-07-23 for the authenticated delivery/activation split. This document describes the repository code, not an older installed cache, and does not imply hook trust or stable-release approval.

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
| Plugin manifest | `plugins/genie/.codex-plugin/plugin.json` | Declares Skills and Hooks only. Plugins do not ship custom agents or the repository-scoped Genie MCP route |
| Product skills | `skills/` canonical; `plugins/genie/skills/` committed mirror | Exactly 23 physical, in-root skills with valid `name`/`description` frontmatter and `agents/openai.yaml`; source/package parity is fail-closed |
| Hooks | `plugins/genie/hooks/codex-hooks.json` | Exactly H3 SessionStart, H4 PreToolUse, H6 PermissionRequest; all require explicit `/hooks` review and a new task after definition changes |
| MCP | Trusted project `.codex/config.toml` -> absolute `$GENIE_HOME/bin/genie mcp` | One marker-owned, plugin-independent route with no `cwd` override; unowned routes, damaged markers, and nested shadowing are preserved and reported |
| Optional roles | `plugins/genie/codex-agents/*.toml` -> `~/.codex/agents/` | Seven setup-installed profiles, gated behind matching delivery, current plugin health, and fallback retirement |
| Fallback retirement | `~/.agents/skills/.genie-codex-fallback-retirement/` | No supported path writes Genie product skills to `~/.agents/skills`. Upgrades from a fallback-seeding release retire only provably clean, digest-owned historical copies into one durable quarantine transaction after a single plugin health proof; unmanaged, malformed, symlinked, or modified collisions are preserved and reported |
| Personal migration | 36 adapted skills and 14 custom agents in the maintainer's user tier | Separate user-owned installation; not part of the 23-skill product payload; survives update/uninstall byte-for-byte |

Codex invokes plugin skills with the owner-qualified `$genie:<skill>` selector.
Bare `$<skill>` selectors intentionally select the user tier, which now only
ever holds a separately installed personal copy — Genie no longer seeds it.
Owner-qualified `$genie:<skill>` prevents a same-name user workflow from
silently winning manual plugin invocation.

### Retirement/quarantine layout

```text
~/.agents/skills/.genie-codex-fallback-retirement/
  .retirement.lock          single-writer lock for the retirement root
  txn-<id>/journal.json     fsynced full-batch record of every retired identity
  txn-<id>/quarantine/<skill>/   retired skill trees, moved intact
  txn-<id>/evidence/<skill>/     changed trees archived aside during recovery races
```

Acceptance requires a physical non-symlink directory, a valid versioned
`.genie-sync.json`, a recomputed canonical digest equal to the marker, and a
match against either the verified target-plugin payload or a committed
verified-release historical tuple. The transaction is idempotent and crash-safe:
repeated setup runs recognize the committed transaction (no second transaction, no
accumulating quarantine), and an interrupted run reverse-restores every
pre-commit move without clobbering conflicts. Manual recovery: move a tree back
from `txn-<id>/quarantine/<skill>/` to `~/.agents/skills/<skill>/` only if a bare
user-tier copy is wanted. On **"source changed after planning"** retirement aborts
before any move: the changed personal copy stays in place under
`~/.agents/skills/<skill>` (nothing is moved or archived). The republish-to-live +
`txn-<id>/evidence/<skill>/` archive belongs instead to the restore/disposal races — a
**"changed evidence retained"** archive under `txn-<id>/evidence/<skill>/` (nested inside
the transaction dir, beside `quarantine/`) is a durable backup of
that content; diff it before removing. `.codex/skills/.curated` is a legacy uninstall-only lane:
`genie uninstall` still collects it, but no sync path recreates it.

Starter-card metadata is different: every physical skill's `agents/openai.yaml` prompt is selector-free. The card is already attached to one discovered physical directory, so it must not name either tier and trigger a second resolution step.

## Hook contract

Codex hook trust is hash-specific and commands run outside the model tool sandbox. Repository or plugin edits do not update an installed cache. After authenticated setup activates or repairs a generation, operators inspect `/hooks` and start a new task; until then all changed definitions remain untrusted. H4/H6 definitions include the literal SHA-256 and contract version of the physical plugin launcher; the launcher verifies those values before any child spawn, and release gates reject definition/launcher drift. The remaining `$GENIE_HOME/bin/genie` executable is mutable and platform-specific. The current hook schema hashes normalized definitions rather than transitive executable bytes, so the universal plugin manifest cannot content-bind every release binary. Canonical-path and non-symlink checks narrow that residual but do not justify automatic trust.

| ID | Event | Matcher | Contract |
|----|-------|---------|----------|
| H3 | `SessionStart` | `startup\|resume\|clear\|compact` | One local read-only pass over at most 64 candidates/256 KiB; emits at most eight wish records and 2 KiB of validated slug/status/count context |
| H4 | `PreToolUse` | `Bash\|Write\|Edit\|apply_patch` | Definition-bound launcher verification, then branch/orchestration for Bash plus audit-context for edit inputs; deterministic and network-free in Codex; no freshness/identity handler or Omni |
| H6 | `PermissionRequest` | `*` at the host, narrowed by configured registry matcher | Definition-bound launcher verification; Omni at most once when explicitly enabled; bounded/redacted preview; valid allow/deny envelope; binding/failure/interruption/timeout denies |

PreToolUse cannot intercept every possible mutation. It is defense in depth, not branch protection or a sandbox. The removed six commands installed/synchronized software, scaffolded `AGENTS.md`, validated at the wrong lifecycle points, repeatedly injected repository text, or emitted a protocol-inert Stop response.

## Installation and convergence

`genie install --integrations codex` and `genie update` own signed delivery: they verify and stage the selected release,
publish its complete authenticated delivery record, and leave registration, cache, enabled state, project route,
fallbacks, and role profiles untouched. Delivery may exit 2 with `deliveryComplete:true` when activation remains.

`genie setup --codex` owns activation and managed Codex convergence. It requires the matching record before its first
prompt or mutation, uses a fresh real-TTY retirement assertion when the generation changes, and then revalidates the
authenticated physical root around each one-shot operation. After the plugin is current, setup registers the canonical
marketplace if needed, commits explicit Codex scope, proves the exact enabled plugin and bounded MCP launcher, retires
only clean historical fallbacks, converges roles, and reconciles the marker-owned project route. A deliberately disabled
current plugin stays disabled; setup skips fallback retirement but still repairs managed roles. No supported path writes
product skills into `~/.agents/skills`, and unmanaged, modified, symlinked, and personal copies are preserved.
SessionStart performs no setup, delivery, activation, synchronization, or project write.

The 2026-07-11 dogfood incident demonstrated the failure mode: `5.260710.13` selected stale stable `5.260710.2`; an environment-only sync request was misread by the fresh old child as another full update to `5.260711.3`; legacy adoption then replaced 22 same-name personal skills and created a duplicate `review`. Automatic backups restored all 22 adapted directories, both recreated review copies were quarantined, old hook trust was removed, and the 36 skill plus 14 agent baselines matched exactly. The follow-up prevents adoption of user-owned collisions and leaves final post-test baseline comparison as a release-gate action.

## Project identity and recovery

For an untouched repository, the reconciliation command is:

```bash
genie init
```

Run it from the trusted Git worktree that should own the route. It creates or repairs only Genie's
marker-owned project route and repository state; it does not deliver or activate a plugin. The route has no
`cwd` override, so a Codex-launched MCP child inherits the new task's effective working directory exactly.
Linked worktrees keep their local `.codex/config.toml` but resolve the shared task database from the Git
common directory. An initialized nested repository is a hard boundary: if its own database is absent or
unopenable, MCP returns a structured error and never falls through to an outer repository or an empty board.

Use `genie doctor --json` from that same worktree to classify recovery:

| Finding | Recovery |
|---------|----------|
| Project trust required | Open the repository in interactive Codex, review and trust its project config, then start a new task. Never use a trust-bypass flag |
| Unowned same-key route or nested/global shadow | Review the reported `routeLayers`, then rename or remove the user-owned `mcp_servers.genie` entry yourself. Genie preserves it. Rerun `genie init` |
| Damaged/incomplete Genie marker | Back up `.codex/config.toml`, remove only the incomplete Genie marker fragment after reviewing it, preserve every other key, then rerun `genie init` |
| `delivery-incomplete` | Run `genie update` (or `genie install --integrations codex`) to authenticate the exact release, then run `genie setup --codex` from an external real terminal |
| Activation pending or a task pinned to N | Close or retire the old task, complete `genie setup --codex`, review `/hooks`, and start a genuinely new task on T. Resuming N is not promised |
| Role or skill collision | Compare the named personal/modified file and move or rename it only if you choose; Genie never overwrites it. Rerun `genie setup --codex` |
| Relocated `GENIE_HOME` | Complete installation at the new physical home, then rerun `genie init` in every trusted worktree so the owned route names the new stable facade |
| Uninstall | Finish or retire open tasks first. `genie uninstall` removes only proven Genie-owned assets and keeps personal, modified, symlinked, collision, quarantine, and recovery evidence |

Successful `genie init` or setup changes project/hook inputs for future tasks, not an already-running task.
After any route, plugin, or hook change, review `/hooks` and start a new task before judging MCP identity.

## Native orchestration

The active client supplies its native spawn/follow-up/wait/interrupt tools; shared skills do not name undocumented functions. Codex uses installed `genie_*` profiles when available, but native subagents share the caller's workspace unless the runtime explicitly provides isolation. For guaranteed per-group Git isolation, use `genie launch`/worktrees.

Each engineer claims with `genie task checkout <task-id> --worker <name>`, reports completion, and remains `in_progress`. An independent reviewer validates the group. Only the orchestrator calls `genie task done` after SHIP and passing evidence.

Reviewer verdicts and WISH status are distinct. Reviewers return read-only
SHIP/FIX-FIRST/BLOCKED evidence; the invoking orchestrator appends it and owns
durable `DRAFT` → `FIX-FIRST`/`APPROVED` → `IN_PROGRESS` → `SHIPPED`
transitions (with `BLOCKED` only for a recorded blocker).

## Automation boundary

The review workflow uses isolated Git worktrees and can use `codex exec --ephemeral --json --output-schema` for schema-checked, non-interactive specialist lanes. Reviewers use built-in `:read-only` permissions against the repository, temporary-hosted worktrees, temporary directories, caches, and live homes; a write-requiring test is reported as blocked and may rely on separately captured exact-tree CI evidence. App-server and SDK surfaces are not required by the shipped plugin and should not be claimed as current product behavior.

## Release dogfood boundary

Promotion evidence is generated from the exact candidate channel-manifest bytes, never from a handwritten
platform list. Every manifest entry must have one physical signed tarball, Sigstore bundle, SLSA provenance,
and one native Group F lifecycle result bound to the same manifest/artifact digests and evidence-schema
version. The completeness gate rejects missing, duplicate, skipped, unavailable, empty-board, wrong-root,
stale-task, out-of-order, or identity-inconsistent evidence.

That Codex dogfood gate and the independent release-security gate are separate read-only jobs. Homolog and
stable publication require both jobs to succeed for the same candidate; neither result can substitute for
or bypass the other. Repository code does not claim the still-human external two-maintainer demonstration
tracked by `stable-release-security-gate`.

## Lifecycle exit matrix and result trailer (Group D — delivery/activation split)

Genie separates signed **delivery** from cross-version **activation** (Decision 1).
**`genie setup --codex` is activation-only with respect to release bytes**: it never
downloads, stages, or publishes a plugin payload. Behind a matching delivery record and,
when required, an unforgeable real-TTY retirement assertion, it activates the delivered
generation and converges the activation-owned marketplace, clean fallback retirement,
managed roles, and project route. **Signed delivery is done by `genie update` /
`genie install`**. On a host where nothing was delivered, setup refuses with an actionable
message pointing at update/install; it is never a dead end.

Every mutating lifecycle command serialises on one exclusive Codex lifecycle lease; a
loser exits 2 with machine code `codex-lifecycle-busy`, `deliveryComplete:false`, and a
retry action.

### Per-command 0/1/2 exit matrix

| Command | 0 | 1 | 2 |
|---------|---|---|---|
| `genie setup --codex` (and the full-wizard Codex step) | Activated, or already current | Broken/undelivered (no payload, `cache-missing`, `payload-mismatch`, `installed-newer`) — retry after `genie update` | Consent/authorization refused (quick, CI, `CODEX_THREAD_ID`, non-TTY, piped, decline/EOF), `activation-pending`/`registration-absent`/`intent-planned`/`intent-target-current`/`pending-downgrade-explicit` needing consent, or `codex-lifecycle-busy` |
| `genie update` / `genie install` | Delivered + current | Delivery/verification failure | Delivered but action-required (`deliveryComplete:true`), or `codex-lifecycle-busy` |
| `genie update --rollback` | Compatible rollback done | Rollback refused (capability floor) | `codex-lifecycle-busy` |
| `genie uninstall` | Removed (or nothing to remove) | Safeguard/ownership failure | `codex-lifecycle-busy` (a lifecycle command holds the lease) |
| `genie doctor` / `genie doctor --json` | All checks pass, Codex current | A hard check failed, or Codex broken (`query-failed`, `payload-mismatch`, …) | Codex `activation-pending`/`registration-absent`/recovery — `ok` stays a function of checks; `integrationSummary.actionRequired === true` |
| `genie init` | Scaffolded | Not a git repo / MCP schema failure | — |

### Result trailer

Every exit-2/1 lifecycle path except `doctor --json` emits exactly one ANSI-free,
single-line JSON **result trailer** on stdout, serialized once by Group A
(`serializeActivationResultTrailer`):

```json
{"schemaVersion":1,"code":"codex-lifecycle-busy","deliveryComplete":false,"retry":true,"nextAction":"retry after the current setup-activation lifecycle command releases the lease"}
```

`doctor --json` is excluded: its exactly-one-object stdout contract carries the same
`deliveryComplete` (and `actionRequired`) inside `integrationSummary.codexPlugin`. A
pending `doctor --json` exiting 2 while `ok:true` is an intentional, backward-compatible
compatibility change — automation keys off `integrationSummary`, not the process exit.

### Two-phase operator flow, automation, and lease retry

Delivery and activation are separate phases. Automation should treat exit 2 as
**action-required, not failure**: parse the single-line result trailer (or, for
`doctor --json`, `integrationSummary`) and branch on `deliveryComplete` and the
machine `code` rather than on green success text. A `code:"codex-lifecycle-busy"`
trailer (`deliveryComplete:false`) means another mutating lifecycle command holds
the exclusive lease; the named `nextAction` says to retry after it releases. No
TTL and no force override exist: a live or indeterminate holder stays busy, and
only a dead-pid holder is superseded by atomic non-overwriting rename with
fencing that rejects the superseded operation's late writes.

### Rollback floor

`genie update --rollback` restores a backup binary only after
`enforceRollbackCapabilityFloor` proves, before any live-binary exchange, that the
backup is digest-bound to its `<backup>.capabilities.json` sidecar, that its
read-only capability probe reports `codexActivationProtocol >= 1` and covers every
extant activation intent schema, and that both device/inode identities are
unchanged immediately before the swap. A missing sidecar, protocol below the
floor, tamper, or a TOCTOU replacement refuses with zero mutation — consent
cannot waive the protocol floor, so a rollback can never reintroduce an updater
that bypasses the Codex activation gate.

### Lifecycle exceptions: sync-only, route-only init, and uninstall

- **Sync-only** (`genie update --sync-only`, legacy automation) is intentionally
  limited to non-Codex agent synchronization; it performs no Codex observation,
  activation, fallback retirement, or role convergence and mints no assertion or permit.
- **Init** (`genie init`) reconciles only the marker-owned project MCP route in a
  trusted initialized repository. The route is independent of plugin availability
  and activation state; init never requests an assertion/permit or mutates delivery,
  journal, registration, cache, enabled state, fallbacks, or roles.
- **Uninstall** (`genie uninstall`) is a deliberately separate, user-requested
  destructive-removal authority — not part of the activation protocol. It warns
  before its confirmation that current or resumable tasks can break, keeps every
  existing ownership/user-data/backup/lock safeguard, mints/accepts no
  assertion/permit, and is unreachable from update, install, setup, doctor, sync,
  post-delivery convergence, or init.

### Homolog candidate channel and the N-task non-guarantee

**Homolog is the canonical pre-stable candidate channel.** The post-release live
dogfood runs against the exact homolog candidate commit before any stable
promotion. Consent is authority, not liveness: **an activated N task is not
guaranteed to resume.** After the delivered N+1 generation is activated, a
previously retired or open N task may be gone; the operator still needs `/hooks`
review and a genuinely new N+1 task, and cannot resume activated N tasks without
the upstream host leases. The structural evidence for that ritual is owned by
`scripts/validate-live-dogfood-evidence.ts` (never a nonempty-file check) and the
extracted-tarball activation contract by
`scripts/verify-codex-activation-payload.ts`.
