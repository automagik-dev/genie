# Orca orchestration boundary

This is the contributor contract for Genie's Option A Orca plugin. Operator commands and recovery are documented in
the repository [README](../../../README.md#standalone-and-orca-authority). Keep both surfaces aligned with shipped code.

## Authority and compatibility

Standalone is the default. Only `genie setup --orchestration-mode orca` may select Orca lifecycle authority, and it
must finish the packaged-payload and runtime preflight before committing configuration. In Orca mode, the low-level
SQLite pre-open barrier rejects local lifecycle reads and writes, and the roadmap pre-write barrier rejects direct and
indirect writes, syncs, and exports. Do not route around either barrier or serve stale local data as a convenience.

The supported host boundary is the public Orca CLI with child-process execution, runtime version `>=1.4.192`, and the
`orchestration.contract.v1` capability. A host that cannot satisfy that contract returns `unsupported_environment`.
No fallback to standalone or to another transport is permitted.

## Closed public CLI adapter

The adapter accepts typed operations, validates them against per-verb closed schemas, and compiles them to an exact
allowlist of `orca orchestration <verb> ... --json` argv. It owns the final `--json`, selects one deterministic
executable, and spawns with `shell: false`. Callers cannot provide executable names, raw argv, flags, placement,
routing, terminal handles, or recovery commands.

Runtime selection is fixed by platform and managed-terminal state: Linux outside an Orca terminal selects `orca-ide`,
Windows selects `orca.exe`, and macOS or an Orca-managed terminal selects `orca`. Failure of that selected executable
is final—never probe a second candidate.

The positive boundary currently contains these operations:

```text
run-create run-list run-show run-current run-use
task-create task-list task-update
worker-start worker-show worker-read worker-release
send check reply ask
gate-create gate-list gate-resolve
```

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

## Lifecycle and release maintenance

Install and update stage the complete payload, verify its inventory and version, preflight the selected authority, and
activate atomically. Rollback restores only a verified prior Genie-owned payload/configuration snapshot. Uninstall may
remove only digest-proven Genie ownership metadata and registrations; it never deletes local lifecycle history, Orca
records, modified payloads, or unrelated registrations. `genie doctor` is observational and must report mode, ownership,
resolved runtime compatibility, and actionable recovery without creating lifecycle state.

Every supported release tarball must contain `orca-plugin.json` and `orca-entrypoint.min.js`, agree with `VERSION` and
package metadata, and pass extracted-package installation verification. Stable remains the default release channel;
selecting an Orca lifecycle mode is separate from selecting a release channel.

## MCP retirement sequencing

Do not remove `genie mcp`, its launchers, or registrations in Option A documentation work. The legacy MCP remains shipped
until the later A7 PR, after authority, adapter, plugin, lifecycle, packaging, and documentation gates are green. A7 may
remove only proved-owned registrations, must preserve unrelated user configuration and both authorities' history, and
must leave the documented stable non-zero retired diagnostic. Until then, documentation must describe retirement as
staged rather than complete.
