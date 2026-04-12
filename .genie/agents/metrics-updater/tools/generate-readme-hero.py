#!/usr/bin/env python3
"""Update README.md METRICS block with a compact hero line.

Reads daily-stats.jsonl for 7d summary numbers, then replaces everything
between <!-- METRICS:START --> and <!-- METRICS:END --> in README.md.

Usage:
  python3 generate-readme-hero.py [--stats-dir DIR] [--readme PATH]
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta


def repo_root():
    return subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True
    ).strip()


def load_aliases(path):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {}


def load_stats(jsonl_path):
    entries = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))
    entries.sort(key=lambda d: d["date"])
    return entries


def compute_7d(entries, aliases):
    today = datetime.now().date()
    cutoff = (today - timedelta(days=7)).isoformat()
    filtered = [e for e in entries if e["date"] > cutoff]

    commits = sum(e["commits"] for e in filtered)
    releases = sum(e["releases"] for e in filtered)
    loc_added = sum(e["loc_added"] for e in filtered)
    loc_removed = sum(e["loc_removed"] for e in filtered)
    loc_net = loc_added - loc_removed

    contributors = set()
    for e in filtered:
        for c in e.get("contributors", []):
            contributors.add(aliases.get(c, c))

    return commits, releases, loc_net, len(contributors)


def fmt_loc(n):
    sign = "+" if n >= 0 else ""
    if abs(n) >= 1_000_000:
        return f"{sign}{n / 1_000_000:.1f}M"
    if abs(n) >= 1_000:
        return f"{sign}{n / 1_000:.1f}K"
    return f"{sign}{n}"


def main():
    root = repo_root()

    parser = argparse.ArgumentParser(description="Update README.md metrics hero")
    parser.add_argument(
        "--stats-dir",
        default=os.path.join(root, ".genie", "agents", "metrics-updater"),
    )
    parser.add_argument(
        "--readme",
        default=os.path.join(root, "README.md"),
    )
    args = parser.parse_args()

    jsonl_path = os.path.join(args.stats_dir, "daily-stats.jsonl")
    aliases_path = os.path.join(args.stats_dir, "author-aliases.json")

    if not os.path.exists(jsonl_path):
        print(f"[generate-readme-hero] ERROR: {jsonl_path} not found", file=sys.stderr)
        sys.exit(1)

    aliases = load_aliases(aliases_path)
    entries = load_stats(jsonl_path)
    commits, releases, loc_net, contributors = compute_7d(entries, aliases)

    hero_line = (
        f"**\U0001f680 {commits} commits** this week · "
        f"**{releases} releases** · "
        f"**{fmt_loc(loc_net)} LoC** · "
        f"**{contributors} contributors**"
    )

    # Full block lives INSIDE the markers — nothing after END so GitHub
    # markdown renders cleanly. Includes the commits chart as a visual
    # showpiece and a clean "full dashboard" link on its own line.
    replacement = (
        "<!-- METRICS:START -->\n"
        f"{hero_line}\n"
        "\n"
        "![Commits per day (30d, all branches)](.genie/assets/commits-30d.svg)\n"
        "\n"
        "[📊 Full velocity dashboard →](VELOCITY.md)\n"
        "<!-- METRICS:END -->"
    )

    with open(args.readme, "r") as f:
        content = f.read()

    # Match the full block including any trailing stray text that previous
    # broken versions may have placed after the END marker on the same
    # line (self-healing from the earlier "END --> · [Full dashboard]" bug).
    pattern = r"<!-- METRICS:START -->.*?<!-- METRICS:END -->[^\n]*"
    new_content, count = re.subn(pattern, replacement, content, flags=re.DOTALL)

    if count == 0:
        print("[generate-readme-hero] ERROR: METRICS markers not found in README.md", file=sys.stderr)
        sys.exit(1)

    with open(args.readme, "w") as f:
        f.write(new_content)

    print(f"[generate-readme-hero] Updated README.md ({commits} commits, {releases} releases, {fmt_loc(loc_net)} LoC, {contributors} contributors)", file=sys.stderr)


if __name__ == "__main__":
    main()
