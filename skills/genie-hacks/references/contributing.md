# Contributing a Hack — PR Mechanics

Used by `genie-hacks contribute` step 3. Target: repository `automagik-dev/docs`, file `genie/hacks.mdx`, base branch `dev` (never `main`/`master`). The user's existing contribution authorization, or the confirmed preview, authorizes the external submission; do not ask twice.

## Entry template

```markdown
### <Title>

**ID:** `<generated-id>`
**Category:** <category>

**Problem:** <problem>

**Solution:**

<solution with code blocks>

**Benefit:** <benefit>

**When to use:** <when>
```

The ID is lowercase kebab-case generated from the title and must not collide with an existing ID in `genie/hacks.mdx`; check before appending.

## Submit

1. **Preflight:** `gh` on PATH and `gh auth status` succeeds; otherwise use the local fallback below.
2. **Fork:** `gh repo fork automagik-dev/docs --clone=false`. Read the result: an existing fork is fine, any other failure stops here with its message.
3. **Isolated checkout, owned by this run:** clone the fork's `dev` branch into a fresh directory (`mktemp -d`), create `hack/<slug>` from it, and work only there. Never reuse or clean a directory this run did not create, and never check out branches in a directory that may hold user files.
4. **Append:** in `genie/hacks.mdx`, add the entry at the end of its `## <Category>` section (before the next `## ` heading); create the section at the end of the file if it is missing.
5. **Commit and push:** `git add genie/hacks.mdx`, commit `hack: <title>`, push the branch to the fork.
6. **PR:** `gh pr create --repo automagik-dev/docs --base dev --head <gh-user>:hack/<slug> --title "hack: <title>" --body-file <file>`, with the body written to a file first (title, category, problem, solution summary, benefit, when to use, and "Submitted via `genie-hacks contribute`"). Never interpolate user text into a shell command.
7. **Report:** the PR URL first, then what happens next: maintainer review, possible edits through PR comments, publication once merged. Remove the temporary directory only after the PR exists.

## Failures

Report the exact failing step and its message. Push or PR failures: show the branch and commit so the user can finish from the fork in the GitHub UI. Authentication failures: suggest `gh auth login` or `gh auth refresh`. Do not delete anything to recover.

## Local fallback

If GitHub operations are unavailable, never lose the write-up: save the formatted entry to `~/.genie/cache/pending-hacks/<hack-id>.md` and relay the manual steps: fork `automagik-dev/docs`, add the entry under its category in `genie/hacks.mdx`, commit `hack: <title>`, open a PR against `dev`.
