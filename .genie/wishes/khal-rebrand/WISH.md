# Wish: khal-rebrand — the UI is Khal, the tether to syv is cut

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `khal-rebrand` |
| **Date** | 2026-07-22 |
| **Author** | Felipe (7 explicit picks) + Fable orchestrator (derivations flagged in Decisions) |
| **Appetite** | medium |
| **Branch** | `wish/khal-rebrand` (docs in genie). Fork code: execution groups branch off fork `main` (`khal-os/genie-desktop`, working copy `~/prod/genie-ui-ab/dash-fork`), push plain branches, merge server-side (`gh api -X POST repos/khal-os/genie-desktop/merges`). Remote trap until Group 5 lands: local `main` in the Linux working copy tracks UPSTREAM syv-ai/dash — never build/push there. |
| **Repos touched** | dash fork (khal-os/genie-desktop): all code/config/CI/docs; genie (this repo): wish docs only |
| **Design** | _No brainstorm — direct wish_ |

## Summary

Rebrand the forked desktop app from Dash (syv-ai) to **Khal**: product name, appId `ai.khal.genie`, per-project dirs, the `DASH_*` PTY env contract, in-app strings, update path, CI workflow, and docs — and cut the upstream tether (Felipe: "i dont intend to keep pulling updates from them"). Fresh start on app state: **no data migration** (Felipe's explicit pick — the rename moves Electron userData and the app's SQLite DB; old state is abandoned in place, not deleted). The MIT license notice from syv is retained; rebrand is identity, not attribution-stripping.

## Scope

### IN

- Product identity: `package.json` name/description/`productName: Khal`/`appId: ai.khal.genie`/`author: Automagik Genie <genie@namastex.ai>`, `app.setName('Khal')`, electron-builder `publish` block → `khal-os/genie-desktop`, artifact names, Makefile override cleanup.
- CI: `.github/workflows/build.yml` — `Khal.app` codesign path, `Khal-*` artifact names, release job consistent with the khal-os publish target (it checks out the fork, so `gh release create` already lands there; naming and paths must not break at `productName: Khal`).
- Update path: `electron-updater`/`AutoUpdateService` (the REAL packaged-app path) absorbs private-repo feed failures silently (log only, no user-visible error; genuine update flow preserved), feed follows the Group 1 publish block; dev-only `getDevVersion()` repointed; release-notes links and update toast → khal-os/genie-desktop.
- Machine-contract rename: per-project dir `.dash/` → `.khal/` via ONE shared constant (179 literal occurrences / 39 files, compound forms included); skills marker filenames `.dash-skill.json`/`.dash-skill-checked.json`/`.dash-tmp` → `.khal-*` via their OWN constants with the legacy in-tree migration logic removed (fresh start); the `DASH_*` namespace → `KHAL_*` — 14 distinct tokens verified in-tree: 5 injected PTY env vars, `__DASH_ZDOTDIR`, and 8 non-env JS identifiers (exact partition with source citations in Group 3 deliverable 3).
- Human-facing sweep: "Dash" strings across src (~71 files), `PortsSetupPrompt` canonical paragraph → Khal + `https://github.com/khal-os/genie-desktop`, commit co-author trailer → `Automagik Genie <genie@namastex.ai>`, `syv.ai` links → the fork repo URL, default clone dir `~/Dash` → `~/genie`.
- Docs + repo hygiene: README rewrite, GENIE.md, Makefile comment, LICENSE keeps the syv MIT copyright line and adds the new one, ITERATE.md remote-topology rewrite.
- Upstream detachment: remove the syv-ai remote from working copies, promote the fork to `origin` everywhere.
- Icon/visual asset swap (`build/icon.icns`, `icon.svg`, `build/win/`) — **blocked until Felipe supplies assets** (his pick: "You'll supply assets").

### OUT

- **Data migration of any kind** — no userData copy, no `.dash/` → `.khal/` content migration, no `~/Dash` clone moves, no genie.db moves. Felipe explicitly chose fresh start; the earlier queued idea (".dash → .genie/desktop + ~/.genie/...") is SUPERSEDED (Decision 3).
- The syv plugin marketplace: `SYV_MARKETPLACE_REPO`, `SYV_MARKETPLACE_NAME`, `SYV_PLUGIN_ID` (`syv-skills@syv-skills`) in `PluginsService.ts` AND the `.claude/settings.json` `syv-skills@syv-skills` entry are KEPT verbatim (Felipe's pick: content source, not branding) and are excluded from every sweep and every "no syv" gate.
- The genie CLI, ui-bridge protocol, and `.genie/genie.db` contract — untouched; this wish is fork-side identity only. (Verified: genie repo src has zero `DASH_` references — the env rename breaks nothing cross-repo.)
- Making khal-os/genie-desktop public or changing release visibility — the update path must degrade silently while private, not force a visibility change.
- Renaming the GitHub repo itself (stays `khal-os/genie-desktop`).
- Backward-compat shims for `DASH_*` env vars or legacy `.dash-skill` markers — clean break, one-time cost accepted.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Product name **Khal**, appId **`ai.khal.genie`** | Felipe verbatim: "ai.khal.genie the ui is going to be khal only". |
| 2 | **Fresh start, no migration** | Felipe's explicit pick, made with the data-loss consequence stated. Old dirs/userData left in place as manual backup, never deleted. Extends to skills markers: legacy `.dash-skill.json` markers are unrecognized post-rename; skills re-verify once. |
| 3 | Per-project dir = **`.khal/`**, userData = **"Khal"** — DERIVED, veto point | Derived from "the ui is going to be khal only". Supersedes the earlier ".dash → .genie/desktop" idea, which predates the Khal naming. Single-constant design makes a veto a one-line change. |
| 4 | Update path: **silent degrade while private, via the real path** | Felipe picked "repoint + graceful degrade". Plan review proved the real packaged path is `electron-updater`/`AutoUpdateService` (dev-only `getDevVersion()` never runs shipped); silence is implemented and tested THERE. Feed itself follows the electron-builder publish block. |
| 5 | LICENSE keeps the syv MIT copyright notice | MIT requires it. New copyright line added above; syv attribution stays in LICENSE. Founder emails leave `package.json` `author` (Decision 6 replaces it) — LICENSE is where upstream credit lives. |
| 6 | Attribution identity = **`Automagik Genie <genie@namastex.ai>`** | Felipe verbatim: "author Automagik Genie genie@namastex.ai". Applied to `package.json` `author` AND the commit co-author trailer (replacing `via Dash <dash@syv.ai>`). |
| 7 | `DASH_*` → **`KHAL_*`**, the full namespace (5 injected env vars + `__DASH_ZDOTDIR` + 8 non-env identifiers), no dual-export | Felipe's pick. Breaks any personal scripts reading `DASH_*` from PTYs — accepted one-time cost, consistent with no-upstream fresh break. |
| 8 | Default clone dir = **`~/genie`** | Felipe verbatim: "genie man, genie...". Not `~/Khal`; existing `~/Dash` clones untouched and keep working. |
| 9 | One shared constant per contract name, then sweep | 179 raw `.dash` literals across 39 files is the defect, not just the name. Project dir, each skills marker, and the env prefix each get exactly one defining constant. |
| 10 | Execution waits behind the two in-flight QA wishes | Rebranding ~100 files mid-QA would muddy genie-ui-dash and live-dev-loop evidence; see Dependencies. |

## Dependencies

**depends-on:** genie-ui-dash, live-dev-loop
**blocks:** none

## Success Criteria

- [ ] `rg -i syv` over the fork (excluding node_modules/dist/release/.git) hits ONLY: the LICENSE upstream copyright notice, the three `SYV_*` marketplace constants in `PluginsService.ts` (+ their direct tests/references), and the `.claude/settings.json` `syv-skills@syv-skills` entry.
- [ ] `grep -rE '\.dash([^a-zA-Z]|$)' src` → zero (catches `.dash/ports.json`, `.dash-skill.json`, `.dash-tmp`, all compound forms); each contract name (project dir, each marker, env prefix) has exactly one defining constant, all consumers import it.
- [ ] `grep -rE '(_*)DASH_[A-Z_]+' src` → zero — the `(_*)` prefix is load-bearing: `\bDASH_` misses `__DASH_ZDOTDIR` (ptyShellConfig.ts ×3) because the underscore defeats the word boundary. PTYs receive the same var set under `KHAL_*` (test asserts the injected-env key set).
- [ ] Launched app: menu/dock name **Khal**, `app.getPath('userData')` ends in `Khal`, fresh state on first launch, no read of legacy `.dash/`, Dash userData, or legacy skill markers.
- [ ] Packaged-path update check: `AutoUpdateService` on a private-repo/unreachable feed produces NO user-visible error (asserted by a new test); genuine update-available flow unchanged; feed target derives from the khal-os publish block.
- [ ] Release-notes and toast links point to `https://github.com/khal-os/genie-desktop/...`; dev-only `getDevVersion()` repointed.
- [ ] `package.json` `author` is exactly `Automagik Genie <genie@namastex.ai>`; the app's commit trailer is exactly `Co-Authored-By: Claude <noreply@anthropic.com> via Automagik Genie <genie@namastex.ai>` — the existing trailer STRUCTURE is preserved (Felipe chose the identity, not a format change; dropping the Claude co-author line would be an unchosen behavior change).
- [ ] New-project default clone destination is `~/genie` (UI placeholder matches).
- [ ] `.github/workflows/build.yml` is green end-to-end at `productName: Khal`: codesign path `Khal.app`, `Khal-*` artifacts, release job unchanged in target (the fork).
- [ ] `make mac` publishes a `Khal-<version>-mac-arm64.dmg` release to khal-os/genie-desktop with NO command-line publish overrides.
- [ ] LICENSE contains both the syv MIT notice and the new copyright line.
- [ ] Full fork suite ≥ baseline (118 files / 1085 pass / 1 skip) and `pnpm run type-check` green after every group.
- [ ] Linux working copy remotes: `origin` = khal-os/genie-desktop only; ITERATE.md describes the new topology.

## Execution Strategy

### Wave 1 (parallel — disjoint files)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 (+1 CI/release, +1 multi-surface config, +1 release-model reconciliation) | engineer-standard / high | Core identity + CI workflow |
| 2 | engineer | 3 (+2 stateful update lifecycle, +1 no deterministic live test) | engineer-standard / high | Real update path + release feeds |

### Wave 2 (sequential — overlapping file sets, after Wave 1 merges)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 4 (+2 stateful machine-contract rename, +1 multi-surface 39+ files, +1 prior-rework risk from compound literals) | engineer-complex / high | Machine contracts: `.khal` dir, skill markers, `KHAL_*` env |
| 4 | engineer | 2 (wide but mechanical; +1 subjective prompt tone) | engineer-standard / medium | Human-facing sweep: strings, trailer, links, `~/genie` |

### Wave 3 (after Waves 1–2)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 5 | engineer | 1 (docs + scripted remote surgery) | engineer-trivial / low | Docs, LICENSE, remote detachment, ITERATE.md |
| 6 | engineer | 1 (asset drop-in) — **blocked-on-asset** | engineer-trivial / low | Icon swap once Felipe supplies art |

## Execution Groups

### Group 1: Core identity + CI workflow

**Goal:** The app builds, signs, publishes, and passes CI as Khal (`ai.khal.genie`) targeting khal-os/genie-desktop, with package.json as the single source of publish truth.

**Deliverables:**
1. `package.json`: `name: "khal"`, description rewritten, `author: "Automagik Genie <genie@namastex.ai>"`, `build.appId: "ai.khal.genie"`, `build.productName: "Khal"`, `build.publish` → `{ owner: "khal-os", repo: "genie-desktop" }`.
2. `src/main/entry.ts`: `app.setName('Khal')` (comment: userData moves; fresh start intentional, no migration).
3. `Makefile`: remove the now-redundant `-c.publish.*` overrides and the syv comment; keep the macOS/GH_TOKEN guards.
4. `.github/workflows/build.yml`: `APP_PATH` → `release/mac-arm64/Khal.app`, artifact names `Khal-mac-arm64`/`Khal-linux-x64`/`Khal-windows-x64`, release job verified consistent (it releases on the checked-out repo — the fork — via `gh release create`; document in the workflow that package.json `publish` is authoritative for `make mac` and the workflow mirrors the same target).
5. Tests asserting old name/appId updated.

**Acceptance Criteria:**
- [ ] `node -e` assertion on appId/productName/publish/author passes (see Validation).
- [ ] `rg -i syv Makefile .github/workflows/build.yml` → zero; the only syv in `package.json` is none (author replaced; no other fields carry it).
- [ ] `! grep -q 'Dash' .github/workflows/build.yml` AND all three `Khal-mac-arm64`/`Khal-linux-x64`/`Khal-windows-x64` artifact names present — the `Dash-*` artifact names are "dash" not "syv" and live outside `src/`, so no other group's gate would catch a leftover.
- [ ] `pnpm run type-check` and the full suite pass; workflow YAML parses (`node -e "require('js-yaml')..."` or `gh workflow view` after merge).

**Validation:**
```bash
export PATH="$HOME/.hermes/node/bin:$PATH" && cd ~/prod/genie-ui-ab/dash-fork && node -e "const p=require('./package.json'); const b=p.build; if(b.appId!=='ai.khal.genie'||b.productName!=='Khal'||b.publish.owner!=='khal-os'||b.publish.repo!=='genie-desktop'||p.author!=='Automagik Genie <genie@namastex.ai>')process.exit(1)" && ! grep -riq syv package.json Makefile .github/workflows/build.yml && grep -q "setName('Khal')" src/main/entry.ts && grep -q 'Khal.app' .github/workflows/build.yml && ! grep -q 'Dash' .github/workflows/build.yml && grep -q 'Khal-mac-arm64' .github/workflows/build.yml && grep -q 'Khal-linux-x64' .github/workflows/build.yml && grep -q 'Khal-windows-x64' .github/workflows/build.yml && pnpm run type-check && pnpm test
```

**depends-on:** none

---

### Group 2: Real update path + release feeds

**Goal:** The packaged app's update machinery targets khal-os/genie-desktop and fails SILENTLY while the repo is private; every release-facing link points at the fork.

**Deliverables:**
1. `src/main/services/AutoUpdateService.ts`: suppression boundary is LIFECYCLE-STATE-BASED, not error-content-based — suppress the `autoUpdate:error` renderer event while `state === 'checking'` (that's where a private/unreachable feed fails); keep surfacing errors during `downloading`/install. Content-classifying electron-updater error messages is fragile; state is testable. Also remove the per-check `console.error` noise (AutoUpdateService.ts:138). New test file covering: check-phase feed failure → no renderer error event; download-phase error → still surfaced; update-available path unchanged. (Ground truth, CORRECTED by ledger-verify 2026-07-23: the renderer has TWO `onAutoUpdateError` subscribers — `SettingsModal.tsx:799` resets spinner state only, but `Toast.tsx:79-86` shows a user-visible `toast.error` (10s, "Download manually" action) gated by `updateNotificationsEnabled`, which DEFAULTS TO TRUE. A private-feed check failure today therefore produces a visible error toast — suppressing at the main-process source while `checking` silences both subscribers at once, which is precisely why the boundary lives in `AutoUpdateService`, not the renderer. The feed URL derives from the electron-builder publish block — Group 1.)
2. `src/main/ipc/appIpc.ts`: dev-only `getDevVersion()` fetch → `https://api.github.com/repos/khal-os/genie-desktop/releases/latest`, `User-Agent: khal-app` (stays dev-only; existing local-version fallback preserved).
3. `src/renderer/utils/releaseNotes.ts`: `RELEASE_TAG_BASE` → `https://github.com/khal-os/genie-desktop/releases/tag`; `releaseNotes.test.ts` updated.
4. `src/renderer/components/ui/Toast.tsx`: latest-release link → khal-os/genie-desktop.

**Acceptance Criteria:**
- [ ] `grep -rn 'syv-ai/dash' src/main/services/AutoUpdateService.ts src/main/ipc/appIpc.ts src/renderer/utils/releaseNotes.ts src/renderer/utils/__tests__/releaseNotes.test.ts src/renderer/components/ui/Toast.tsx` → zero (gate scoped to THIS group's files; `PortsSetupPrompt.ts` belongs to Group 4).
- [ ] New AutoUpdateService test fails if a feed-unavailable error reaches the renderer.

**Validation:**
```bash
export PATH="$HOME/.hermes/node/bin:$PATH" && cd ~/prod/genie-ui-ab/dash-fork && ! grep -q 'syv-ai/dash' src/main/services/AutoUpdateService.ts src/main/ipc/appIpc.ts src/renderer/utils/releaseNotes.ts src/renderer/utils/__tests__/releaseNotes.test.ts src/renderer/components/ui/Toast.tsx && pnpm test -- releaseNotes && pnpm test -- AutoUpdate && pnpm run type-check
```

**depends-on:** none

---

### Group 3: Machine contracts — `.khal` dir, skill markers, `KHAL_*` env

**Goal:** Every machine-readable name the app writes or injects is khal-branded, each defined exactly once; legacy names are dead to the app (never read, never deleted, no shims).

**Deliverables:**
1. `PROJECT_DIR_NAME = '.khal'` exported from one module importable by main, renderer, and `src/types` (respect existing layering); ALL compound uses (`.dash/ports.json`, `.dash/config.json`, `.dash/ports.local.json`, `.dash/setup.sh`, …) derive from it. The three duplicated per-file consts `const DASH_DIR = '.dash'` (`WorkspaceConfigService.ts:5`, `PortsConfigWatcher.ts:19`, `WorkspacePortsService.ts:4`) FOLD INTO this import — `DASH_DIR` is a JS path const, NOT an env var; do not create a `KHAL_DIR` alongside `PROJECT_DIR_NAME` (Decision 9: one constant per contract).
2. Skills markers in `SkillsService.ts`: `MARKER_FILENAME` → `.khal-skill.json`, `VERIFIED_CUSTOM_FILENAME` → `.khal-skill-checked.json`, tmp suffix → `.khal-tmp` — kept as their OWN constants (not folded into `PROJECT_DIR_NAME`); the legacy in-tree→central migration block is REMOVED (fresh start: legacy `.dash-skill.json` markers unrecognized; re-verify is idempotent — asserted by test).
3. `DASH_*` → `KHAL_*` across the full namespace, correctly partitioned (ledger-verify round-2 census, cited to source):
   - **Injected PTY env vars (5)** — the actual env contract: `DASH_HOOK_PORT` (ptyManager.ts:336) and `DASH_TASK_ID`/`DASH_BRANCH`/`DASH_WORKTREE_PATH`/`DASH_PROJECT_PATH` (WorkspaceConfigService.ts:183-187) → `KHAL_*`, plus any others the sweep finds. Deliverable 4's test asserts THIS 5-key set (plus sweep finds) — not a larger phantom set.
   - **Shell var (1)**: `__DASH_ZDOTDIR` → `__KHAL_ZDOTDIR` (ptyShellConfig.ts ×3).
   - **JS identifier consts (8)** — renamed as identifiers for namespace hygiene, NOT env-contract changes: `DASH_DIR` (folds into `PROJECT_DIR_NAME`, deliverable 1), `DASH_HOOK_EVENTS`, `DASH_HOOK_ENDPOINTS`, `DASH_ENDPOINT_SET`, `DASH_DEFAULT_ATTRIBUTION`, `DASH_URL_FULL_RE`, `DASH_URL_SUBSTR_RE`, and `DASH_BASE64_DECODE_RE`. Locations: the hook/URL/endpoint/base64 consts live in hookSettingsMerge.ts; `DASH_DIR` per deliverable 1; `DASH_DEFAULT_ATTRIBUTION` is defined in SettingsModal.tsx:60-61 AND ptyHookSettings.ts:30-31 (Group 3 renames the identifier; Group 4 owns its VALUE change — sequential, no conflict). The gate regex catches `DASH_BASE64_DECODE_RE` via its `DASH_BASE` prefix — the digit-less `[A-Z_]+` class stops at `64`, which is fine for a must-be-zero gate.
   Generated `setup.sh`/export-file content follows the env renames. No dual-export, no `KHAL_DIR` const (deliverable 1).
4. All fixtures/tests updated; a test asserts the PTY injected-env key set is `KHAL_*`-complete with no `DASH_*` remnant.

**Acceptance Criteria:**
- [ ] `grep -rE '\.dash([^a-zA-Z]|$)' src` → zero.
- [ ] `grep -rE '(_*)DASH_[A-Z_]+' src` → zero (`(_*)` catches `__DASH_ZDOTDIR`; `\b` does not).
- [ ] Raw `'.khal'`-style literals exist ONLY in the defining modules (one per contract name). This has no scripted gate — the greps prove absence elsewhere, not single-definition — so the group's completion note MUST enumerate each defining module (project dir, each skills marker, env prefix) for the reviewer to verify.
- [ ] Opening a project creates `.khal/`; existing `.dash/` and legacy markers are never read or deleted.

**Validation:**
```bash
export PATH="$HOME/.hermes/node/bin:$PATH" && cd ~/prod/genie-ui-ab/dash-fork && ! grep -rqE '\.dash([^a-zA-Z]|$)' src && ! grep -rqE '(_*)DASH_[A-Z_]+' src && pnpm test && pnpm run type-check
```

**depends-on:** group-1, group-2

---

### Group 4: Human-facing sweep — strings, trailer, links, `~/genie`

**Goal:** No user-visible surface says Dash, credits syv outside LICENSE/marketplace, or clones into `~/Dash`.

**Deliverables:**
1. Sweep the ~71 src files mentioning `Dash`: UI strings, titles, aria labels, product-describing comments.
2. `src/main/services/PortsSetupPrompt.ts`: canonical paragraph rewritten for Khal with `https://github.com/khal-os/genie-desktop` as the only URL to cite.
3. Commit co-author trailer: the full default attribution string in `SettingsModal.tsx:60-61` and `ptyHookSettings.ts:30-31` becomes exactly `\n\nCo-Authored-By: Claude <noreply@anthropic.com> via Automagik Genie <genie@namastex.ai>` — structure preserved, only the `via` identity replaced (label text updated to match); `https://syv.ai` links → `https://github.com/khal-os/genie-desktop`.
4. Default clone destination: `~/Dash` → `~/genie` (`gitIpc.ts:30`, `LocationStep.tsx:172` placeholder, related tests). Existing `~/Dash` clones untouched.
5. EXCLUDED from this sweep: the three `SYV_*` marketplace constants, `.claude/settings.json` `syv-skills@syv-skills`, LICENSE, and false positives (CSS `dashed`, generic `dashboard`, third-party identifiers) — each surviving `\bDash\b` match listed and justified in the completion note.

**Acceptance Criteria:**
- [ ] `rg '\bDash\b' src` returns only the justified list from the completion note.
- [ ] `grep -rn 'syv' src` hits only `PluginsService.ts` marketplace constants (+ their tests).
- [ ] Full suite green.

**Validation:**
```bash
export PATH="$HOME/.hermes/node/bin:$PATH" && cd ~/prod/genie-ui-ab/dash-fork && ! grep -rq 'syv-ai/dash' src && ! grep -rq 'dash@syv.ai' src && grep -q 'genie@namastex.ai' src/main/services/ptyHookSettings.ts && grep -rq "'genie'" src/main/ipc/gitIpc.ts && pnpm test && pnpm run type-check
```

**depends-on:** group-3

---

### Group 5: Docs, LICENSE, and upstream detachment

**Goal:** Docs describe Khal; the syv remote is gone from working copies; the MIT notice survives; the kept marketplace is untouched.

**Deliverables:**
1. README.md rewritten for Khal (what it is, `make desktop`, `make mac`, dev:web/dev:live loops).
2. GENIE.md syv/dash references updated. `.claude/settings.json` is NOT touched (its only syv content is the kept marketplace plugin id).
3. LICENSE: add the new copyright line, RETAIN the syv MIT notice beneath it.
4. Remote surgery, Linux working copy: remove the syv-ai remote, rename `khal` → `origin`, re-track local `main` to the fork. Executed on the box; commands recorded in the group note.
5. ITERATE.md: remote-trap paragraph rewritten for the single-remote topology.

**Acceptance Criteria:**
- [ ] `git remote -v` shows only the fork, as `origin`.
- [ ] `grep -i syv LICENSE` shows exactly the retained MIT notice; `rg -i syv README.md GENIE.md ITERATE.md` → zero; `.claude/settings.json` unchanged (git diff empty for it).

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && test "$(git remote | tr '\n' ' ')" = "origin " && git remote get-url origin | grep -q 'khal-os/genie-desktop' && grep -qi 'syv' LICENSE && ! grep -qi 'syv' README.md GENIE.md ITERATE.md
```

**depends-on:** group-1, group-4

---

### Group 6: Icon and visual assets — blocked-on-asset

**Goal:** The app, DMG, and window icons are Khal art, not the Dash icon.

**Deliverables:**
1. Replace `build/icon.icns`, `build/icon.svg`, `build/win/*` with Felipe-supplied Khal assets.
2. Verify packaged artifacts (dock icon, DMG volume icon, window icon on Linux) render the new art.

**Acceptance Criteria:**
- [ ] `make mac` artifact shows Khal iconography end to end — **manual QA gate**: this group's acceptance is human-verified at packaging time; there is deliberately no scriptable assertion on binary art.
- [ ] No Dash-era binary assets remain under `build/` (checked by asset checksums differing from the Dash-era ones recorded in the group note).

**Validation:**
```bash
cd ~/prod/genie-ui-ab/dash-fork && test -f build/icon.icns && test -f build/icon.svg
# Iconography itself is a manual QA gate — packaged-app visual check by Felipe.
```

**depends-on:** group-1 _(and Felipe-supplied assets — do not start until they exist)_

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Launch the packaged (or `make desktop`) app: dock/menu says **Khal**; a FRESH userData dir named `Khal` is created; no read of Dash userData, `.dash/`, or legacy skill markers.
- [ ] Open a genie repo project: `.khal/` appears with ports/config files inside; a PTY spawned in a task shows `KHAL_*` env vars and zero `DASH_*`; terminals/PTY flows work end to end.
- [ ] New-project wizard defaults its clone destination under `~/genie`.
- [ ] A commit made from the app carries the exact trailer `Co-Authored-By: Claude <noreply@anthropic.com> via Automagik Genie <genie@namastex.ai>`.
- [ ] With khal-os/genie-desktop private: no update-error toast/banner appears at launch or on manual check; release-notes/toast links open khal-os/genie-desktop.
- [ ] `make mac` on Felipe's Mac produces `Khal-<version>-mac-arm64.dmg`, signed, published as a khal-os/genie-desktop GitHub release; CI workflow green on fork `main`.
- [ ] Regression: full suite ≥ 118 files / 1085 pass; dev:web + dev:live loops still work post-rebrand.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Fresh start abandons existing app state (projects list, settings, roster history, skill-marker verification) | Low (accepted) | Felipe chose this knowingly; old dirs left in place, recoverable by hand. Skills re-verify once; idempotence asserted by test. |
| `.khal/` and "Khal" userData are DERIVED names | Medium | Decision 3 is a named veto point at plan review; single-constant design makes a rename one line. |
| `KHAL_*` rename breaks external scripts reading `DASH_*` from PTYs | Low (accepted) | Felipe's explicit pick, no dual-export; one-time cost. |
| Silencing check-phase update errors could mask genuine update failures | Medium | Suppression is lifecycle-state-based (`checking` only); `downloading`/install errors still surface; test pins the boundary. |
| NO auto-updates arrive at all while khal-os/genie-desktop is private | Low (accepted) | electron-updater cannot read private-repo releases without a token; `make mac` + manual install is the update channel until the repo goes public or a token is provisioned. Stated so dogfood users aren't surprised. |
| Rebrand churn collides with in-flight QA evidence | Medium | Wish-level depends-on: genie-ui-dash + live-dev-loop must reach SHIPPED first. |
| CI workflow has its own release path alongside `make mac` | Low | Group 1 aligns naming/paths and documents package.json `publish` as the shared target of truth; both paths land on the fork. |
| Upstream detachment means future syv fixes arrive only by manual cherry-pick | Low (accepted) | Felipe: "i dont intend to keep pulling updates from them." |
| Icon assets never arrive → Dash icon ships under Khal name | Medium | Group 6 is a formal blocked-on-asset gate; release QA criterion fails until art lands. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review — 2026-07-22 — VERDICT: FIX-FIRST

Reviewer (independent, read fork code directly; agent ab99c10ec1bf4f6c1):

1. **[HIGH] Wrong update path targeted.** `getDevVersion()` in `appIpc.ts` is gated by `!app.isPackaged` — it never runs in a shipped app. The real production update path is `electron-updater` via `src/main/services/AutoUpdateService.ts`, which on a private-repo 404 fires `autoUpdater.on('error')` → visible `autoUpdate:error`. Group 2 must cover AutoUpdateService (repoint feed via the publish block, absorb private-repo failures silently, add the missing test).
2. **[HIGH] Group 3 gate too narrow.** Bare `'.dash'`/`".dash"` greps match only 32 of 179 occurrences; compound literals (`.dash/ports.json` ×55, `.dash/config.json` ×26 _[×27 per ledger-verify r3 recount]_, `.dash-skill.json` ×16, …) would survive a green gate.
3. **[HIGH] Group 2 gate un-passable at its wave** — `! grep 'syv-ai/dash' src` includes `PortsSetupPrompt.ts`, owned by Group 4 (Wave 2). Gate must be scoped to Group 2's files.
4. **[HIGH] Group 1 gate un-passable / smuggles a decision** — `package.json` `author` retains `*@syv.ai` emails; `! grep -riq syv package.json` either can't pass or silently strips authorship. Needs an explicit attribution decision.
5. **[HIGH] `DASH_*` env/protocol namespace unaddressed** — 14+ vars injected into every PTY and consumed by the hook contract; rename-vs-keep undecided, no gate. (Genie repo has zero `DASH_` refs — no cross-repo break.)
6. **[HIGH] `.github/workflows/build.yml` missing from the plan** — hardcodes `release/mac-arm64/Dash.app` (breaks at `productName: Khal`), `Dash-*` artifact names, and a second release path (`--publish never` + `gh release create`) that ignores the publish block Group 1 calls authoritative.
7. **[MEDIUM] `.dash-skill.json`/`.dash-tmp` are marker-filename constants** in `SkillsService.ts` with their own legacy-migration logic — folding them into one constant is wrong; fresh-start interaction undecided.
8. **[MEDIUM] `~/Dash` default clone dir** (`gitIpc.ts:30`, `LocationStep.tsx:172`) is a third data location renamed by the sweep with no veto point and no risk-table entry.
9. **[MEDIUM] Commit co-author trailer** `via Dash <dash@syv.ai>` (`SettingsModal.tsx:61`, `ptyHookSettings.ts:31`) + `syv.ai` links unowned by any group; replacement identity undecided.
10. **[LOW] Marketplace allow-list too narrow** — `SYV_MARKETPLACE_NAME`, `SYV_PLUGIN_ID`, `.claude/settings.json` `syv-skills@syv-skills` must be explicitly kept and excluded from Group 5's sweep.
11. **[LOW] Wave table vs `depends-on` disagree for Group 3.**
12. **[NIT] Group 6 validation is `|| true`** — should say plainly it is a manual QA gate.

Clean: appId change doesn't break signing (cert/team-based; entitlements carry no bundle id); no protocol handlers/deep links to rebrand; `${productName}` artifact templates auto-render; baseline numbers match.

**Orchestrator action:** status → FIX-FIRST. Felipe supplied the three missing decisions (KHAL_* rename; attribution `Automagik Genie <genie@namastex.ai>`; clone dir `~/genie`). Wish revised 2026-07-23 addressing all 12 findings: Group 2 rebuilt around AutoUpdateService; Group 3 widened to compound literals + skill-marker constants + env rename with hardened gates; Group 1 absorbed the CI workflow and author change; allow-lists widened; wave/deps aligned; Group 6 declared a manual QA gate. Re-review requested.

### Plan re-review — 2026-07-23 — VERDICT: FIX-FIRST (all 12 prior findings resolved; 7 new soundness issues)

Reviewer ran the wish's gates directly against the fork tree. Prior findings 1–12: all verified RESOLVED (`.dash` regex gate proven complete — 179/179 matched, zero false positives; author gate passable; allow-lists sufficient; `~/genie` clone-dir reasoning upgraded — plain git checkouts, no orphaning).

New findings, all plan-document repairs:
1. **[MEDIUM]** `\bDASH_` gate false-negative on `__DASH_ZDOTDIR` (ptyShellConfig.ts ×3) — underscore defeats `\b`. Fix: `(_*)DASH_[A-Z_]+`.
2. **[MEDIUM]** `DASH_DIR` is a per-file JS path const, not an env var — listing `KHAL_DIR` in the env set steers a second constant next to `PROJECT_DIR_NAME`, violating Decision 9. (Same conflation, lower stakes: `DASH_DEFAULT_ATTRIBUTION`, `DASH_URL_*_RE` are identifiers, not env.)
3. **[MEDIUM]** Trailer criteria contradiction: replacing only `via Dash <dash@syv.ai>` yields `Co-Authored-By: Claude <noreply@anthropic.com> via Automagik Genie <genie@namastex.ai>`, which does not contain the asserted substring `Co-Authored-By: Automagik Genie <...>` — a literal-matching QA agent fails a correct implementation, or an engineer "fixes" it by dropping the Claude line (unchosen behavior change). Pin the exact final string.
4. **[LOW]** build.yml `Dash-*` artifact names ungated ("dash" not "syv", outside src/) — add explicit workflow gates.
5. **[LOW]** Update-error suppression should key on lifecycle state (`checking`) not error content; renderer already near-silent (`onAutoUpdateError` resets spinner only) — real deliverable is the missing test + state boundary + killing the per-check `console.error`. _[Reviewer's "near-silent renderer" claim CORRECTED by ledger-verify 2026-07-23: `Toast.tsx:79-86` is a second subscriber showing a default-on visible error toast — today's failure IS user-visible. The state-based-boundary prescription stands and silences both subscribers; Group 2's deliverable text carries the corrected ground truth.]_
6. **[LOW]** "One defining constant per contract" has no scripted gate — completion note must enumerate defining modules.
7. **[NIT]** While private, electron-updater delivers NO updates at all (token-less) — record as accepted limitation.

**Orchestrator action:** all 7 repaired in place 2026-07-23 (gate regexes hardened incl. validation commands; `KHAL_DIR` removed from env set with fold-into-`PROJECT_DIR_NAME` instruction; exact trailer string pinned in Decision-6 surfaces, Success Criteria, and QA Criteria; build.yml `Dash`/`Khal-*` gates added to Group 1; Group 2 rewritten state-based; defining-module enumeration required in Group 3 acceptance; no-updates-while-private risk row added). No new Felipe decisions were needed — the trailer fix preserves existing structure with his chosen identity. Third review round requested.

### Plan re-review round 3 — 2026-07-23 — VERDICT: SHIP

All 7 second-round findings verified repaired; the three empirically risky repairs re-executed against the live fork:
- `(_*)DASH_[A-Z_]+` catches all 3 `__DASH_ZDOTDIR` occurrences; `[A-Z]DASH_` probe → empty (zero false positives in the tree); token parity 85/85. All 14 distinct `DASH_` tokens map to exactly one bucket — the must-be-zero gate is achievable exactly when all deliverables complete. _[Reviewer's bucketing ("9 env → KHAL_*, 3 identifier renames") CORRECTED by ledger-verify round 2, 2026-07-23: true partition is 5 injected env vars + `__DASH_ZDOTDIR` + 8 JS identifiers; "DASH_BASE" was a phantom — the digit-less regex fragment of `DASH_BASE64_DECODE_RE`, which is now explicitly named in deliverable 3's identifier bucket. The gate-achievability conclusion stands: the zero-gate fires on every token including the `DASH_BASE` prefix of `DASH_BASE64_DECODE_RE`.]_
- Trailer pin verified byte-for-byte: applying deliverable-3's replacement to both source files produces exactly the pinned string (Python equality → True).
- build.yml: exactly 4 `Dash` occurrences (lines 107/116/154/193), all owned by Group 1 deliverable 4; zero lowercase evaders; the `! grep -q 'Dash'` gate is passable precisely after Group 1's own renames.

Non-blocking operational note (recorded, no action): per-group server-side merges to fork `main` each trigger build.yml; intermediate merges without a version bump show a transient-red release job (duplicate-tag guard) and half-branded artifacts, resolving green once all groups land with a bump — the QA criterion checks the green end-state.

**Orchestrator action:** status → APPROVED (2026-07-23). Execution remains gated by wish-level depends-on (genie-ui-dash, live-dev-loop must reach SHIPPED); Group 6 additionally blocked-on-asset. Gating is DOCUMENTARY, per the wish-skill contract (the DAG lives in WISH.md, not task rows): the six seeded tasks are all `ready` in genie.db with no dependency rows, so the state machine will not stop an early claim — `work` and any dispatching orchestrator MUST consult this document's depends-on before checkout.

### Ledger verification — 2026-07-23 — pm-ledger-verify (3 lenses, pre-commit)

1 must-fix + 3 accuracy findings, all repaired in place before commit:
- **[MEDIUM, must-fix] False "near-silent renderer" ground truth** — `Toast.tsx:79-86` is a second `onAutoUpdateError` subscriber with a default-enabled visible error toast; today's private-feed failure IS user-visible. Corrected in Group 2 deliverable 1 and annotated on re-review finding 5. Design unchanged (main-process suppression silences both subscribers — the correction strengthens Group 2's justification).
- **[MEDIUM] Documentary-vs-enforced gating** — made explicit above.
- **[LOW ×2] "14+ env vars" → corrected** in Scope IN and Decision 7; INDEX.md wording softened to match actual verification depth per round.

**Round 2 (post-repair re-verify):** 2 further must-fixes — round 1's "corrected census" (9 env / 4 identifiers) was ITSELF wrong. Verified partition of the 14 tokens: **5 injected PTY env vars** (`DASH_HOOK_PORT` ptyManager.ts:336; `DASH_TASK_ID`/`DASH_BRANCH`/`DASH_WORKTREE_PATH`/`DASH_PROJECT_PATH` WorkspaceConfigService.ts:183-187) + **`__DASH_ZDOTDIR`** + **8 JS identifiers** (`DASH_DIR`, `DASH_HOOK_EVENTS`, `DASH_HOOK_ENDPOINTS`, `DASH_ENDPOINT_SET`, `DASH_DEFAULT_ATTRIBUTION`, `DASH_URL_FULL_RE`, `DASH_URL_SUBSTR_RE`, `DASH_BASE64_DECODE_RE`); "DASH_BASE" exposed as a phantom regex fragment of `DASH_BASE64_DECODE_RE`. Group 3 deliverable 3 rewritten with the cited partition; deliverable 4's env-set test now specified against the real 5-key set; round-3 evidence bullet annotated. One INDEX summary-count drift (reported by all three lenses) also fixed.

**Round 3 (post-repair re-verify):** 3 mustFix-flagged entries, all record accuracy: (a) "12 lens reports" was inflated 2× — each round runs exactly 3 lens agents (verified against the session's own workflow logs); this ledger now records per-round machine-reported figures only and maintains NO prose aggregate, because aggregates rot on every edit; (b) `DASH_DEFAULT_ATTRIBUTION` was falsely located in hookSettingsMerge.ts — true definitions are SettingsModal.tsx:60-61 + ptyHookSettings.ts:30-31 (deliverable 3 corrected); (c) LOW: `.dash/config.json` is ×27 not ×26 in the round-1 historical quote (annotated in place). Per-round record (runId · finding entries · mustFix-flagged): wf_bcec8f80 · 7 · 1; wf_802be98f · 5 · 2; wf_7ba79a1d · 6 · 3; wf_f16ace13 · 2 · **0** (gate passed — both remaining entries were LOW wording overreach in INDEX.md's "iterated to clean" phrase, corrected in this same commit). All flagged items repaired before commit; no aggregate claimed.

---

## Files to Create/Modify

```
# fork (khal-os/genie-desktop)
package.json                                   # name, description, author, appId, productName, publish
Makefile                                       # drop publish overrides + syv comment
.github/workflows/build.yml                    # Khal.app path, Khal-* artifacts, release-job consistency
src/main/entry.ts                              # app.setName('Khal')
src/main/services/AutoUpdateService.ts         # silent degrade while private + new test file
src/main/ipc/appIpc.ts                         # dev-only update-check URL + UA
src/renderer/utils/releaseNotes.ts             # RELEASE_TAG_BASE
src/renderer/utils/__tests__/releaseNotes.test.ts
src/renderer/components/ui/Toast.tsx           # latest-release link
src/main/services/PortsSetupPrompt.ts          # canonical Khal paragraph
src/main/services/SkillsService.ts             # .khal-skill markers, legacy migration removed
src/main/services/ptyHookSettings.ts           # trailer identity + KHAL_* vars
src/renderer/components/settings/SettingsModal.tsx  # trailer + links
src/main/ipc/gitIpc.ts                         # ~/genie clone default
src/renderer/components/newProject/LocationStep.tsx # placeholder
src/<shared>/projectDirName.ts (new)           # PROJECT_DIR_NAME = '.khal'
src/** (39 files)                              # .dash compound-literal sweep
src/** (~71 files)                             # Dash string sweep incl. tests
README.md, GENIE.md, ITERATE.md, LICENSE
build/icon.icns, build/icon.svg, build/win/*   # blocked-on-asset

# genie repo
.genie/wishes/khal-rebrand/WISH.md             # this document
```
