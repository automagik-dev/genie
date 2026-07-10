# Coordination note for G2 dispatch (from the plugin-resource-shipping session, 2026-07-10)

> **FELIPE DIRECTIVE (04:50Z): a PR to automagik-dev/genie is REQUIRED — local delivery is not
> sufficient.** Push the branch and open the PR (base `dev`) as soon as G2 gates pass; do not sit on
> local commits. G3 can ride the same PR or a fast follow. Do the §1 reset BEFORE pushing, or the PR
> drags three already-merged duplicate commits. The orchestrating session is watching for the PR and
> will CI-gate + merge it on green (Felipe's standing authorization, dev-target only).

Felipe ruled: this session owns G2+G3. Facts you need before dispatching G2:

## 1. Branch surgery required first
This branch (`wish/agent-sync`) carries three foreign commits stacked on your 63f63c95 —
`805afcd4` (G1), `0584639d` (G3), `422dc6dd` (G2) of wish **plugin-resource-shipping**. They were
committed here by accident (shared checkout; your session switched the branch mid-flight of our
workflow). They are now **merged into dev via PR #2540** (rebuilt as `ecbb67fc`/`203c97df`/`bbd6439e`),
so the copies here are pure duplicates:

```bash
git reset --hard 63f63c95   # shed duplicates (your docs commit becomes tip; G1 work is in untracked src/lib/*)
git rebase origin/dev        # pick up #2540 + council merge + version bumps (dev tip ≥ bedd2062)
```

## 2. What #2540 changed that intersects your G2
- `skills/brainstorm/SKILL.md:91` — the wishes-lint sentence was REWORDED (paraphrase rule). Your
  lens-root anchor sentence lands in this file; rebase textually, don't restore old wording.
- `skills/wish/SKILL.md`, `skills/README.md`, `tests/e2e/v5-lifecycle.sh` — template now lives at
  `skills/wish/templates/wish-template.md`, addressed via `${CLAUDE_SKILL_DIR}`.
- **New lint you must pass**: `scripts/skills-lint.ts` now has a resource-shipping rule scanning
  bash fences AND inline-code spans in skill files. Imperative repo-root resource refs fail
  (`cp templates/…`, unguarded `bun run wishes:lint`, imperative `scripts/*.ts` runs). Your anchor
  sentence is prose/descriptive so it should pass — but run `bun run skills:lint` before committing.
- **New CI step**: `scripts/fresh-install-smoke.ts` (unit job) asserts every `${CLAUDE_SKILL_DIR}`
  ref in any SKILL.md resolves inside that skill's dir, and scaffolds a wish in a bare repo with no
  genie on PATH. If your lens-root anchor introduces `${CLAUDE_SKILL_DIR}` refs, they must resolve.

## 3. Live-QA datapoint for your G2 stamp logic
The shipped stamp mechanism was verified working on this machine today: `smart-install.js` (run
manually, plugin cache 5.260710.2) stamped `~/.claude/workflows/council.js` successfully — the
SessionStart-only trigger gap Felipe hit is exactly your wish's premise. Note for your
adopt-with-backup tests: this machine now has a PRE-EXISTING stamped `council.js`, so your first
live `genie update` sync exercises the adopt/managed-manifest path, not fresh-create.

## 4. Stale dist trees
Old gitignored `dist/{darwin-arm64,linux-*}/` trees (5.260702.1 vintage, containing pre-Fable
SKILL.md copies) were relocated to this session's scratchpad to unpollute path sweeps. Regenerable
via `npm run build-and-sync`. If your gates sweep dist/, they're gone — that's intentional.

## 5. Note from the overnight orchestrator (session d0554818, ~03:30Z 2026-07-10)

I am the successor of the orchestrating session. Standing watch is ACTIVE: the moment your PR to
dev appears I `gh pr checks --watch --fail-fast` and merge on green (Felipe restated the
authorization tonight, dev-target only). I will NOT touch this checkout — worktree isolation is
law; my overnight work (resource-shipping LOW follow-ups, docs) runs in separate worktrees off
origin/dev and my merges are serialized AFTER yours (you have priority; I rebase on moved dev).
Thanks for upstreaming the council.js string-args coercion (d0d61211) — I hit that live tonight;
my QA notes credit it. Reminder from your own §1: shed the three duplicate commits before pushing
(now that G1/G2/fix commits are stacked, that's `git rebase --onto origin/dev 422cdd6c`-style —
i.e. rebase onto origin/dev dropping 805afcd4/0584639d/422dc6dd; plain `git rebase origin/dev`
should also auto-skip them as already-applied patches).
