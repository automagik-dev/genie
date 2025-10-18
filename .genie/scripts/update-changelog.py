#!/usr/bin/env python3
"""
CHANGELOG auto-generation for Genie self-updating ecosystem.

Parses commits since last tag, groups by type, and prepends to CHANGELOG.md.

Commit types:
  feat: New features
  fix: Bug fixes
  refactor: Code refactoring
  docs: Documentation changes
  chore: Maintenance tasks
  test: Test changes
  perf: Performance improvements

Exit codes:
  0 = CHANGELOG updated successfully
  1 = Error (no tags, git error, etc.)

Usage:
  python .genie/scripts/update-changelog.py
  python .genie/scripts/update-changelog.py --dry-run
  python .genie/scripts/update-changelog.py --help
"""

import subprocess
import sys
import re
from pathlib import Path
from datetime import datetime


def get_last_tag():
    """Get the last git tag."""
    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--abbrev=0"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()
    except subprocess.CalledProcessError:
        # No tags yet
        return None


def get_commits_since_tag(tag):
    """Get commits since tag (or all commits if no tag)."""
    try:
        if tag:
            range_spec = f"{tag}..HEAD"
        else:
            range_spec = "HEAD"

        result = subprocess.run(
            ["git", "log", range_spec, "--oneline", "--no-merges"],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip().split("\n") if result.stdout.strip() else []
    except subprocess.CalledProcessError as e:
        print(f"❌ Error getting commits: {e}")
        return []


def parse_commit(commit_line):
    """
    Parse commit line into (hash, type, message).

    Examples:
      abc1234 feat: add cool feature → ('abc1234', 'feat', 'add cool feature')
      def5678 fix: broken link → ('def5678', 'fix', 'broken link')
      ghi9012 update README → ('ghi9012', None, 'update README')
    """
    match = re.match(r"^([a-f0-9]+)\s+(.+)$", commit_line)
    if not match:
        return None

    commit_hash = match.group(1)
    message = match.group(2)

    # Check for conventional commit format: type: message
    type_match = re.match(r"^(feat|fix|refactor|docs|chore|test|perf):\s+(.+)$", message)
    if type_match:
        commit_type = type_match.group(1)
        commit_message = type_match.group(2)
        return (commit_hash, commit_type, commit_message)
    else:
        # No type prefix - categorize as "other"
        return (commit_hash, None, message)


def group_commits_by_type(commits):
    """Group commits by type."""
    grouped = {
        "feat": [],
        "fix": [],
        "refactor": [],
        "docs": [],
        "chore": [],
        "test": [],
        "perf": [],
        "other": [],
    }

    for commit_line in commits:
        parsed = parse_commit(commit_line)
        if not parsed:
            continue

        commit_hash, commit_type, message = parsed
        if commit_type and commit_type in grouped:
            grouped[commit_type].append((commit_hash, message))
        else:
            grouped["other"].append((commit_hash, message))

    return grouped


def generate_changelog_section(grouped_commits, tag):
    """Generate markdown section for CHANGELOG."""
    lines = []

    # Header
    lines.append("## [Unreleased]")
    lines.append("")

    # Type mappings
    type_headers = {
        "feat": "### Features",
        "fix": "### Fixes",
        "refactor": "### Refactor",
        "docs": "### Documentation",
        "test": "### Tests",
        "perf": "### Performance",
        "chore": "### Chore",
        "other": "### Other",
    }

    # Add sections for each type (only if has commits)
    for commit_type in ["feat", "fix", "refactor", "docs", "test", "perf", "chore", "other"]:
        commits = grouped_commits[commit_type]
        if not commits:
            continue

        lines.append(type_headers[commit_type])
        for commit_hash, message in commits:
            lines.append(f"- {message} ({commit_hash})")
        lines.append("")

    return "\n".join(lines)


def update_changelog(new_section, dry_run=False):
    """Update CHANGELOG.md by prepending new section."""
    repo_root = Path(__file__).parent.parent.parent
    changelog_path = repo_root / "CHANGELOG.md"

    # Read existing CHANGELOG or create new one
    if changelog_path.exists():
        with open(changelog_path, "r", encoding="utf-8") as f:
            existing = f.read()
    else:
        existing = "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n"

    # Check if [Unreleased] section already exists
    if "[Unreleased]" in existing:
        print("⚠️  [Unreleased] section already exists in CHANGELOG.md")
        print("   Skipping CHANGELOG update (already up to date)")
        return True

    # Prepend new section
    # Find where to insert (after header, before first version section)
    header_end = existing.find("\n\n")
    if header_end != -1:
        updated = existing[: header_end + 2] + new_section + "\n" + existing[header_end + 2 :]
    else:
        updated = existing + "\n" + new_section

    if dry_run:
        print("📄 CHANGELOG.md preview:")
        print("=" * 60)
        print(updated[:500])
        print("=" * 60)
        return True

    # Write updated CHANGELOG
    with open(changelog_path, "w", encoding="utf-8") as f:
        f.write(updated)

    # Stage CHANGELOG.md
    subprocess.run(["git", "add", str(changelog_path)], check=True)

    return True


def main():
    """Main entry point."""
    dry_run = "--dry-run" in sys.argv

    print("⚙️  Updating CHANGELOG.md...")

    # Get last tag
    last_tag = get_last_tag()
    if last_tag:
        print(f"   Last tag: {last_tag}")
    else:
        print("   No tags found - using all commits")

    # Get commits since tag
    commits = get_commits_since_tag(last_tag)
    if not commits:
        print("   No new commits since last tag")
        print("✅ CHANGELOG up to date")
        return 0

    print(f"   Found {len(commits)} commits")

    # Group by type
    grouped = group_commits_by_type(commits)

    # Generate new section
    new_section = generate_changelog_section(grouped, last_tag)

    # Update CHANGELOG.md
    if update_changelog(new_section, dry_run=dry_run):
        if dry_run:
            print("✅ CHANGELOG preview generated (dry run)")
        else:
            print("✅ CHANGELOG updated and staged")
        return 0
    else:
        print("❌ Failed to update CHANGELOG")
        return 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ["--help", "-h"]:
        print(__doc__)
        sys.exit(0)

    sys.exit(main())
