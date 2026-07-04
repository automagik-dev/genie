# Contributing a Hack — PR Mechanics

Exact commands for `/genie-hacks contribute` Step 3 (submit). Target repo: `automagik-dev/docs`, file `genie/hacks.mdx`, base branch `dev` — never `main`/`master`.

## Hack Template

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

IDs are lowercase kebab-case, generated from the title, and must not collide with existing IDs in `genie/hacks.mdx`.

## Preflight

Run in order; stop at the first failure with its message.

```bash
command -v gh >/dev/null 2>&1   # missing → "GitHub CLI (gh) is required. Install: https://cli.github.com/"
gh auth status                  # not authed → "Run `gh auth login` first."
command -v git >/dev/null 2>&1  # missing → "git is required but not found in PATH."
```

On failure, offer the manual path (see Offline / Manual Fallback below).

## Fork, Clone, Branch

The docs repo is cached at `~/.genie/cache/docs-fork/` so contribute doesn't re-clone every time; each run updates it with `git pull`. If the cache is corrupted, delete it and re-run — it re-clones automatically.

```bash
DOCS_CACHE="$HOME/.genie/cache/docs-fork"

# Fork (idempotent — no-op if already forked)
gh repo fork automagik-dev/docs --clone=false 2>/dev/null || true
GH_USER=$(gh api user --jq '.login')

# Clone or update the cached fork
if [ -d "$DOCS_CACHE/.git" ]; then
  cd "$DOCS_CACHE"
  git fetch origin && git checkout dev && git pull origin dev
else
  gh repo clone "$GH_USER/docs" "$DOCS_CACHE" -- --branch dev
  cd "$DOCS_CACHE"
  git remote add upstream https://github.com/automagik-dev/docs.git 2>/dev/null || true
  git fetch upstream
fi

# Branch named from the title
BRANCH="hack/$(echo '<title>' | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')"
git checkout -b "$BRANCH" origin/dev
```

## Append to hacks.mdx

Read `genie/hacks.mdx` in the clone. Find the category heading (`## Providers`, `## Teams`, ...) and append the new entry just before the next `## ` heading (or at the end of that section). If the category section doesn't exist (e.g. `other`), add a new `## <Category>` section at the end of the file, before the Contributing section. If `hacks.mdx` is missing entirely, create it with the standard template header.

## Commit, Push, PR

```bash
cd "$DOCS_CACHE"
git add genie/hacks.mdx
git commit -m "hack: <title>"
git push -u origin "$BRANCH"

PR_URL=$(gh pr create \
  --repo automagik-dev/docs \
  --base dev \
  --head "$GH_USER:$BRANCH" \
  --title "hack: <title>" \
  --body "$(cat <<'PREOF'
## New Community Hack

**Title:** <title>
**Category:** <category>
**Problem:** <problem>

**Solution:**
<solution summary>

**Benefit:** <benefit>
**When to use:** <when>

---

*Submitted via `/genie-hacks contribute`*
PREOF
)")

echo "PR created: $PR_URL"
```

Report the PR URL first, then what happens next: a maintainer reviews, may suggest edits via PR comments, and the hack appears on the published page once merged. Community discussion: https://discord.gg/automagik

## Error Recovery

| Error | Recovery |
|-------|----------|
| `gh` not installed | Show install URL, fall back to manual steps |
| `gh` not authenticated | Show `gh auth login` |
| Fork fails | Check if fork already exists: `gh repo view $GH_USER/docs` |
| Clone fails | `rm -rf "$DOCS_CACHE"` and retry the clone |
| `hacks.mdx` not found | Create it with the standard template header |
| Push fails (auth) | Suggest `gh auth refresh` or SSH key setup |
| PR creation fails | Show branch + commit info so the user can open the PR via the GitHub web UI |

## Offline / Manual Fallback

If GitHub operations fail entirely, never lose the write-up — save it locally and hand over the manual steps:

```bash
mkdir -p ~/.genie/cache/pending-hacks
cat > ~/.genie/cache/pending-hacks/<hack-id>.md << 'EOF'
<formatted hack content>
EOF
```

Manual steps to relay:
1. Fork https://github.com/automagik-dev/docs
2. Copy the hack into `genie/hacks.mdx` under the `<category>` section
3. Commit with message `hack: <title>`
4. Open a PR targeting the `dev` branch
