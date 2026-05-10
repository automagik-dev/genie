# `dedup-team-settings`

One-time cleanup migration for issue [#1710](https://github.com/automagik-dev/genie/issues/1710), Bug 2 (wish: `spawn-compounding-defects`, Group 3).

## Why this exists

`src/hooks/inject.ts:upsertGenieEntry()` historically dedup'd by a heuristic that missed drifted command paths. As a result, every team's `~/.claude/teams/<team>/settings.json` accumulated multiple genie-shape hook entries — one per command-path revision the host went through (legacy `genie hook dispatch` literal, compiled binary at `~/.genie/bin/genie-hook`, codex variant, etc.).

On the filing host this hit **65 of 82 team settings files** with 2-7× duplicates. Every `PreToolUse *` event fired the dispatcher N times, each invocation walking the same handler chain.

Group 2 of the wish hardened the inject-time dedup so new injections collapse drift at write time. This script is the matching one-shot cleanup for what's already on disk.

## How it works

For each `<claudeConfigDir>/teams/<team>/settings.json`:

1. Walk every event under `hooks.<event>`.
2. Within each matcher entry, split `hooks` into genie-shape vs non-genie hooks (regex match — same shape `inject.ts:isGenieDispatchCommand` uses).
3. Collect every genie-shape hook across the array. Dedup by `{matcher, command, timeout}` triplet, then collapse any remaining drift (different triplets, all genie-shape) to the first survivor.
4. Rebuild the matcher array: original matcher entries that contained ≥1 non-genie hook are preserved with non-genie hooks only; the chosen genie entry is appended once.

**Non-genie hooks are never touched.** The drift-collapse pass keys on a regex that matches only genie-dispatch shapes — anything outside that shape is opaque to this script.

The next `genie spawn` against the team will normalize the surviving genie entry to the host's current canonical form via Group 2's hardened `upsertGenieEntry`.

## Usage

```bash
# Dry-run (default) — print what would change, write nothing.
bun scripts/dedup-team-settings.ts
bun scripts/dedup-team-settings.ts --dry-run

# Apply — dedup all team settings files, write a marker.
bun scripts/dedup-team-settings.ts --apply

# Force re-run after the marker exists (e.g. after a manual revert).
bun scripts/dedup-team-settings.ts --apply --force
```

After a successful `--apply` the script writes a marker at `<claudeConfigDir>/.genie/state/dedup-1710.done`. Subsequent invocations exit 0 without scanning until `--force` is passed.

## Audit events

| Event | When | Details |
|---|---|---|
| `settings.dedup.completed` | after `--apply` finishes | `{ filesScanned, filesModified, entriesRemoved }` |
| `settings.dedup.skip.marker_present` | when re-run hits the idempotency marker | `{ marker }` |

Audit emission is best-effort — the migration runs cleanly on hosts where `genie-pgserve` is offline (audit is silently dropped).

## What this script does NOT do

- Edit any non-genie hook entry, regardless of how it's keyed.
- Rewrite hook paths to the canonical form. The next inject does that — this script only removes excess copies.
- Walk per-user (non-team) settings files. This wish's scope is `~/.claude/teams/*` only.
- Mutate the `permissions`, `permissions.allow`, or any non-`hooks` top-level keys.

## Related

- Wish: `.genie/wishes/spawn-compounding-defects/WISH.md`
- Inject-time dedup: `src/hooks/inject.ts` (`upsertGenieEntry`, `dedup.collapse_drift`)
- Companion test suite: `scripts/dedup-team-settings.test.ts`
- Issue: [#1710](https://github.com/automagik-dev/genie/issues/1710)
