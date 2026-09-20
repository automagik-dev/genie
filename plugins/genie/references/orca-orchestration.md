# Orca orchestration boundary

This is the contributor contract for Genie's Option A Orca plugin. Operator commands and recovery are documented in
the repository [README](../../../README.md#standalone-and-orca-authority). Keep both surfaces aligned with shipped code.

## Authority and compatibility

Standalone is the default. Only `genie setup --orchestration-mode orca` may select Orca lifecycle authority, and it
must finish the packaged-payload and runtime preflight before committing configuration. In Orca mode, the low-level
SQLite pre-open barrier rejects local lifecycle reads and writes, and the roadmap pre-write barrier rejects direct and
indirect writes, syncs, and exports. Do not route around either barrier or serve stale local data as a convenience.

The supported host boundary is the public Orca CLI with child-process execution, runtime version `>=1.4.205`, and the
`orchestration.contract.v1` capability. A host that cannot satisfy that contract returns `unsupported_environment`.
No fallback to standalone or to another transport is permitted.

## Closed public CLI adapter

The adapter accepts typed operations, validates them against per-verb closed schemas, and compiles them to an exact
allowlist of `orca orchestration <verb> ... --json` argv for the lifecycle verbs, `orca worktree <show|set> ... --json`
for the board-card pair, and `orca terminal list ... --json` for the one terminal read. It owns the final `--json`,
selects one deterministic executable, and spawns with `shell: false`. Callers cannot provide executable names, raw
argv, flags, routing, terminal handles, or recovery commands, and no placement beyond the closed worktree selector
grammar below.

Runtime selection is fixed by platform and managed-terminal state: Linux outside an Orca terminal selects `orca-ide`,
Windows selects `orca.exe`, and macOS or an Orca-managed terminal selects `orca`. Failure of that selected executable
is final—never probe a second candidate.

The positive boundary currently contains these operations:

```text
orchestration: run-create run-list run-show run-current run-use
               task-create task-list task-update
               worker-start worker-show worker-read worker-release
               send check reply ask
               gate-create gate-list gate-resolve
worktree:      worktree-show worktree-set
terminal:      terminal-list
```

The three non-orchestration operations and the amended `worker-start` are the written amendment recorded in
`.genie/brainstorms/orca-plugin-genie/DESIGN.md` (§ "The adapter amendment") to the frozen set of
`genie-dual-mode-orca-plugin/DESIGN.md:135`:

- A **worktree selector** is the one placement value a caller may name, because the plugin worker runs outside every
  terminal: `current`, `active`, `id:<repoId>::<absolute path>`, `path:<absolute path>`, `branch:<ref>` (the charset
  `git check-ref-format` accepts), `name:<display name>` — a closed grammar validated before spawn. `branch:` is
  `selector_ambiguous` on a host with two checkouts of one branch; handlers use `active`, then `id:`.
- `worktree-set {worktree, workspaceStatus?, comment?}` (at least one; status is one of Orca's four default columns,
  the comment one line of the short-text domain) is a mutation whose receipt is the updated record and whose public
  read-back is `worktree show --worktree id:<returned id>`; a disagreement is `readback_mismatch`, never retried.
- `worker-start` takes `task` **or** `spec` (with an optional `title`), an optional `run`, and a selector that
  defaults to `current`; with `spec` the receipt's task id is the identity the `worker-show` read-back proves.
- Worktree and terminal receipts are strict on the fields genie reads and pass the rest through: Orca's worktree record
  is a 45-field UI projection that grows per release, and a fully closed schema would turn each release into
  `unexpected_response`. Passthrough is bounded by the stdout cap and the typed field bounds.

Reject `terminal send`. Reject `--inject`. Reject `internal RPC`. Reject `private API`. Also reject caller-selected
`--json`, generic command runners, shell strings, setup/worktree/repository placement, impersonation/routing flags, and
unknown fields before spawning. Examples in public docs must remain inside this finite boundary.

## Receipts, read-backs, and recovery

stdout must be exactly one schema-valid Orca JSON envelope. stderr is bounded diagnostic context, never success data.
Execution has fixed time and output limits, and errors redact secrets and unbounded payloads.

A mutation succeeds only with a valid identifying receipt plus an exact public read-back where the official CLI exposes
one. The read-back must prove the requested identity and immutable fields. Receipt-only exceptions are deliberately
narrow: `send`, `reply`, `ask`, and `check --ack`, because the allowed public subset has no stable exact-message, ask,
or separate acknowledgement read.

After launch, timeout, output-limit, or transport loss without a complete identifying receipt is
`ambiguous_after_possible_commit`. Never retry the mutation automatically, scrape a partial response, or enumerate a
collection to guess which entity was created. An automated public read-back is allowed only when the exact identifier
was validated independently before launch and the capability table names the exact read operation. Even then the
read-back informs the caller; it does not authorize an automatic retry. Otherwise only operator or external
confirmation can resolve the ambiguity.

Every adapter error preserves the safe operation name, failure phase, retry-safety classification, and a public recovery
hint. It must never suggest silently switching authority.

## Verb amendment checklist

A new verb or field changes the trust boundary. Before implementation:

1. Amend the approved design and explain the current user story; a configurable or speculative allowlist is not enough.
2. Add a strict input schema, exact argv row, closed response schema, receipt identity, and public read-back contract (or
   document the narrow reason an official read does not exist).
3. Add positive exact-argv tests and negative pre-spawn tests for flag-shaped values, raw argv, terminal/placement,
   routing/impersonation, executable override, caller `--json`, unknown fields, malformed envelopes, time/output limits,
   missing receipts, and read-back disagreement.
4. Re-run the supported real-runtime smoke and prove that no local Genie DB or roadmap state changed.
5. Update this file, the operator README, compatibility range when required, package inventory checks, and the targeted
   release documentation test. Obtain independent threat-boundary review.

No fallback, cache, retry ledger, mirror, queue, lifecycle store, private host API, or background synchronization may be
added without a separately approved design.

## Installing the plugin in Orca

Selecting the authority (`genie setup --orchestration-mode orca`) and registering the plugin with Orca are two separate
acts. Genie never registers itself with Orca; the operator adds a source. Orca accepts exactly two:

1. a **marketplace source** — a git repo whose ROOT holds `orca-marketplace.json`;
2. a **plugin source** — a git repo whose ROOT holds `orca-plugin.json`, or a local folder containing `orca-plugin.json`.

### Why the repo root is not the plugin tree

Orca's loader imposes three constraints that this repository root cannot satisfy:

- **No symlinks.** Any symlink anywhere in the tree fails the whole install with "unsafe file path or symlink". `docs`
  is a symlink into the `.docs-vendor` submodule.
- **2000 files / 50 MB.** A dev checkout is roughly 14,000 files.
- **The manifest must be at the ROOT.** Genie's manifest is nested at `plugins/genie/orca-plugin.json`, and a git plugin
  source only ever looks at the root of the fetched tree.

Adding a second, re-rooted `orca-plugin.json` at the repo root does not help: it fixes only the third constraint and
leaves the first two fatal. `plugins/genie` on its own satisfies all three — symlink-free, ~132 files, ~1.3 MB, manifest
at its root — so that subtree is what gets published.

### The published refs

`.github/workflows/orca-plugin-ref.yml` mirrors `plugins/genie` into two refs of this same repository:

| Source branch | Published ref | Channel |
|---------------|---------------|---------|
| `main` | `refs/heads/orca-plugin` | stable — what `orca-marketplace.json` points at |
| `dev` | `refs/heads/orca-plugin-dev` | pre-release |

Each publish is a parentless commit created with `git commit-tree` over `HEAD:plugins/genie` and force-pushed. The refs
are **tree-only by design**: no history, no shared ancestry with `main` or `dev`, and never merged back. The workflow is
idempotent — it compares the branch's subtree hash against the published ref's tree and exits without pushing when they
match. Orca pins the commit it fetched, so a republish cannot retroactively change an existing install.

### Operator routes

- Marketplace source: `https://github.com/automagik-dev/genie.git` at ref `main` (the index lives at the repo root); the
  entry it lists resolves the plugin from the same URL at ref `orca-plugin`.
- Plugin git source: `https://github.com/automagik-dev/genie.git` at ref `orca-plugin`, or `orca-plugin-dev` for the
  pre-release channel. Never `main` or `dev` — those roots are not installable trees.
- Local folder: `~/.genie/plugins/genie`, the payload `genie install` / `genie update` ships. A contributor can point
  Orca at the `plugins/genie` directory of a checkout for the same reason; the checkout ROOT is not a valid folder
  source.

### Maintenance contract

`orca-marketplace.json` is source-only: `build-binary.sh` copies it into no tarball, so `release-payload-version.ts`
deliberately does not stamp or gate it. It carries no version field — it names an identity and a ref, both stable across
releases — so it is absent from `scripts/version.ts` and the `version.yml` bump list, and the repo root holds no
`orca-plugin.json` for either to stamp. `scripts/orca-manifest-parity.test.ts` is the drift guard: it fails when the
marketplace entry stops matching `publisher.id` or the description of `plugins/genie/orca-plugin.json`, when the source
ref stops being `orca-plugin`, when a root `orca-plugin.json` reappears, or when `plugins/genie` grows a symlink or
crosses Orca's 2000-file cap and stops being installable.

## Lifecycle and release maintenance

Install and update stage the complete payload, verify its inventory and version, preflight the selected authority, and
activate atomically. Rollback restores only a verified prior Genie-owned payload/configuration snapshot. Uninstall may
remove only digest-proven Genie ownership metadata and registrations; it never deletes local lifecycle history, Orca
records, modified payloads, or unrelated registrations. `genie doctor` is observational and must report mode, ownership,
resolved runtime compatibility, and actionable recovery without creating lifecycle state.

Every supported release tarball must contain `orca-plugin.json` and `orca-entrypoint.min.js`, agree with `VERSION` and
package metadata, and pass extracted-package installation verification. Stable remains the default release channel;
selecting an Orca lifecycle mode is separate from selecting a release channel.

## MCP retirement

A7 retired the Genie MCP runtime, launchers, and only registrations whose Genie ownership is proven; v6 then removed
the `genie mcp` stub that had stood in for the runtime, so the verb no longer parses at all. Unrelated user
configuration and both authorities' lifecycle history remain untouched; use standalone task/board, or roll back to a
pre-A7 signed release when temporary MCP compatibility is required.
