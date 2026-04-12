#!/usr/bin/env python3
"""SVG chart engine for velocity dashboard.

Reads daily-stats.jsonl and generates three SVG bar charts:
  - commits-30d.svg  (blue bars, daily commit counts)
  - releases-30d.svg (purple bars, daily release counts)
  - loc-30d.svg      (stacked bars, green additions + red deletions)

Usage:
  python3 generate-charts.py --input daily-stats.jsonl --output-dir ../../assets
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta

# ── Style constants ──────────────────────────────────────────────────────────
BG_COLOR = "#0d1117"
GRID_COLOR = "#21262d"
TEXT_COLOR = "#8b949e"
LABEL_COLOR = "#c9d1d9"
FONT = "system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"

COLOR_BLUE = "#58a6ff"
COLOR_GREEN = "#3fb950"
COLOR_RED = "#f85149"
COLOR_PURPLE = "#bc8cff"

CHART_W = 800
CHART_H = 200
MARGIN_L = 55
MARGIN_R = 15
MARGIN_T = 25
MARGIN_B = 30
BAR_GAP = 2


def escape_xml(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def fmt_num(n):
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def build_bar_chart(title, days, value_key, bar_color):
    """Generate a single-series bar chart SVG string."""
    values = [d.get(value_key, 0) for d in days]
    max_val = max(values) if values and max(values) > 0 else 1

    plot_w = CHART_W - MARGIN_L - MARGIN_R
    plot_h = CHART_H - MARGIN_T - MARGIN_B
    bar_w = (plot_w / len(days)) - BAR_GAP if days else 10

    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{CHART_W}" height="{CHART_H}" viewBox="0 0 {CHART_W} {CHART_H}">',
        f'<rect width="{CHART_W}" height="{CHART_H}" fill="{BG_COLOR}" rx="6"/>',
        f'<style>text {{ font-family: {FONT}; fill: {TEXT_COLOR}; font-size: 11px; }}</style>',
        # Title
        f'<text x="{MARGIN_L}" y="16" fill="{LABEL_COLOR}" font-size="13" font-weight="600">{escape_xml(title)}</text>',
        # Y-axis max label
        f'<text x="{MARGIN_L - 8}" y="{MARGIN_T + 10}" text-anchor="end" font-size="10">{fmt_num(max_val)}</text>',
        # Y-axis zero label
        f'<text x="{MARGIN_L - 8}" y="{MARGIN_T + plot_h}" text-anchor="end" font-size="10">0</text>',
        # Grid lines
        f'<line x1="{MARGIN_L}" y1="{MARGIN_T}" x2="{CHART_W - MARGIN_R}" y2="{MARGIN_T}" stroke="{GRID_COLOR}" stroke-width="1"/>',
        f'<line x1="{MARGIN_L}" y1="{MARGIN_T + plot_h}" x2="{CHART_W - MARGIN_R}" y2="{MARGIN_T + plot_h}" stroke="{GRID_COLOR}" stroke-width="1"/>',
    ]

    # Midpoint grid line
    mid_y = MARGIN_T + plot_h / 2
    lines.append(f'<line x1="{MARGIN_L}" y1="{mid_y}" x2="{CHART_W - MARGIN_R}" y2="{mid_y}" stroke="{GRID_COLOR}" stroke-width="0.5" stroke-dasharray="4,4"/>')
    lines.append(f'<text x="{MARGIN_L - 8}" y="{mid_y + 4}" text-anchor="end" font-size="10">{fmt_num(max_val // 2)}</text>')

    for i, (day, val) in enumerate(zip(days, values)):
        x = MARGIN_L + i * (bar_w + BAR_GAP)
        bar_h = (val / max_val) * plot_h if max_val > 0 else 0
        y = MARGIN_T + plot_h - bar_h
        lines.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w:.1f}" height="{bar_h:.1f}" fill="{bar_color}" rx="1.5" opacity="0.9"/>')

        # Date labels on first and last bar
        if i == 0 or i == len(days) - 1:
            label = day["date"][5:]  # MM-DD
            lx = x + bar_w / 2
            lines.append(f'<text x="{lx:.1f}" y="{CHART_H - 5}" text-anchor="middle" font-size="10">{label}</text>')

    lines.append("</svg>")
    return "\n".join(lines)


def build_stacked_chart(title, days):
    """Generate a stacked bar chart for LoC (additions + deletions)."""
    added = [d.get("loc_added", 0) for d in days]
    removed = [d.get("loc_removed", 0) for d in days]
    max_val = max(a + r for a, r in zip(added, removed)) if days else 1
    if max_val == 0:
        max_val = 1

    plot_w = CHART_W - MARGIN_L - MARGIN_R
    plot_h = CHART_H - MARGIN_T - MARGIN_B
    bar_w = (plot_w / len(days)) - BAR_GAP if days else 10

    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{CHART_W}" height="{CHART_H}" viewBox="0 0 {CHART_W} {CHART_H}">',
        f'<rect width="{CHART_W}" height="{CHART_H}" fill="{BG_COLOR}" rx="6"/>',
        f'<style>text {{ font-family: {FONT}; fill: {TEXT_COLOR}; font-size: 11px; }}</style>',
        # Title
        f'<text x="{MARGIN_L}" y="16" fill="{LABEL_COLOR}" font-size="13" font-weight="600">{escape_xml(title)}</text>',
        # Legend
        f'<rect x="{CHART_W - 160}" y="6" width="10" height="10" fill="{COLOR_GREEN}" rx="2"/>',
        f'<text x="{CHART_W - 146}" y="15" font-size="10" fill="{LABEL_COLOR}">added</text>',
        f'<rect x="{CHART_W - 100}" y="6" width="10" height="10" fill="{COLOR_RED}" rx="2"/>',
        f'<text x="{CHART_W - 86}" y="15" font-size="10" fill="{LABEL_COLOR}">removed</text>',
        # Y-axis labels
        f'<text x="{MARGIN_L - 8}" y="{MARGIN_T + 10}" text-anchor="end" font-size="10">{fmt_num(max_val)}</text>',
        f'<text x="{MARGIN_L - 8}" y="{MARGIN_T + plot_h}" text-anchor="end" font-size="10">0</text>',
        # Grid lines
        f'<line x1="{MARGIN_L}" y1="{MARGIN_T}" x2="{CHART_W - MARGIN_R}" y2="{MARGIN_T}" stroke="{GRID_COLOR}" stroke-width="1"/>',
        f'<line x1="{MARGIN_L}" y1="{MARGIN_T + plot_h}" x2="{CHART_W - MARGIN_R}" y2="{MARGIN_T + plot_h}" stroke="{GRID_COLOR}" stroke-width="1"/>',
    ]

    mid_y = MARGIN_T + plot_h / 2
    lines.append(f'<line x1="{MARGIN_L}" y1="{mid_y}" x2="{CHART_W - MARGIN_R}" y2="{mid_y}" stroke="{GRID_COLOR}" stroke-width="0.5" stroke-dasharray="4,4"/>')
    lines.append(f'<text x="{MARGIN_L - 8}" y="{mid_y + 4}" text-anchor="end" font-size="10">{fmt_num(max_val // 2)}</text>')

    for i, (day, a, r) in enumerate(zip(days, added, removed)):
        x = MARGIN_L + i * (bar_w + BAR_GAP)
        total_h = ((a + r) / max_val) * plot_h
        add_h = (a / max_val) * plot_h
        rem_h = (r / max_val) * plot_h
        base_y = MARGIN_T + plot_h

        # Removed (red) on bottom
        if rem_h > 0:
            lines.append(f'<rect x="{x:.1f}" y="{base_y - rem_h:.1f}" width="{bar_w:.1f}" height="{rem_h:.1f}" fill="{COLOR_RED}" rx="1.5" opacity="0.9"/>')
        # Added (green) stacked on top
        if add_h > 0:
            lines.append(f'<rect x="{x:.1f}" y="{base_y - total_h:.1f}" width="{bar_w:.1f}" height="{add_h:.1f}" fill="{COLOR_GREEN}" rx="1.5" opacity="0.9"/>')

        if i == 0 or i == len(days) - 1:
            label = day["date"][5:]
            lx = x + bar_w / 2
            lines.append(f'<text x="{lx:.1f}" y="{CHART_H - 5}" text-anchor="middle" font-size="10">{label}</text>')

    lines.append("</svg>")
    return "\n".join(lines)


def generate_sample_data():
    """Generate 30 days of sample data for development/testing."""
    import random
    random.seed(42)
    today = datetime.now().date()
    days = []
    for i in range(29, -1, -1):
        d = today - timedelta(days=i)
        days.append({
            "date": d.isoformat(),
            "commits": random.randint(5, 120),
            "loc_added": random.randint(200, 5000),
            "loc_removed": random.randint(100, 3000),
            "releases": random.randint(0, 8),
            "contributors": [f"dev{j}" for j in range(random.randint(1, 5))]
        })
    return days


def load_data(path):
    """Load daily-stats.jsonl, return last 30 entries sorted by date."""
    entries = []
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))
    entries.sort(key=lambda d: d["date"])
    return entries[-30:]


def main():
    parser = argparse.ArgumentParser(description="Generate velocity SVG charts")
    parser.add_argument("--input", required=True, help="Path to daily-stats.jsonl")
    parser.add_argument("--output-dir", required=True, help="Directory for SVG output")
    parser.add_argument("--sample", action="store_true", help="Use generated sample data")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    if args.sample or not os.path.exists(args.input):
        print(f"[generate-charts] Using sample data (input {'not found' if not os.path.exists(args.input) else 'bypassed'})", file=sys.stderr)
        days = generate_sample_data()
    else:
        days = load_data(args.input)

    if not days:
        print("[generate-charts] ERROR: No data to chart", file=sys.stderr)
        sys.exit(1)

    charts = [
        ("commits-30d.svg", build_bar_chart("Commits / Day (30d)", days, "commits", COLOR_BLUE)),
        ("releases-30d.svg", build_bar_chart("Releases / Day (30d)", days, "releases", COLOR_PURPLE)),
        ("loc-30d.svg", build_stacked_chart("Lines of Code / Day (30d)", days)),
    ]

    for filename, svg in charts:
        path = os.path.join(args.output_dir, filename)
        with open(path, "w") as f:
            f.write(svg)
        size = os.path.getsize(path)
        print(f"[generate-charts] {filename}: {size:,} bytes", file=sys.stderr)
        if size > 20_480:
            print(f"[generate-charts] WARNING: {filename} exceeds 20KB limit", file=sys.stderr)

    print(f"[generate-charts] Generated {len(charts)} charts in {args.output_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
