"""
pg_batteries.py — PostgreSQL storage query functions for mikro.

Provides pg_search(), pg_slice(), pg_time(), pg_count(), pg_query()
that communicate with the Node.js PgStorage via the IPC bridge.

Available when storage mode is active.
"""

import json

# IPC bridge — resolved at call time from REPL namespace globals
import llm_bridge


def _pg_request(request_type, params=None):
    """Send a pg_* request to Node.js PgStorage and return parsed result."""
    payload = json.dumps(params) if params else "{}"
    results = llm_bridge.send_request(request_type, [payload])
    if not results:
        return None
    raw = results[0]
    if raw.startswith("Error:"):
        raise RuntimeError(raw)
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return raw


def _truncate_output(items, label="results"):
    """Truncate output if > 2000 chars, showing first 5 items as stub."""
    if not isinstance(items, list):
        text = str(items)
        if len(text) <= 2000:
            return text
        return text[:2000] + "\n... [truncated]"

    full = json.dumps(items, indent=2)
    if len(full) <= 2000:
        return full

    n = len(items)
    preview_items = items[:5]
    lines = [f"[{n} {label}, showing first {min(5, n)}]"]
    for item in preview_items:
        if isinstance(item, dict):
            content = item.get("content", "")
            preview = content[:100] + "..." if len(content) > 100 else content
            shown = {k: (preview if k == "content" else v) for k, v in item.items()}
            lines.append(json.dumps(shown))
        else:
            lines.append(str(item)[:100])
    lines.append("...")
    if items and isinstance(items[0], dict) and "line_num" in items[0]:
        first_ln = items[0]["line_num"]
        lines.append(f'Use pg_slice({first_ln}, {first_ln + 10}) to see full content')
    return "\n".join(lines)


def pg_search(pattern, limit=20):
    """Full-text search in stored context. Returns matching records ranked by relevance.

    Args:
        pattern: Search terms (words joined with AND)
        limit: Max results (default 20)

    Returns:
        List of {line_num, source, content, rank} dicts
    """
    result = _pg_request("pg_search", {"pattern": pattern, "limit": limit})
    if isinstance(result, list):
        return _truncate_output(result, "results")
    return result


def pg_slice(start, end):
    """Get context lines by range. Returns content for lines [start, end).

    Args:
        start: Starting line number (inclusive)
        end: Ending line number (exclusive)

    Returns:
        String with source and content of the requested lines
    """
    result = _pg_request("pg_slice", {"start": start, "end": end})
    if isinstance(result, list):
        lines = []
        for r in result:
            if isinstance(r, dict):
                src = r.get("source", "")
                content = r.get("content", "")
                lines.append(f"[{src}] {content}" if src else content)
            else:
                lines.append(str(r))
        content = "\n".join(lines)
        if len(content) > 2000:
            return content[:2000] + f"\n... [truncated, {len(result)} lines total]"
        return content
    return result


def pg_sources():
    """List distinct source files in the stored context.

    Returns:
        List of source file paths
    """
    result = _pg_request("pg_query", {
        "sql": "SELECT DISTINCT source FROM records WHERE source IS NOT NULL ORDER BY source"
    })
    if isinstance(result, list):
        return [r.get("source", "") if isinstance(r, dict) else str(r) for r in result]
    return result


def pg_time(from_time, to_time):
    """Filter context records by timestamp range.

    Args:
        from_time: Start time (e.g. '01:00' or '2024-01-01T01:00:00')
        to_time: End time

    Returns:
        List of {line_num, timestamp, content} dicts
    """
    result = _pg_request("pg_time", {"from": from_time, "to": to_time})
    if isinstance(result, list):
        return _truncate_output(result, "results")
    return result


def pg_count():
    """Count total records in stored context.

    Returns:
        Integer count
    """
    result = _pg_request("pg_count", {})
    if isinstance(result, dict):
        return result.get("count", 0)
    return result


def pg_query(sql):
    """Execute raw SQL query (read-only) against the context database.

    Args:
        sql: SQL query string

    Returns:
        List of result row dicts
    """
    result = _pg_request("pg_query", {"sql": sql})
    if isinstance(result, list):
        return _truncate_output(result, "rows")
    return result
