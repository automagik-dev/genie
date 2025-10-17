#!/usr/bin/env python3
"""
Validate User Files Not Committed

Prevents gitignored user files from being accidentally committed.
Part of Genie self-updating ecosystem (Group B).

Checks:
- .genie/TODO.md (personal work queue)
- .genie/USERCONTEXT.md (personal preferences)

These files should remain gitignored (per-user, never shared).

Exit 0 = validation passed (files not staged)
Exit 1 = validation failed (files staged, block commit)
"""

import sys
import subprocess
from pathlib import Path


def get_staged_files():
    """Get list of staged files from git."""
    try:
        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout.strip().split("\n") if result.stdout.strip() else []
    except subprocess.CalledProcessError as e:
        print(f"❌ Error getting staged files: {e}", file=sys.stderr)
        return []


def check_user_files_not_staged(staged_files):
    """Check if user files are in staged changes."""
    user_files = [
        ".genie/TODO.md",
        ".genie/USERCONTEXT.md"
    ]

    violations = []
    for user_file in user_files:
        if user_file in staged_files:
            violations.append(user_file)

    return violations


def main():
    """Main validation logic."""
    repo_root = Path(__file__).parent.parent.parent

    # Get staged files
    staged_files = get_staged_files()

    if not staged_files:
        # No files staged (shouldn't happen in pre-commit, but handle gracefully)
        return 0

    # Check for user file violations
    violations = check_user_files_not_staged(staged_files)

    if violations:
        print("❌ User files detected in commit (should be gitignored):", file=sys.stderr)
        print(file=sys.stderr)
        for violation in violations:
            print(f"   {violation}", file=sys.stderr)
        print(file=sys.stderr)
        print("These files are personal and should never be committed.", file=sys.stderr)
        print(file=sys.stderr)
        print("Fix:", file=sys.stderr)
        print("  1. Unstage files:", file=sys.stderr)
        for violation in violations:
            print(f"       git reset HEAD {violation}", file=sys.stderr)
        print("  2. Verify .gitignore contains:", file=sys.stderr)
        print("       .genie/TODO.md", file=sys.stderr)
        print("       .genie/USERCONTEXT.md", file=sys.stderr)
        print("  3. Retry commit", file=sys.stderr)
        print(file=sys.stderr)
        return 1

    # All checks passed
    print("✅ User files validation passed (no personal files in commit)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
