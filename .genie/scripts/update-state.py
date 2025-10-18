#!/usr/bin/env python3
"""
Post-merge hook: Auto-update STATE.md validation metadata.

Updates last_version field in STATE.md validation metadata after merge,
then auto-commits with [skip ci] to avoid triggering CI loops.

Usage:
    python .genie/scripts/update-state.py [--dry-run]

Requires:
    - Git repository
    - package.json with version field
    - .genie/STATE.md file

Exit codes:
    0 - Success (STATE.md updated and committed)
    1 - Error (validation failed or commit failed)
"""

import sys
import json
import subprocess
import re
from pathlib import Path


def run_command(cmd, capture=True):
    """Run shell command and return output."""
    try:
        if capture:
            result = subprocess.run(
                cmd, shell=True, capture_output=True, text=True, check=True
            )
            return result.stdout.strip()
        else:
            subprocess.run(cmd, shell=True, check=True)
            return None
    except subprocess.CalledProcessError as e:
        print(f"❌ Command failed: {cmd}")
        print(f"   Error: {e.stderr if capture else e}")
        sys.exit(1)


def get_current_version():
    """Extract version from package.json."""
    package_json = Path("package.json")
    if not package_json.exists():
        print("❌ package.json not found")
        sys.exit(1)

    with open(package_json) as f:
        data = json.load(f)
        version = data.get("version")
        if not version:
            print("❌ No version field in package.json")
            sys.exit(1)
        return version


def get_current_commit():
    """Get current commit hash (short)."""
    return run_command("git log -1 --format=%h")


def update_state_metadata(version, dry_run=False):
    """Update last_version in STATE.md validation metadata."""
    state_file = Path(".genie/STATE.md")
    if not state_file.exists():
        print("❌ .genie/STATE.md not found")
        sys.exit(1)

    # Read current content
    with open(state_file) as f:
        content = f.read()

    # Update last_version field in validation metadata
    # Pattern: last_version: <any value>
    pattern = r"(last_version:\s+)[^\n]+"
    replacement = rf"\g<1>{version}"
    updated_content = re.sub(pattern, replacement, content)

    if content == updated_content:
        print(f"✅ STATE.md already up to date (version: {version})")
        return False  # No changes needed

    if dry_run:
        print(f"🔍 DRY RUN: Would update STATE.md")
        print(f"   Version: {version}")
        return True

    # Write updated content
    with open(state_file, "w") as f:
        f.write(updated_content)

    print(f"✅ Updated STATE.md metadata")
    print(f"   Version: {version}")
    return True


def main():
    dry_run = "--dry-run" in sys.argv

    print("⚙️  Post-merge: Updating STATE.md metadata...")

    # Get current state
    version = get_current_version()
    commit = get_current_commit()

    print(f"📊 Current state:")
    print(f"   Version: {version}")
    print(f"   Commit:  {commit}")

    # Update STATE.md metadata
    updated = update_state_metadata(version, dry_run)

    if not updated:
        print("✅ No changes needed - STATE.md already current")
        sys.exit(0)

    if dry_run:
        print("🔍 DRY RUN: Would commit changes with [skip ci]")
        sys.exit(0)

    # Stage STATE.md
    run_command("git add .genie/STATE.md", capture=False)
    print("✅ Staged .genie/STATE.md")

    # Auto-commit with [skip ci]
    commit_msg = f"chore: auto-update STATE.md to v{version} [skip ci]"
    run_command(f'git commit -m "{commit_msg}"', capture=False)
    print(f"✅ Auto-committed: {commit_msg}")

    print()
    print("✅ STATE.md update complete!")
    sys.exit(0)


if __name__ == "__main__":
    main()
