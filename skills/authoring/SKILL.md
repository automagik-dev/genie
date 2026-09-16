---
name: authoring
description: "Write or revise a Genie skill so it survives the shipped contract — frontmatter, house size, starter card, and runtime-neutral voice."
category: authoring
mutates: none
---

# Authoring

A skill is a document an agent executes, not prose a human skims. Reference only; the edit belongs to whoever called you. Before writing a new one, run the skill-audit search pass: consolidation is the house default and a near-duplicate is a revision, not a new directory.

## The contract

A shipped skill is one top-level directory holding `SKILL.md` at its root, `agents/openai.yaml`, and optional `references/*.md`. Nesting hides it from the installer; an empty directory fails the gate.

Frontmatter carries exactly four keys, in order, and nothing else:

```yaml
---
name: <directory name, lowercase kebab>
description: "<one quoted sentence naming the workflow and its deliverable>"
category: <the enum this skill belongs to>
mutates: <none | documents | repo | external>
---
```

`name` must equal the directory name character for character. `description` is the pointer the runtime reads to decide whether to load you, so it front-loads the verb and names the outcome; it is the only always-loaded line you own, and every word costs on every turn.

`mutates` is a promise the body has to keep. `none` means read-only. `documents` means it writes under the repository's own notes and wish tree. `repo` means source edits. `external` means it reaches a network or another host.

## House size

Forty to ninety lines. Under forty and the skill is a paragraph wearing a directory; over ninety and attention thins across the excess. When a skill outgrows the ceiling, push the on-demand half into `references/` under the skill's own directory and point at it by a skill-relative path. Inline what every branch needs; disclose what only some branches reach.

## Voice

- Write runtime-neutral. Name the runtime's native delegation surface, never one vendor's tool name or one host's directory layout.
- Reference other skills by name in prose, as "the review skill", never as a path into another skill's directory. Cross-directory paths break the moment the installer lands the tree somewhere else.
- Resolve every shipped file relative to the loaded `SKILL.md`. A repository root or a host environment variable is not available to an installed skill.
- Prompt the positive. A prohibition drags the forbidden behaviour into context; state the target behaviour instead, and keep a ban only where no positive phrasing exists.
- Every step ends on a checkable completion criterion. "Understanding reached" invites an early exit; "the gate exits zero" does not.
- Keep each meaning in one place. The environment is a source of truth too, so a line that restates a command's help output is a cache that will go stale.

## The starter card

`agents/openai.yaml` is the interface metadata the Codex UI renders:

```yaml
interface:
  display_name: "Two or three words"
  short_description: "Twenty-five to sixty-four characters"
  default_prompt: "One imperative sentence, with no selector token in it."
```

The starter card ships in several physical tiers, so a selector inside it could redirect execution to a different copy of the same skill. Keep the prompt plain imperative English.

## Before you finish

Run the repository's skill lint and read every finding against your file. It enforces the frontmatter contract, the directory shape, skill-relative resources, real command names inside fenced examples, and a vocabulary ban on retired role and host-root tokens. That ban has no allowlist and cannot be suppressed, and each failure names the replacement you must adopt, so treat its output as the edit list. Then confirm the line count sits inside the house range and that the description still reads true after the body changed.

<!-- adapted from https://github.com/mattpocock/skills/tree/main/skills/writing-for-agents (MIT, commit cddededbbb2ed38f0e0b26b46be8455c59d78ab1 via gongyijie85/mattpocock-skills-dsh) -->
