---
name: genie-hacks
description: "Browse, search, and contribute community hacks — real-world patterns for provider switching, teams, skills, hooks, cost optimization, and more."
category: integration
mutates: external
---

# Genie Hacks

Browse real-world Genie patterns contributed by the community: search by problem, explore by category, or contribute your own. No subcommand means `list`.

## Data

- **Registry:** read `references/catalog.md` (relative to this skill directory) before answering any list, search, show or help request. It holds every hack (problem, solution, code, benefit, when to use) and the category table. Never invent a hack that is not in it.
- **Contribute mechanics:** read `references/contributing.md` when running `contribute`; it has the exact fork, branch and PR commands and the offline fallback.
- Published page: https://docs.automagik.dev/genie/hacks (source `genie/hacks.mdx` in automagik-dev/docs).

## Commands

| Command | Behavior |
|---|---|
| `list` | Table of all hacks (ID, title, category), then the count and a `contribute` nudge. |
| `search <keyword>` | Case-insensitive match over title, problem, solution and code; per match show ID, title, category and a problem snippet. No matches: suggest broader terms or `list`. |
| `show <hack-id>` | Full entry. Unknown ID: suggest the closest IDs. |
| `help <problem>` | The top three relevant hacks with a one-line why and a quick tip each; prefer a loose match to "no matches". |
| `contribute` | Guided submission that opens a PR to automagik-dev/docs. |

Keep output concise: tables for `list`, the full format only for `show`.

## Contribute

1. **Gather** title, problem, solution with code, category (one from the catalog's table), benefit and when-to-use, one question at a time.
2. **Preview** the hack in the catalog template and confirm: yes submits, edit re-prompts that field, cancel aborts.
3. **Submit** only after the confirmed preview, following `references/contributing.md`: preflight GitHub access, fork or use the GitHub connector, branch `hack/<slug>`, append under the category heading in `genie/hacks.mdx`, commit `hack: <title>`, open the PR against `dev`, never `main`.
4. **Report** the PR URL and what happens next.

If `gh` is missing or unauthenticated, or any GitHub step fails, save the formatted hack to `~/.genie/cache/pending-hacks/<hack-id>.md` and relay the manual steps; never lose the write-up.

## Rules

- Hack IDs are lowercase kebab-case and unique; check existing IDs first.
- Hacks are realistic and tested, never aspirational.
- Catalog code uses the live v5 CLI (`genie --help` is the source of truth); v4-era entries carry a note with the live replacement.
- Community discussion: https://discord.gg/automagik
