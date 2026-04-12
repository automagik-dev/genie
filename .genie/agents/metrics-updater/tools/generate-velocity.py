#!/usr/bin/env python3
"""Generate VELOCITY.md dashboard from daily-stats.jsonl and cumulative git stats.

Usage:
  python3 generate-velocity.py [--stats-dir DIR] [--assets-dir DIR] [--output PATH]

Defaults assume execution from repo root with standard agent layout.
"""

import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict
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


def normalize(name, aliases):
    return aliases.get(name, name)


def load_stats(jsonl_path):
    entries = []
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))
    entries.sort(key=lambda d: d["date"])
    return entries


def get_cumulative(collect_script):
    result = subprocess.check_output(
        ["bash", collect_script, "--cumulative"], text=True
    )
    return json.loads(result.strip())


def compute_summary(entries, aliases):
    today = datetime.now().date()
    cutoff_7d = (today - timedelta(days=7)).isoformat()
    cutoff_30d = (today - timedelta(days=30)).isoformat()

    summary = {"7d": {}, "30d": {}, "all_time": {}}

    for window_key, cutoff in [("7d", cutoff_7d), ("30d", cutoff_30d), ("all_time", "")]:
        filtered = [e for e in entries if e["date"] > cutoff] if cutoff else entries
        commits = sum(e["commits"] for e in filtered)
        releases = sum(e["releases"] for e in filtered)
        loc_added = sum(e["loc_added"] for e in filtered)
        loc_removed = sum(e["loc_removed"] for e in filtered)
        contributors = set()
        for e in filtered:
            for c in e.get("contributors", []):
                contributors.add(normalize(c, aliases))
        summary[window_key] = {
            "commits": commits,
            "releases": releases,
            "loc_added": loc_added,
            "loc_removed": loc_removed,
            "loc_net": loc_added - loc_removed,
            "contributors": len(contributors),
        }

    return summary


def compute_leaderboard(entries, aliases, days=30):
    today = datetime.now().date()
    cutoff = (today - timedelta(days=days)).isoformat()
    filtered = [e for e in entries if e["date"] > cutoff]

    counts = defaultdict(int)
    for e in filtered:
        per_author = e["commits"] // max(len(e.get("contributors", [])), 1)
        for c in e.get("contributors", []):
            canonical = normalize(c, aliases)
            counts[canonical] += per_author

    ranked = sorted(counts.items(), key=lambda x: -x[1])
    return ranked[:15]


def fmt_num(n):
    if abs(n) >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if abs(n) >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def fmt_signed(n):
    prefix = "+" if n > 0 else ""
    return f"{prefix}{fmt_num(n)}"


def generate_velocity_md(summary, cumulative, leaderboard, assets_dir, entries):
    date_range_start = entries[0]["date"] if entries else "N/A"
    date_range_end = entries[-1]["date"] if entries else "N/A"
    now = datetime.now().strftime("%Y-%m-%d %H:%M UTC")

    s7 = summary["7d"]
    s30 = summary["30d"]
    sa = summary["all_time"]

    lines = [
        "# Velocity Dashboard",
        "",
        f"> Last updated: {now} | Data range: {date_range_start} to {date_range_end}",
        "",
        "## At a Glance",
        "",
        "| Metric | 7 days | 30 days | All time |",
        "|--------|-------:|--------:|---------:|",
        f"| Commits | {fmt_num(s7['commits'])} | {fmt_num(s30['commits'])} | {fmt_num(cumulative['total_commits'])} |",
        f"| Releases | {fmt_num(s7['releases'])} | {fmt_num(s30['releases'])} | {fmt_num(cumulative['total_tags'])} |",
        f"| LoC (net) | {fmt_signed(s7['loc_net'])} | {fmt_signed(s30['loc_net'])} | — |",
        f"| Contributors | {s7['contributors']} | {s30['contributors']} | {cumulative['total_contributors']} |",
        "",
        "---",
        "",
        "## Commits per Day",
        "",
        f"![Commits per day]({assets_dir}/commits-30d.svg)",
        "",
        "## Releases per Day",
        "",
        f"![Releases per day]({assets_dir}/releases-30d.svg)",
        "",
        "## Lines of Code per Day",
        "",
        f"![Lines of code per day]({assets_dir}/loc-30d.svg)",
        "",
        "---",
        "",
        "## Contributor Leaderboard (30d)",
        "",
        "| Rank | Contributor | Commits (approx) |",
        "|-----:|-------------|------------------:|",
    ]

    for i, (name, count) in enumerate(leaderboard, 1):
        lines.append(f"| {i} | {name} | {count} |")

    lines.append("")
    lines.append(f"*{cumulative['total_contributors']} contributors since {cumulative['first_commit_date']}*")
    lines.append("")

    return "\n".join(lines)


def main():
    root = repo_root()

    parser = argparse.ArgumentParser(description="Generate VELOCITY.md dashboard")
    parser.add_argument(
        "--stats-dir",
        default=os.path.join(root, ".genie", "agents", "metrics-updater"),
    )
    parser.add_argument(
        "--assets-dir",
        default=".genie/assets",
        help="Relative path from repo root to SVG assets (for markdown links)",
    )
    parser.add_argument(
        "--output",
        default=os.path.join(root, "VELOCITY.md"),
    )
    args = parser.parse_args()

    jsonl_path = os.path.join(args.stats_dir, "daily-stats.jsonl")
    aliases_path = os.path.join(args.stats_dir, "author-aliases.json")
    collect_script = os.path.join(args.stats_dir, "tools", "collect-stats.sh")

    if not os.path.exists(jsonl_path):
        print(f"[generate-velocity] ERROR: {jsonl_path} not found", file=sys.stderr)
        sys.exit(1)

    aliases = load_aliases(aliases_path)
    entries = load_stats(jsonl_path)
    summary = compute_summary(entries, aliases)
    cumulative = get_cumulative(collect_script)
    leaderboard = compute_leaderboard(entries, aliases)

    md = generate_velocity_md(summary, cumulative, leaderboard, args.assets_dir, entries)

    with open(args.output, "w") as f:
        f.write(md)

    print(f"[generate-velocity] Wrote {args.output} ({len(md):,} bytes)", file=sys.stderr)


if __name__ == "__main__":
    main()
