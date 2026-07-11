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

## Residual (tracked, not blockers here)

- Stable-channel leg: pending PR #2545 (dev→main) human merge — **merge method must be "Create a
  merge commit"**; rebase/squash silently skips the stable release (version.yml:66 gate; bit #2537
  and #2542). After stable publishes: `genie update --stable -y` + re-dogfood.
- council-workflow qa/ (deliberation + audit runs) remains Felipe's own ritual.
