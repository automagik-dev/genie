---
name: skill-audit
description: "Audit the shipped skill catalogue for overlap, staleness, and drift against the install record, and propose keep, improve, merge, or retire per skill."
category: skill-ops
mutates: documents
---

# Skill Audit

The catalogue is a product surface: every extra entrypoint spends a reader's attention whether or not it fires. Audit it on evidence the repository and the host already hold, and propose verdicts. Deleting or merging a skill is the caller's decision, taken after the proposal, never inside the audit.

## Before authoring

A new skill is the last option, not the first. Search before you write:

1. **Name the intent.** The task the skill performs, the trigger conditions, and three to five keywords with their synonyms.
2. **Search the shipped catalogue first.** Grep the skill directories for the keywords in both the frontmatter description and the body. A hit in an existing description usually means the workflow already has a home.
3. **Search the host's installed homes.** The install record written at the end of a successful update lists the inventory and every agent skills home it wrote, and the skills lines of `genie doctor` report what is present per home. A name already installed from elsewhere is user-owned and is not yours to overwrite.
4. **Vet anything external** before adopting it: read its instructions end to end, look for shell commands, file writes, network calls, and credential handling, and prefer copying into a branch you can diff over editing an installed original.
5. **Decide out loud.** Use the existing skill, extend it, or create a fresh one because the search found no close match. Say which, and why.

The consolidation table in the catalogue README is the precedent: audit lenses collapsed into one review entrypoint, investigation collapsed into one report entrypoint. Prefer the same move.

## Signals

Gather these before judging anything:

- The repository's skill lint, `scripts/skills-lint.ts`, covering frontmatter, directory shape, resource paths, real command names, and the retired-vocabulary ban.
- The inventory parity check, `scripts/skills-inventory-parity.ts`, comparing what the packaging publishes against the directories on disk.
- The install record and the doctor skills lines above, which show what actually reached the host and whether the recorded homes are complete.
- Line counts per skill against the forty-to-ninety house range, and the description of each skill read as a pointer: does it name a distinct workflow, or restate a neighbour's?

## Verdicts

Judge each skill holistically against actionability, scope fit, uniqueness, and currency. Return one verdict per skill:

| Verdict | Meaning |
|---------|---------|
| Keep | Distinct, current, and carrying its own workflow |
| Improve | Worth keeping once a named, specific change lands |
| Update | The behaviour it describes has moved; the text has not |
| Merge into X | Substantial overlap; X is the surviving entrypoint |
| Retire | No unique content remains, or the cost outweighs the use |

Every verdict carries a self-contained reason a reader can act on without re-reading the skill. Name the defect, the line range, and what covers the same need instead. "Superseded" and "too long" are not reasons. For a merge, name the target and the content to carry across; for an improvement, name the section and the target size.

## Deliver

Write the audit where the repository keeps its notes, under the brainstorm or wish tree for the work that prompted it, and present the table in your reply. Retire loudly: a removed skill gets a row in the consolidated-names table naming its current route, so a caller who types the old name learns where the workflow went. Confirm every retirement and merge with the caller before any file moves.

<!-- adapted from https://github.com/affaan-m/ECC skills skill-stocktake and skill-scout (MIT, commit e73abf7f9770f5448699273f20fe3862de8d60b4 via gongyijie85/dsh-ecc) -->
