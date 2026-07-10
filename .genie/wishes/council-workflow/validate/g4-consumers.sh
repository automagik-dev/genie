#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# --- /review: lens-panel dispatch must exist structurally, not just as a path mention
grep -qiE 'lens[ -]panel' skills/review/SKILL.md || { echo "FAIL: review skill lacks a lens-panel section"; exit 1; }
grep -qiE 'change[ -]type' skills/review/SKILL.md || { echo "FAIL: review skill lacks change-type -> lens mapping"; exit 1; }
grep -q 'references/lenses' skills/review/SKILL.md || { echo "FAIL: review skill lacks lens-library reference"; exit 1; }

# --- /brainstorm: domain-experts lens-subagent step must exist structurally
grep -qiE 'domain[ -]experts?' skills/brainstorm/SKILL.md || { echo "FAIL: brainstorm skill lacks a domain-experts step"; exit 1; }
grep -q 'references/lenses' skills/brainstorm/SKILL.md || { echo "FAIL: brainstorm skill lacks lens-library reference"; exit 1; }

# --- lens-root anchor (agent-sync): both skills must name GENIE_HOME so synced
# copies resolve the lens root in any repo, not just the genie checkout
grep -q 'GENIE_HOME' skills/review/SKILL.md || { echo "FAIL: review skill lacks the lens-root GENIE_HOME anchor"; exit 1; }
grep -q 'GENIE_HOME' skills/brainstorm/SKILL.md || { echo "FAIL: brainstorm skill lacks the lens-root GENIE_HOME anchor"; exit 1; }

for f in skills/review/SKILL.md skills/brainstorm/SKILL.md; do
  # every cited lens-card path resolves
  while IFS= read -r p; do
    test -e "plugins/genie/$p" || { echo "FAIL: dangling lens ref '$p' in $f"; exit 1; }
  done < <(grep -oE 'references/lenses/[a-z-]+\.md' "$f" | sort -u)

  # every cited lane-skill lens path resolves
  while IFS= read -r p; do
    test -e "$p" || { echo "FAIL: dangling lane-skill ref '$p' in $f"; exit 1; }
  done < <(grep -oE 'skills/(repo-hygiene|architecture|code-quality|qa|perf|supply-chain|dx-docs)/SKILL\.md' "$f" | sort -u)

  # no inline lens definitions (lens cards carry voice:/modes: frontmatter — skills must reference, not embed)
  if grep -qE '^(voice|modes): ' "$f"; then
    echo "FAIL: inline lens definition (voice:/modes: block) embedded in $f — reference the library instead"
    exit 1
  fi
done

echo "G4 PASS"
