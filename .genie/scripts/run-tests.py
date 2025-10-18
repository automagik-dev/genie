#!/usr/bin/env python3
"""
Pre-push test runner for Genie self-updating ecosystem.

Executes pnpm test before push to ensure tests pass on remote.

Exit codes:
  0 = All tests passed
  1 = Tests failed (blocks push)

Usage:
  python .genie/scripts/run-tests.py
  python .genie/scripts/run-tests.py --help
"""

import subprocess
import sys
from pathlib import Path


def main():
    """Run test suite and exit with test exit code."""
    repo_root = Path(__file__).parent.parent.parent

    print("⚙️  Running tests...")

    try:
        # Run pnpm test:all, streaming output to console
        result = subprocess.run(
            ["pnpm", "run", "test:all"],
            cwd=repo_root,
            # Don't capture output - let it stream to console
            stdout=None,
            stderr=None,
        )

        if result.returncode == 0:
            print("✅ Tests passed")
            return 0
        else:
            print(f"❌ Tests failed (exit code: {result.returncode})")
            print("   Fix failing tests before pushing")
            return 1

    except FileNotFoundError:
        print("❌ pnpm not found - install Node.js and pnpm first")
        return 1
    except Exception as e:
        print(f"❌ Error running tests: {e}")
        return 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ["--help", "-h"]:
        print(__doc__)
        sys.exit(0)

    sys.exit(main())
