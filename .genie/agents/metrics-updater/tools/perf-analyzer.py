#!/usr/bin/env python3
"""perf-analyzer.py — Analyze runs.jsonl for performance trends and bottlenecks.

Reads the run log, identifies the slowest steps, tracks improvement over time,
and outputs a structured performance report for use in /refine context.

Usage:
    python3 perf-analyzer.py [--runs-file <path>] [--format text|json] [--last-n <N>]

Output:
    - Performance summary (latest run vs first run)
    - Bottleneck identification (slowest steps across runs)
    - Improvement trend (duration_ms over time)
    - Recommendations for tool generation
"""

import json
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict


def load_runs(runs_file: str) -> list[dict]:
    """Load all runs from JSONL file."""
    runs = []
    path = Path(runs_file)
    if not path.exists():
        return runs
    for line in path.read_text().strip().split('\n'):
        if line.strip():
            try:
                runs.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return runs


def analyze_bottlenecks(runs: list[dict]) -> dict:
    """Identify consistently slow steps across runs."""
    step_totals = defaultdict(list)
    for run in runs:
        for step in run.get('steps', []):
            step_totals[step['name']].append(step['duration_ms'])

    bottlenecks = {}
    for name, durations in step_totals.items():
        bottlenecks[name] = {
            'avg_ms': round(sum(durations) / len(durations), 1),
            'max_ms': max(durations),
            'min_ms': min(durations),
            'runs': len(durations),
        }

    # Sort by average duration descending
    bottlenecks = dict(sorted(bottlenecks.items(), key=lambda x: x[1]['avg_ms'], reverse=True))
    return bottlenecks


def analyze_trends(runs: list[dict]) -> dict:
    """Track improvement trends over time."""
    if not runs:
        return {'improvement_pct': 0, 'trend': 'no_data'}

    durations = [r['duration_ms'] for r in runs]
    first = durations[0]
    last = durations[-1]

    improvement = round((1 - last / first) * 100, 1) if first > 0 else 0

    trend = 'improving' if improvement > 5 else ('degrading' if improvement < -5 else 'stable')

    return {
        'first_run_ms': first,
        'latest_run_ms': last,
        'improvement_pct': improvement,
        'trend': trend,
        'total_runs': len(runs),
        'avg_duration_ms': round(sum(durations) / len(durations), 1),
    }


def generate_recommendations(bottlenecks: dict, runs: list[dict]) -> list[dict]:
    """Generate tool generation recommendations based on bottleneck analysis."""
    recommendations = []

    for step_name, stats in bottlenecks.items():
        if stats['avg_ms'] < 500:
            continue  # Skip fast steps

        rec = {
            'step': step_name,
            'avg_ms': stats['avg_ms'],
            'priority': 'high' if stats['avg_ms'] > 2000 else 'medium',
        }

        if 'fetch' in step_name:
            rec['suggestion'] = f'Cache {step_name} API responses to avoid redundant calls'
            rec['tool_type'] = 'cache'
        elif 'parse' in step_name:
            rec['suggestion'] = f'Pre-compile parsing patterns for {step_name}'
            rec['tool_type'] = 'parser_optimization'
        elif 'commit' in step_name:
            rec['suggestion'] = f'Batch git operations in {step_name}'
            rec['tool_type'] = 'git_optimization'
        elif 'readme' in step_name.lower() or 'update' in step_name:
            rec['suggestion'] = f'Cache README template for {step_name}'
            rec['tool_type'] = 'template_cache'
        else:
            rec['suggestion'] = f'Optimize {step_name} — investigate bottleneck'
            rec['tool_type'] = 'generic'

        recommendations.append(rec)

    # Sort by priority then avg_ms
    priority_order = {'high': 0, 'medium': 1, 'low': 2}
    recommendations.sort(key=lambda r: (priority_order.get(r['priority'], 2), -r['avg_ms']))

    return recommendations


def format_text_report(runs: list[dict], bottlenecks: dict, trends: dict,
                       recommendations: list[dict]) -> str:
    """Format the analysis as a human-readable text report."""
    lines = ['# Performance Analysis Report', '']

    # Summary
    lines.append('## Summary')
    lines.append(f'- Total runs analyzed: {trends["total_runs"]}')
    lines.append(f'- Average duration: {trends["avg_duration_ms"]}ms')
    lines.append(f'- First run: {trends["first_run_ms"]}ms')
    lines.append(f'- Latest run: {trends["latest_run_ms"]}ms')
    lines.append(f'- Improvement: {trends["improvement_pct"]}% ({trends["trend"]})')
    lines.append('')

    # Latest run details
    if runs:
        latest = runs[-1]
        lines.append('## Latest Run')
        lines.append(f'- Timestamp: {latest.get("timestamp", "N/A")}')
        lines.append(f'- Duration: {latest["duration_ms"]}ms')
        lines.append(f'- API calls: {latest.get("api_calls", 0)}')
        lines.append(f'- Status: {latest.get("status", "unknown")}')
        lines.append(f'- Slowest step: {latest.get("slowest_step", "unknown")}')
        if latest.get('errors'):
            lines.append(f'- Errors: {", ".join(latest["errors"])}')
        lines.append('')

        if latest.get('steps'):
            lines.append('### Step Breakdown (Latest)')
            for step in sorted(latest['steps'], key=lambda s: s['duration_ms'], reverse=True):
                bar = '#' * max(1, step['duration_ms'] // 100)
                lines.append(f'  {step["name"]:20s} {step["duration_ms"]:6d}ms {bar}')
            lines.append('')

    # Bottlenecks
    if bottlenecks:
        lines.append('## Bottlenecks (All Runs)')
        for name, stats in bottlenecks.items():
            lines.append(f'  {name:20s} avg={stats["avg_ms"]}ms  max={stats["max_ms"]}ms  min={stats["min_ms"]}ms')
        lines.append('')

    # Recommendations
    if recommendations:
        lines.append('## Recommendations for Tool Generation')
        for i, rec in enumerate(recommendations, 1):
            lines.append(f'{i}. [{rec["priority"].upper()}] {rec["suggestion"]}')
            lines.append(f'   Step: {rec["step"]} (avg {rec["avg_ms"]}ms)')
            lines.append(f'   Tool type: {rec["tool_type"]}')
        lines.append('')

    # Error history
    error_runs = [r for r in runs if r.get('errors')]
    if error_runs:
        lines.append('## Error History')
        for run in error_runs[-5:]:  # Last 5 error runs
            lines.append(f'  {run["timestamp"]}: {", ".join(run["errors"])}')
        lines.append('')

    return '\n'.join(lines)


def format_json_report(runs: list[dict], bottlenecks: dict, trends: dict,
                       recommendations: list[dict]) -> str:
    """Format the analysis as structured JSON."""
    report = {
        'generated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'trends': trends,
        'bottlenecks': bottlenecks,
        'recommendations': recommendations,
        'error_count': sum(1 for r in runs if r.get('errors')),
        'success_count': sum(1 for r in runs if r.get('status') == 'success'),
    }
    if runs:
        report['latest_run'] = {
            'timestamp': runs[-1].get('timestamp'),
            'duration_ms': runs[-1]['duration_ms'],
            'status': runs[-1].get('status'),
            'slowest_step': runs[-1].get('slowest_step'),
        }
    return json.dumps(report, indent=2)


def main():
    parser = argparse.ArgumentParser(description='Analyze metrics-updater performance')
    parser.add_argument('--runs-file', default=None,
                        help='Path to runs.jsonl (default: auto-detect)')
    parser.add_argument('--format', choices=['text', 'json'], default='text',
                        help='Output format (default: text)')
    parser.add_argument('--last-n', type=int, default=0,
                        help='Analyze only the last N runs (0 = all)')
    parser.add_argument('--output', '-o', help='Output file (default: stdout)')

    args = parser.parse_args()

    # Auto-detect runs file
    if not args.runs_file:
        script_dir = Path(__file__).parent
        agent_dir = script_dir.parent
        args.runs_file = str(agent_dir / 'state' / 'runs.jsonl')

    runs = load_runs(args.runs_file)
    if args.last_n > 0:
        runs = runs[-args.last_n:]

    if not runs:
        print('No runs found in ' + args.runs_file, file=sys.stderr)
        sys.exit(1)

    bottlenecks = analyze_bottlenecks(runs)
    trends = analyze_trends(runs)
    recommendations = generate_recommendations(bottlenecks, runs)

    if args.format == 'json':
        output = format_json_report(runs, bottlenecks, trends, recommendations)
    else:
        output = format_text_report(runs, bottlenecks, trends, recommendations)

    if args.output:
        Path(args.output).write_text(output + '\n')
        print(f'Report written to {args.output}', file=sys.stderr)
    else:
        print(output)


if __name__ == '__main__':
    main()
