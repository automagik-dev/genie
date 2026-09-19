#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

for lane in repo-hygiene architecture code-quality qa perf supply-chain dx-docs; do
  f="skills/$lane/SKILL.md"
  test -f "$f" || { echo "FAIL: missing $f"; exit 1; }
  grep -Eq "^name: ${lane}$" "$f" || { echo "FAIL: frontmatter name != ${lane} in $f"; exit 1; }
  grep -qi 'inspired by' "$f" || { echo "FAIL: no inspiration attribution in $f"; exit 1; }
done

for expert in chacon ousterhout hejlsberg beck gregg lorenc procida; do
  if grep -rEiq "^name:.*${expert}" skills/; then
    echo "FAIL: real person's name '${expert}' used as a skill identity (name: field) under skills/"
    exit 1
  fi
done

echo "G1 PASS"
