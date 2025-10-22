#!/bin/bash
# Prevent direct Forge worktree filesystem access
# Installed as pre-commit hook
# Part of Discovery #120-A.1: Filesystem Restrictions Audit

set -e

echo "🔍 Checking for forbidden Forge worktree access..."

# Forbidden patterns
PATTERNS=(
  # Hardcoded worktree paths
  "/var/tmp/automagik-forge/worktrees/"

  # Filesystem operations on worktree-related paths
  "fs\.readFileSync.*worktree"
  "fs\.writeFileSync.*worktree"
  "fs\.existsSync.*worktree"
  "fs\.mkdirSync.*worktree"
  "fs\.rmdirSync.*worktree"
  "fs\.unlinkSync.*worktree"

  # Session file operations (executor-specific)
  "locateSessionFile\("
  "tryLocateSessionFileBySessionId\("
)

# Exception patterns (allowed uses)
EXCEPTIONS=(
  # forge-executor.ts display-only path (no filesystem access)
  "\.genie/cli/src/lib/forge-executor\.ts.*getWorktreePath"
  # Interface definitions (not actual usage)
  "\.genie/cli/src/executors/types\.ts"
)

VIOLATIONS=0
VIOLATION_FILES=()

# Get staged files in .genie/cli/src/
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep "^\.genie/cli/src/" || true)

if [ -z "$STAGED_FILES" ]; then
  echo "✅ No .genie/cli/src/ files staged for commit"
  exit 0
fi

# Check each pattern
for pattern in "${PATTERNS[@]}"; do
  for file in $STAGED_FILES; do
    # Get the staged content
    STAGED_CONTENT=$(git diff --cached "$file")

    # Check if pattern matches
    if echo "$STAGED_CONTENT" | grep -qE "$pattern"; then
      # Check if this is an exception
      IS_EXCEPTION=false
      for exception in "${EXCEPTIONS[@]}"; do
        if echo "$file" | grep -qE "$exception"; then
          IS_EXCEPTION=true
          break
        fi
      done

      if [ "$IS_EXCEPTION" = false ]; then
        if [ $VIOLATIONS -eq 0 ]; then
          echo ""
          echo "❌ BLOCKED: Direct worktree access detected"
          echo ""
        fi

        echo "📍 File: $file"
        echo "   Pattern: $pattern"
        echo "   Context:"
        echo "$STAGED_CONTENT" | grep -E "$pattern" -A 2 -B 2 | sed 's/^/   /'
        echo ""

        VIOLATIONS=$((VIOLATIONS + 1))
        VIOLATION_FILES+=("$file")
      fi
    fi
  done
done

if [ $VIOLATIONS -gt 0 ]; then
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "🚫 Commit blocked: $VIOLATIONS violation(s) found"
  echo ""
  echo "🔧 Use Forge API instead:"
  echo "   ✅ forgeClient.getTaskAttempt(sessionId)"
  echo "   ✅ forgeClient.getTaskAttemptLogs(sessionId)"
  echo "   ✅ forgeClient.followUpTaskAttempt(sessionId, prompt)"
  echo ""
  echo "📚 See: .genie/discovery/filesystem-restrictions-audit.md"
  echo ""
  echo "⚠️  Emergency bypass: git commit --no-verify"
  echo "   (Document why in commit message!)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 1
fi

echo "✅ No worktree access violations detected"
exit 0
