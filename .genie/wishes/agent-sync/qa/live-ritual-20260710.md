# agent-sync — live ritual evidence (reference machine, 2026-07-10)

Executed under Felipe's `/goal` directive ("update an dogfood, if anything goes wrong, fix and repeat"), dev channel. Three iterations; the third fully clean.

## Iteration 1 — first live convergence (v5.260710.10)

```
$ genie update --dev -y        # hop 1: binary swap (old code, no sync — expected)
✔ Genie binary updated → v5.260710.10
$ genie update -y              # hop 2: short-circuit + agent-sync phase
✔ Already up to date (v5.260710.10, channel dev)
▸ agent-sync: claude — created 19, adopted 4, stamp written
▸ agent-sync: codex — created 23
▸   codex: restart Codex to pick up updated skills
▸ agent-sync: hermes — symlink created, enable ran
▸ agent-sync: backups saved to ~/.genie/state-backups/agent-sync-2026-07-10T20:20:36.149Z
```

Dogfood: **13 pass / 1 fail** — FAIL: zombie `~/.claude/skills/council` (the codex-first-class commit
e9d7d108 recreated the portable council skill; agent-sync shipped it to Claude Code, registering a
skill AND a workflow under one name — the collision council-workflow Decision 8 forbids).
→ **Fix #2547** (CLAUDE_EXCLUDED_SKILLS + orphan-removal + 3 test locks), merged to dev as 9df2d7be.

## Iteration 2 — bugs reproduced live, then fixed (v5.260710.11 → .2 → .13)

Plain `genie update -y` on the pre-fix .11 binary reproduced BOTH remaining bugs:
- persisted dev channel LOST (config clobbered with fabricated defaults by persistChannel on a failed load)
- silent DOWNGRADE .11 → .2 (stale stable manifest — itself stale because #2542 was rebase-merged,
  which skips the version.yml release trigger)

→ **Fix #2548** (tolerant channel read; raw read-modify-write persisting only updateChannel; numeric
downgrade guard — refuses without an explicit channel flag; doctor exclusion-aware), review SHIP,
merged to dev; released as .13.

## Iteration 3 — CLEAN (v5.260710.13)

```
$ genie update -y
✔ Already up to date (v5.260710.13, channel dev)     # channel PERSISTED (bug A dead)
▸ agent-sync: claude — unchanged 22, stamp skipped   # idempotent
▸ agent-sync: codex — unchanged 23
▸ agent-sync: hermes — symlink unchanged
$ grep -o '"updateChannel"[^,]*' ~/.genie/config.json
"updateChannel": "dev"                               # config intact, 30 keys preserved
```

Dogfood: **14 pass / 0 fail** —
- claude: 22 skills current + manifests; `~/.claude/workflows/council.js` stamped with absolute
  LENS_ROOT AND the string-args coercion (`typeof input === 'string'`); no zombie council skill
- codex: 23 skills in `~/.codex/skills/.curated/`; `.system` untouched
- hermes: `~/.hermes/plugins/genie -> ~/.genie/plugins/hermes-genie`, enable ran
- doctor: `claude — 22/22 source skills current; council.js current` (exclusion-aware), codex 23/23,
  hermes linked, marketplace note (disabled, optional, never mutated)
- throttle marker present; no downgrade, no clobber

## Iteration 4 — STABLE leg, CLEAN after two live fixes (2026-07-11, v5.260711.3)

PR #2545 (dev→main) human-merged; the content-match promotion verification (#2551) rode inside it,
so the merge-method footgun is structurally dead — `latest.json` advanced 5.260710.2 → 5.260711.3.

```
$ genie update --stable -y            # dev 5.260710.13 → stable 5.260711.3 (signed tarball verified)
$ genie update -y
✔ Already up to date (v5.260711.3, channel stable)   # channel persisted
▸ agent-sync: claude — unchanged 21, updated 1, stamp skipped
▸ agent-sync: codex — adopted 22, created 1, legacy-curated removed (×23 — .curated → ~/.agents/skills migration)
▸ agent-sync: hermes — symlink unchanged
```

Dogfood (codex checks updated for the agents-skills tier): **16 pass / 0 fail**; doctor all-green,
incl. `Codex Genie plugin — v5.260711.3; enabled` after the repair below.

Two bugs live-reproduced on this leg, both fixed on dev:
1. **Auto-version bump re-broke biome** — `version.ts` stamps via `JSON.stringify(_, null, 2)` and
   version.yml's format-step list was missing the codex manifest; third occurrence, turned #2545's
   Quality Gate red. → **Fix #2552** (stamp self-formats via biome; yml list completed); proven live:
   bump 5.260711.3 landed +1/−1 per file.
2. **`genie setup --codex` false "refreshed"** — the `automagik` marketplace was pinned to a deleted
   live-test worktree; the *"already added from a different source"* refusal matched the generic
   `already` tolerance and `plugin add` no-ops on an installed id, so the plugin stayed at
   v5.260710.9 while setup claimed success. → **Fix #2553** (repoint marketplace, verify + reinstall
   once, fail loudly on non-convergence); manual remove→re-add converged this machine.

Operational note: every auto-bump leaves the promotion PR's checks in `action_required` (head pushed
by github-actions[bot]); close/reopen re-triggers them under a human actor.

## Residual (tracked, not blockers here)

- Fixes #2552/#2553 are on dev only — they ship with the next routine dev→main promotion.
- One-hop aux-tree staleness: a pre-`.agents`-contract binary syncs only plugins/skills/templates on
  its last swap; the marketplace manifests arrive on the following swap (this machine was healed by
  extracting them from the verified 5.260711.3 tarball).
- council-workflow qa/ (deliberation + audit runs) remains Felipe's own ritual.
