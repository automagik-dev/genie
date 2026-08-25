# /council — Overnight QA Observations (2026-07-10)

**Context:** first real `/council` dogfood of the overnight run — a lens council deliberation (3 lenses, 2 rounds) plus the live-QA ritual against the stamped `~/.claude/workflows/council.js`. These are the observations to fold into the council-workflow **final execution review**, which stays pending Felipe's live-QA tail (`/council "revisar tudo"`) after the next stable release.

---

## Defect found and fixed: stamped `council.js` rejected string args

**Symptom.** Invoking the stamped `/council` with a string argument dead-ended three times in a row with `"No input received"` — the workflow never entered its Resolve phase.

**Root cause.** The Claude Code **Workflow runtime stringifies** saved-workflow input before handing it to the script. The stamped `council.js` demanded an **object**-shaped argument and treated the incoming string as empty, so it fell through to the no-input branch. This is a runtime-contract mismatch, not a logic bug in the deliberation flow: the script's own arg-parsing assumed a shape the runtime does not deliver for saved workflows.

**Fix.** Coerce a string argument into the expected shape at the workflow entry point (accept both a raw string topic and the object form). Validated **live** on a patched copy of the script first (the string invocation reached Resolve → Round 1), then upstreamed by the owning session and merged to dev as **`ec68cd8f`** (`fix(workflows): coerce string args in /council — runtime stringifies saved-workflow input`). Verified present on `origin/dev` in tonight's run.

## Secondary observation: skill-text vs script-contract mismatch

The `/council` **skill instruction text** tells the caller to pass arguments **as a string**, while the **pre-fix script** demanded an **object**. Before `ec68cd8f` these two contracts disagreed, which is exactly the surface the defect lived on. **Post-fix both work** — the coercion accepts the string form the skill text advertises and the object form the earlier script expected. No doc change is required now that the script tolerates both, but the final execution review should record that the skill text and the script contract were briefly out of sync and are now reconciled by coercion rather than by narrowing either side.

## Related note carried from the wish record

The stamp mechanism fired only on **SessionStart**, so a mid-session `/plugin update` left a stamping gap (worked around by running `smart-install.js` manually, plugin cache 5.260710.2). That SessionStart-only trigger gap is the premise **agent-sync** was built to close (agent-sync merged to dev 2026-07-10 via PR #2541); re-confirm the stamp path after the next stable release + `genie update` ×2.

---

## Still pending (USER-GATED, post-stable-release)

1. **Live-QA ritual** — Felipe runs `/council "revisar tudo"` against the released, self-synced `council.js`. This exercises the string-args path end-to-end on the shipped artifact (not a patched copy).
2. **Final execution review** — written after the ritual; the g5-gate parks in this `qa/` directory until then. It should incorporate this defect story and the deliberation-quality observations from the first 3-lens / 2-round dogfood.
