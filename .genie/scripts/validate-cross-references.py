#!/usr/bin/env python3
"""
Validate Cross-References

Validates @ references in markdown files point to existing files.
Part of Genie self-updating ecosystem (Group B).

Checks:
- @file.md references exist
- @directory/ references exist
- Reports broken references with context

Exit 0 = all references valid
Exit 1 = broken references found (block commit)
"""

import sys
import re
from pathlib import Path


def find_markdown_files(root_path):
    """Find all markdown files in repository."""
    markdown_files = []

    for pattern in ["**/*.md", "**/*.MD"]:
        markdown_files.extend(root_path.glob(pattern))

    # Filter out node_modules, .git, etc.
    excluded_dirs = {".git", "node_modules", "dist", "build", ".genie/state"}

    return [
        f for f in markdown_files
        if not any(excluded in f.parts for excluded in excluded_dirs)
    ]


def extract_at_references(file_path):
    """Extract @ references from markdown file."""
    try:
        content = file_path.read_text(encoding="utf-8")
    except Exception as e:
        print(f"⚠️  Warning: Could not read {file_path}: {e}", file=sys.stderr)
        return []

    # Pattern: @path (can be file or directory)
    # Matches: @file.md, @.genie/agents/core.md, @directory/
    pattern = r'@([\w\-./]+(?:\.md|/)?)(?:\s|$|[^\w\-./])'

    references = []
    for match in re.finditer(pattern, content):
        ref_path = match.group(1)
        # Get line number for context
        line_num = content[:match.start()].count('\n') + 1
        references.append((ref_path, line_num))

    return references


def validate_reference(ref_path, source_file, repo_root):
    """Validate that a reference points to existing file/directory."""
    # Reference paths are relative to repo root
    target_path = repo_root / ref_path

    # Check if it's a directory reference (ends with /)
    if ref_path.endswith('/'):
        if not target_path.is_dir():
            return False, f"Directory not found: {ref_path}"
        return True, None

    # Check if it's a file reference
    if not target_path.is_file():
        return False, f"File not found: {ref_path}"

    return True, None


def main():
    """Main validation logic."""
    repo_root = Path(__file__).parent.parent.parent

    print("🔍 Validating @ cross-references...")

    # Find all markdown files
    markdown_files = find_markdown_files(repo_root)
    print(f"   Found {len(markdown_files)} markdown files to check")

    # Track broken references
    broken_references = []

    # Check each file
    for md_file in markdown_files:
        references = extract_at_references(md_file)

        for ref_path, line_num in references:
            is_valid, error_msg = validate_reference(ref_path, md_file, repo_root)

            if not is_valid:
                # Get relative path for cleaner output
                rel_path = md_file.relative_to(repo_root)
                broken_references.append({
                    'source': str(rel_path),
                    'line': line_num,
                    'reference': ref_path,
                    'error': error_msg
                })

    # Report results
    if broken_references:
        print(f"\n❌ Found {len(broken_references)} broken @ reference(s):", file=sys.stderr)
        print(file=sys.stderr)

        for broken in broken_references:
            print(f"   {broken['source']}:{broken['line']}", file=sys.stderr)
            print(f"      @{broken['reference']}", file=sys.stderr)
            print(f"      {broken['error']}", file=sys.stderr)
            print(file=sys.stderr)

        print("Fix broken references before committing.", file=sys.stderr)
        return 1

    print("✅ All @ cross-references valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
