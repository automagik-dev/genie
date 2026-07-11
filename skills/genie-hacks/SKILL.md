---
name: genie-hacks
description: "Browse, search, and contribute community hacks — real-world patterns for provider switching, teams, skills, hooks, cost optimization, and more."
---

# genie-hacks — Community Hacks & Patterns

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (CLI-managed fallback or separately installed personal skill). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

Browse real-world Genie patterns contributed by the community. Search by problem, explore by category, or contribute your own.

## When to Use
- User wants to discover Genie tips, tricks, or advanced patterns
- User asks a problem-oriented question — "how do I optimize costs?", "how do teams work?"
- User wants to contribute a hack they discovered
- User invokes `genie-hacks` with any subcommand (no subcommand → `list`)

## Data Sources
- **Registry:** Read `references/catalog.md` (relative to this skill's directory) before answering any list/search/show/help request — it holds every hack (problem, solution, code, benefit, when-to-use) plus the category table. Never invent a hack that isn't in it.
- **Contribute mechanics:** Read `references/contributing.md` when running `contribute` — exact fork/branch/PR commands and error recovery.
- Published page: https://docs.automagik.dev/genie/hacks (source `genie/hacks.mdx` in automagik-dev/docs).

## Commands

| Command | Behavior |
|---------|----------|
| `genie-hacks` / `list` | Table of all hacks — ID, title, category — then the count and a `contribute` nudge. |
| `search <keyword>` | Case-insensitive match over title/problem/solution/code; show ID, title, category, problem snippet per match. None → suggest broader terms or `list`. |
| `show <hack-id>` | Full entry: problem, solution, code, benefit, when to use. Unknown ID → suggest the closest IDs. |
| `help <problem>` | Match the described problem to the top 3 relevant hacks; one-line "why" plus a quick tip each. Prefer a loose match over "no matches". |
| `contribute` | Guided submission → automated PR to automagik-dev/docs. |

End `list` and `show` with a pointer to `show <id>` and `contribute`.

## Contribute Flow
1. **Gather** — title, problem, solution (with code), category (one from the catalog's category table), benefit, when-to-use. One question at a time; friendly and low-friction.
2. **Preview** — render the hack in the catalog template; confirm: yes → submit, edit → re-prompt that field and re-preview, cancel → abort politely.
3. **Submit** — after the confirmed preview explicitly authorizes external submission, follow `references/contributing.md`: preflight GitHub access, fork/clone or use the GitHub connector, branch `hack/<slug>`, append under the category heading in `genie/hacks.mdx`, commit `hack: <title>`, and open the PR against `dev`.
4. **Report** — lead with the PR URL and what happens next (maintainer review, then it lands on the published page).

If `gh` is missing/unauthenticated or any GitHub step fails, save the formatted hack to `~/.genie/cache/pending-hacks/<hack-id>.md` and relay the manual PR steps — never lose the user's write-up.

## Rules
- Hack IDs are lowercase kebab-case and unique — check existing IDs before appending.
- Hacks must be realistic and tested — no aspirational or untested patterns.
- Catalog code must use the live v5 CLI (`genie --help` is the source of truth); v4-era entries carry a note with the live replacement.
- PRs always target `dev` — never `main`/`master`.
- Keep output concise — tables for `list`, full format only for `show`.
- Community discussion: https://discord.gg/automagik
