# Open Question 1 — Does `$GENIE_HOME/skills` exist as a stable populated path?

**Group 2 investigation · wish `hermes-homogeneous-integration`**
Status: **RESOLVED — yes, `$GENIE_HOME/skills` is a stable populated path in the current release layout.** Agent-sync does **not** need to publish it; both `genie install` and `genie update` already converge it. A fallback chain is still required for uninstalled/dev checkouts.

## Finding

`$GENIE_HOME/skills` is materialized by the two lifecycle commands, from the release tarball's top-level `skills/` tree, independently of agent-sync's per-client skill fan-out:

- **`genie update`** — `syncAuxiliaryContent()` in `src/genie-commands/update.ts:3076` mirrors the extracted tarball's `skills/` into `join(genieHome, 'skills')` (target list at `update.ts:3081-3087`). The converge is staged to a sibling `<dest>.new` and promoted with same-filesystem renames; a failed converge blocks VERSION stamping so a half-published tree never wins.
- **`genie install`** — `AUX_LAYOUT_DIRS` in `src/genie-commands/install.ts:40` is exactly `['plugins', 'skills', 'templates', '.agents', '.claude-plugin']`; `normalizeAuxLayout()` (`install.ts:59-76`, invoked at `install.ts:136`) converges the extracted `<home>/bin/skills` tree into the canonical `<home>/skills` layout that `update` then maintains.
- **Release contract** — `AGENTS.md` ("Release contract") and `plugins/genie/README.md` confirm the tarball ships the 23 canonical product skills (`skills/` is the canonical source; `plugins/genie/skills/` is the byte-checked mirror). So `extractDir/skills` is always present for the converge.

This is a **separate** mechanism from agent-sync's client-tier skill sync (`syncSkillDirsInto` → `~/.claude/skills`, `~/.agents/skills`): that path fans skills OUT to Claude/Codex homes and never targets `$GENIE_HOME/skills`. The `$GENIE_HOME/skills` root is the raw canonical payload, which is exactly what a Hermes `skills.external_dirs` entry wants to point at.

## Edge cases where it is absent

`$GENIE_HOME/skills` is populated only **after** a real `genie install`/`genie update` has run against a release tarball. It is NOT guaranteed when:

1. Running Genie from a **dev git checkout** (`bun run src/genie.ts`) without ever having installed a tarball.
2. A brand-new `$GENIE_HOME` before the first `install`/`update` completes.
3. A partially-failed converge (mitigated: failure blocks stamping and retains the verified-fresh artifact, so a stale/empty tree does not silently win).

## Recommendation

1. **Do not add agent-sync publishing for `$GENIE_HOME/skills`.** It would duplicate `syncAuxiliaryContent`/`normalizeAuxLayout` and create a second writer to the same tree. The existing install/update converge is authoritative.
2. **The Group 2 skills helper resolves a product-skills root via a documented fallback chain**, preferring the installed layout and degrading safely on dev checkouts:
   - (a) `$GENIE_HOME/skills` when populated (installed layout — the canonical answer).
   - (b) `$GENIE_HOME/plugins/genie/skills` (the byte-checked plugin mirror, also converged by install/update) when (a) is empty.
   - (c) an explicit `skillsRoot` override option (dev checkouts point this at the repo's `skills/`).
   - typed error if none resolves — never silently register a non-existent dir into Hermes config.
   The helper treats "populated" as "directory exists and contains at least one `*/SKILL.md`", so a stub/empty dir does not shadow a real mirror. This chain is implemented as `resolveProductSkillsRoot()` in `src/lib/hermes-skills-config.ts`.
3. **Group 4 wiring guidance:** invoke the `skills.external_dirs` merge from the doctor/agent-sync integration point **only after** a successful `install`/`update` convergence, so the registered path is already populated. For the older-Hermes copy fallback (Hermes builds without external-dir support), Group 2 ships a digest-managed copy behind an explicit option (`copyProductSkillsDigestManaged`) that stages the same resolved root into a Hermes-managed skills dir idempotently.

## Evidence pointers

- `src/genie-commands/update.ts:3076-3099` — `syncAuxiliaryContent` targets incl. `{ src: extractDir/skills, dest: genieHome/skills }`.
- `src/genie-commands/install.ts:40,59-76,136` — `AUX_LAYOUT_DIRS` incl. `skills`; `normalizeAuxLayout` converge.
- `src/lib/agent-sync.ts:1173-1181,2127,2152-2153` — client-tier skill fan-out (distinct mechanism; does not write `$GENIE_HOME/skills`).
- `AGENTS.md` Release contract; `plugins/genie/README.md` (23 canonical product skills, `/skills` canonical + plugin mirror).
