#!/usr/bin/env bash
# CLI Modularization Cleanup Script
# Removes build artifacts and temporary validation files from git
# Run from repository root: bash .genie/wishes/cli-modularization/investigation/cleanup-script.sh

set -euo pipefail

echo "=== CLI Modularization Cleanup ==="
echo ""

# Step 1: Remove dist/ from git (it's force-included in .gitignore)
echo "Step 1: Removing .genie/cli/dist/ from git tracking..."
git rm -r --cached .genie/cli/dist/ || echo "  (already removed)"

# Step 2: Fix .gitignore to stop force-including dist/
echo "Step 2: Updating .gitignore to properly ignore dist/..."
# Remove the exception rules (lines 22-23)
sed -i '/^!\.genie\/cli\/dist\//d' .gitignore
echo "  Removed: !.genie/cli/dist/"
echo "  Removed: !.genie/cli/dist/**"

# Step 3: Remove .cache/ from git
echo "Step 3: Removing .cache/ from git tracking..."
git rm -r --cached .cache/ 2>/dev/null || echo "  (already removed)"

# Step 4: Archive critical snapshots, remove the rest
echo "Step 4: Archiving critical snapshots and removing temporary ones..."

# Create archived directory
mkdir -p .genie/cli/snapshots/archived/

# Move baseline snapshot (the "before" state)
if [ -d .genie/cli/snapshots/baseline-20250930-134336 ]; then
  echo "  Archiving baseline snapshot..."
  git mv .genie/cli/snapshots/baseline-20250930-134336/ .genie/cli/snapshots/archived/ || \
    mv .genie/cli/snapshots/baseline-20250930-134336/ .genie/cli/snapshots/archived/
fi

# Move evidence directory (final validation results)
if [ -d .genie/cli/snapshots/evidence ]; then
  echo "  Archiving evidence directory..."
  git mv .genie/cli/snapshots/evidence/ .genie/cli/snapshots/archived/ || \
    mv .genie/cli/snapshots/evidence/ .genie/cli/snapshots/archived/
fi

# Remove all other snapshot files (temporary QA runs)
echo "  Removing temporary snapshot files..."
find .genie/cli/snapshots -maxdepth 1 -type f -name '*.md' -exec git rm {} \; 2>/dev/null || true
find .genie/cli/snapshots -maxdepth 1 -type f -name '*.log' -exec git rm {} \; 2>/dev/null || true
find .genie/cli/snapshots -maxdepth 1 -type f -name '*.txt' -exec git rm {} \; 2>/dev/null || true

# Update .gitignore to ignore future snapshots except archived/
echo "  Updating .gitignore for snapshots..."
if ! grep -q "^\.genie/cli/snapshots/" .gitignore; then
  echo ".genie/cli/snapshots/" >> .gitignore
  echo "!.genie/cli/snapshots/archived/" >> .gitignore
fi

# Step 5: Summary
echo ""
echo "=== Cleanup Complete ==="
echo ""
echo "Summary of changes:"
git status --short | head -20
echo ""
echo "Next steps:"
echo "1. Review changes: git status"
echo "2. Rebuild CLI: cd .genie/cli && pnpm run build"
echo "3. Verify CLI works: ./genie --help"
echo "4. Commit cleanup: git commit -m 'chore: Remove build artifacts and temporary validation files'"
echo ""
echo "Expected line count reduction: ~22,793 lines (409 files)"
