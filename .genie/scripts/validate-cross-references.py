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


def is_false_positive(ref_path, context):
    """
    Check if @ reference is a false positive (not a file reference).

    False positives:
    - Email addresses: @domain.tld, user@domain.tld
    - npm tags: @next, @latest
    - npm versions: @2.1.0, @X.Y.Z
    - npm scoped packages: @org/package
    - Social media handles: @username (in markdown links)
    - Documentation examples: common placeholder names
    - Resource identifiers: @mcp:resource
    """
    # Email addresses (contains @ before or has .tld pattern)
    if '@' in context[:context.find(f'@{ref_path}')] or \
       re.match(r'^[\w\-]+\.(com|ai|org|net|io|dev)$', ref_path):
        return True

    # npm distribution tags
    if ref_path in ['next', 'latest', 'canary', 'rc', 'beta', 'alpha']:
        return True

    # npm version patterns (@X.Y.Z, @2.1.0, @X.Y.Z-rc.N, @X.Y.Z-rc.1)
    if re.match(r'^\d+\.\d+\.\d+(-[\w.]+)?$', ref_path) or \
       re.match(r'^[XYZ]\.[XYZ]\.[XYZ](-rc\.[XYZ\d]+)?$', ref_path):
        return True

    # npm scoped packages (@org/package)
    if '/' in ref_path and not ref_path.endswith('/'):
        # Check if it looks like npm package (short names, no .md)
        parts = ref_path.split('/')
        if len(parts) == 2 and not ref_path.endswith('.md'):
            return True

    # Documentation example placeholders
    placeholders = [
        'file.md', 'directory/', 'path', 'include',
        'mcp', '...', 'X.Y.Z'
    ]
    if ref_path in placeholders:
        return True

    # Placeholder patterns (startswith)
    if ref_path.startswith('agent-'):  # @agent-implementor, @agent-foo
        return True

    # Twitter/GitHub handles (single word after @)
    if re.match(r'^[\w\-]+$', ref_path) and len(ref_path) < 20:
        # Check context for social media patterns
        if any(pattern in context for pattern in ['twitter.com', 'github.com', '[@', 'Follow']):
            return True

    # Resource identifiers (@mcp:, @tech-lead:, etc.)
    if ':' in ref_path:
        return True

    return False


def is_in_code_block(content, match_start):
    """Check if position is inside a code fence or inline code."""
    # Check for code fences (``` or ~~~)
    before_match = content[:match_start]

    # Count code fences before this position
    triple_backticks = before_match.count('```')
    triple_tildes = before_match.count('~~~')

    # If odd number of fences, we're inside a code block
    if triple_backticks % 2 == 1 or triple_tildes % 2 == 1:
        return True

    # Check for inline code (backticks on same line)
    # Find the line containing this match
    last_newline = before_match.rfind('\n')
    if last_newline == -1:
        last_newline = 0
    line_start = last_newline

    # Look ahead to find line end
    after_match = content[match_start:]
    next_newline = after_match.find('\n')
    if next_newline == -1:
        line_end = len(content)
    else:
        line_end = match_start + next_newline

    # Get the full line
    line = content[line_start:line_end]

    # Find position of @ within the line
    match_pos_in_line = match_start - line_start

    # Count backticks before the @ on this line
    backticks_before = line[:match_pos_in_line].count('`')

    # If odd number of backticks before, we're inside inline code
    if backticks_before % 2 == 1:
        return True

    return False


def extract_at_references(file_path):
    """Extract @ references from markdown file."""
    try:
        content = file_path.read_text(encoding="utf-8")
    except Exception as e:
        print(f"⚠️  Warning: Could not read {file_path}: {e}", file=sys.stderr)
        return []

    # Pattern: @path (can be file or directory)
    # Matches: @file.md, @.genie/agents/core.md, @directory/
    pattern = r'@([\w\-./]+(?:\.md|/)?)(?:\s|$|[^\w\-./:])'

    references = []
    for match in re.finditer(pattern, content):
        # Skip if inside code block or inline code
        if is_in_code_block(content, match.start()):
            continue

        ref_path = match.group(1)
        line_num = content[:match.start()].count('\n') + 1

        # Get surrounding context (±50 chars) for false positive detection
        start = max(0, match.start() - 50)
        end = min(len(content), match.end() + 50)
        context = content[start:end]

        # Skip false positives
        if is_false_positive(ref_path, context):
            continue

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
