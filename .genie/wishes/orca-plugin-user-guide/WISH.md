# Wish: The Orca plugin README tells an operator what the plugin does and how to use it

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `orca-plugin-user-guide` |
| **Date** | 2026-09-25 |
| **Author** | Felipe Rosa |
| **Appetite** | small |
| **Branch** | `wish/orca-plugin-user-guide` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

`plugins/genie/README.md` explains how the plugin is built and shipped, but not how to use it. The operator who installed it in Orca could not tell what it does. This wish adds one operator-facing "Using the plugin" section: the eight commands and their chords, what each does, the permissions consent asks for, what `orchestration.mode` changes, and a five-minute first check. It is also the first wish delivered end to end in Orca mode, so it doubles as the live dogfood of the plugin's agent side.

## Scope

### IN

- One new `## Using the plugin` section in `plugins/genie/README.md`, placed before `## What ships here`.
- A table of the eight commands: title, `Ctrl+Alt+Shift` chord, and what happens. Titles and chords are copied verbatim from `plugins/genie/orca-plugin.json`.
- The four capabilities as plain-language permissions, with what each is used for.
- What changes when `genie setup --orchestration-mode orca` is selected: agents use Orca Runs, tasks, gates and the card; `task`, `board` and `idea` are refused; how to switch back.
- A first check an operator can run in under five minutes: Doctor, Update, and one lifecycle command, with the toast or terminal text each one should produce.

### OUT

- Any change to `orca-plugin.json`, `orca-entrypoint.ts`, `orca-entrypoint.min.js`, `orca-runtime.ts`, or any other plugin or source file.
- Screenshots or images. The plugin tree must stay small and symlink-free (`scripts/orca-manifest-parity.test.ts`).
- Changes to the public docs site under `docs/`.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | The guide lives in `plugins/genie/README.md` | It ships inside the plugin tree Orca installs, so it travels with the exact version the operator runs |
| 2 | Titles and chords are copied from the manifest, and the validation checks them | A guide that drifts from the manifest is worse than none |

## Simplicity Case

- **Simplest complete design:** one README section. No code, no new files.
- **Added machinery:** none.
- **Deferred until measured:** a public docs page on automagik.dev, once operators other than the maintainer install the plugin.
- **Complexity removed:** screenshots, which would go stale and grow the plugin tree.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] `plugins/genie/README.md` has a `## Using the plugin` section before `## What ships here`.
- [ ] Every command title and chord in `plugins/genie/orca-plugin.json` appears verbatim in that section.
- [ ] The section names the four capabilities and says what `orchestration.mode` changes, including how to switch back.
- [ ] `bun test scripts/orca-manifest-parity.test.ts` passes, and the diff touches only `plugins/genie/README.md` and this WISH.md.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | Low risk: one documentation section in one file; its facts are pinned to the manifest by the validation | inherit | Write the "Using the plugin" section |

**Global constraints:**
- Base is `origin/dev`; conventional commits; commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Edit only `plugins/genie/README.md`. Never touch the manifest, the entrypoint, its minified bundle, or any source file.
- Never bypass a hook (`--no-verify`, `HUSKY=0`), never force-push, never merge.
- Public text names no private repository, other project or person.

## Execution Groups

### Group 1: Write the "Using the plugin" section

**Goal:** An operator who opens `plugins/genie/README.md` learns what each command does, what the plugin is allowed to do, and how to check it works.

**Deliverables:**
1. A `## Using the plugin` section in `plugins/genie/README.md`, directly before `## What ships here`, containing:
   - a table of the eight commands with title, chord, and effect:
     - Doctor runs `genie doctor --json` in the workspace and shows a toast.
     - Update compares the installed `genie --version` with the release manifest for the host's update channel and shows a toast; it installs nothing.
     - The six lifecycle commands (Wish, Work, Review, Fix, Report, Council) type the matching slash command into the workspace's agent terminal and confirm with a toast. With no agent terminal they start a supervised Orca worker. When the local CLI cannot reach the workspace (a desktop paired to a remote runtime), the send path falls back to the host's first terminal and the start path refuses with a toast.
   - the four capabilities (`workspace:read`, `terminal:send`, `notifications:show`, `events:subscribe`), each in one plain sentence;
   - a short "Orca mode" paragraph: `genie setup --orchestration-mode orca` makes agents use Orca Runs, tasks, gates and the workspace card (`genie orca mirror`); `task`, `board` and `idea` are refused with exit 2; `genie setup --orchestration-mode standalone` switches back and imports nothing;
   - a "First check" list with the exact toast each step produces (`orca-entrypoint.ts:794,891,731`): Doctor shows `Genie doctor: all checks pass` or `Genie doctor: <n> warn, <n> fail — <checks>`; Update shows `Genie is up to date (<version>, <channel> channel)` or `Genie update available: …`; a lifecycle command shows `Genie: sent /<verb> to <workspace>`.

**Interfaces:**
- Consumes: `plugins/genie/orca-plugin.json` (`contributes.commands`, `contributes.keybindings`, `capabilities`) as the source of titles, chords and capability names.
- Produces: none.

**Acceptance Criteria:**
- [ ] The section exists before `## What ships here`.
- [ ] Every command's `title` appears verbatim in the section on the same line as its own `key`, so a swapped chord fails.
- [ ] The four capability kinds appear verbatim.
- [ ] Besides this WISH.md, only `plugins/genie/README.md` changes.

**Validation:**
```bash
set -e
bun test scripts/orca-manifest-parity.test.ts
test -z "$(git diff --name-only origin/dev...HEAD | grep -vxE 'plugins/genie/README.md|\.genie/wishes/orca-plugin-user-guide/WISH.md')"
python3 - <<'PY'
import json, re, sys
m = json.load(open('plugins/genie/orca-plugin.json'))
r = open('plugins/genie/README.md').read()
start = re.search(r'^## Using the plugin$', r, re.M).start(); end = r.index('\n## What ships here')
assert start < end, 'section must come before What ships here'
s = r[start:end]; lines = s.splitlines()
keys = {k['command']: k['key'] for k in m['contributes']['keybindings']}
missing = [c['title'] + ' + ' + keys[c['id']] for c in m['contributes']['commands']
           if not any(c['title'] in l and keys[c['id']] in l for l in lines)]
missing += [c['kind'] for c in m['capabilities'] if c['kind'] not in s]
sys.exit('missing or unpaired in the guide: ' + ', '.join(missing) if missing else 0)
PY
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] After the next release, the installed plugin tree (`~/.genie/plugins/genie/README.md`) carries the section.
- [ ] Pressing Doctor and Update in Orca produces toasts matching the guide's wording.
- [ ] The plugin still loads in Orca (the README is the only change to the tree).

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| The guide drifts from the manifest in a later release | Low | The validation reads titles, chords and capabilities from the manifest; a follow-up can move that check into `scripts/orca-manifest-parity.test.ts` |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

---

## Files to Create/Modify

```
plugins/genie/README.md
.genie/wishes/orca-plugin-user-guide/WISH.md
```
