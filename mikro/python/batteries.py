"""
batteries.py — mikro built-in power tools.

Convenience functions that save the LLM 1-2 iterations of boilerplate.
Stdlib only — no external dependencies.

Available when --tools standard or --tools full.

Functions reference `context`, `llm_query`, and `llm_query_batched` from the
REPL namespace (injected via exec). They are resolved at call time through
the function's __globals__ dict.
"""

import re


def describe_context(ctx=None):
    """Describe the loaded context: type, size, item count, previews."""
    if ctx is None:
        ctx = context  # noqa: F821 — injected into REPL namespace

    if isinstance(ctx, str):
        return (
            f"Context type: string\n"
            f"Size: {len(ctx)} characters\n"
            f"Preview: {ctx[:200]}{'...' if len(ctx) > 200 else ''}"
        )

    if isinstance(ctx, list):
        total_chars = 0
        items_info = []
        for i, item in enumerate(ctx):
            if isinstance(item, dict):
                path = item.get("path", f"[{i}]")
                content = item.get("content", str(item))
                size = len(content)
                total_chars += size
                items_info.append(f"  {path} ({size} chars)")
            else:
                s = str(item)
                total_chars += len(s)
                items_info.append(f"  [{i}] ({len(s)} chars)")

        preview = "\n".join(items_info[:5])
        if len(items_info) > 5:
            preview += f"\n  ... and {len(items_info) - 5} more"

        return (
            f"Context type: list\n"
            f"Items: {len(ctx)}\n"
            f"Total size: {total_chars} characters\n"
            f"Items:\n{preview}"
        )

    if isinstance(ctx, dict):
        keys = list(ctx.keys())
        return (
            f"Context type: dict\n"
            f"Keys: {len(keys)}\n"
            f"Key names: {keys[:20]}{'...' if len(keys) > 20 else ''}"
        )

    return f"Context type: {type(ctx).__name__}, value: {str(ctx)[:200]}"


def preview_context(n=5, chars=200, ctx=None):
    """Show first n context items with truncated previews."""
    if ctx is None:
        ctx = context  # noqa: F821

    if isinstance(ctx, str):
        return ctx[:chars] + ("..." if len(ctx) > chars else "")

    if isinstance(ctx, list):
        lines = []
        for i, item in enumerate(ctx[:n]):
            if isinstance(item, dict):
                path = item.get("path", f"[{i}]")
                content = item.get("content", str(item))
            else:
                path = f"[{i}]"
                content = str(item)

            preview = content[:chars].replace("\n", " ")
            if len(content) > chars:
                preview += "..."
            lines.append(f"--- {path} ---\n{preview}")

        if len(ctx) > n:
            lines.append(f"\n... and {len(ctx) - n} more items")

        return "\n\n".join(lines)

    return str(ctx)[:chars]


def search_context(query, top_n=10, ctx=None):
    """Keyword search across context items. Returns top_n matches sorted by relevance."""
    if ctx is None:
        ctx = context  # noqa: F821

    if isinstance(ctx, str):
        query_lower = query.lower()
        lines = ctx.split("\n")
        matches = []
        for i, line in enumerate(lines):
            if query_lower in line.lower():
                matches.append(f"Line {i + 1}: {line.strip()}")
        return "\n".join(matches[:top_n]) if matches else "No matches found."

    if isinstance(ctx, list):
        query_lower = query.lower()
        scored = []
        for i, item in enumerate(ctx):
            if isinstance(item, dict):
                path = item.get("path", f"[{i}]")
                content = item.get("content", str(item))
            else:
                path = f"[{i}]"
                content = str(item)

            content_lower = content.lower()
            count = content_lower.count(query_lower)
            if count > 0:
                scored.append((count, path, content))

        scored.sort(key=lambda x: x[0], reverse=True)

        results = []
        for count, path, content in scored[:top_n]:
            idx = content.lower().find(query_lower)
            start = max(0, idx - 50)
            end = min(len(content), idx + len(query) + 50)
            snippet = content[start:end].replace("\n", " ")
            results.append(f"{path} ({count} matches): ...{snippet}...")

        return "\n".join(results) if results else "No matches found."

    return "Context type not searchable."


def grep_context(pattern, ctx=None):
    """Regex search across context items. Returns all matching lines."""
    if ctx is None:
        ctx = context  # noqa: F821

    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error as e:
        return f"Invalid regex pattern: {e}"

    results = []

    if isinstance(ctx, str):
        for i, line in enumerate(ctx.split("\n")):
            if regex.search(line):
                results.append(f"Line {i + 1}: {line.strip()}")

    elif isinstance(ctx, list):
        for i, item in enumerate(ctx):
            if isinstance(item, dict):
                path = item.get("path", f"[{i}]")
                content = item.get("content", str(item))
            else:
                path = f"[{i}]"
                content = str(item)

            for j, line in enumerate(content.split("\n")):
                if regex.search(line):
                    results.append(f"{path}:{j + 1}: {line.strip()}")

    return "\n".join(results) if results else "No matches found."


def chunk_context(n=10, ctx=None):
    """Split context into n roughly equal chunks. Returns list of chunks."""
    if ctx is None:
        ctx = context  # noqa: F821

    if isinstance(ctx, str):
        chunk_size = max(1, len(ctx) // n)
        chunks = []
        for i in range(0, len(ctx), chunk_size):
            chunks.append(ctx[i : i + chunk_size])
        return chunks[:n]

    if isinstance(ctx, list):
        if len(ctx) <= n:
            return [[item] for item in ctx]

        chunk_size = max(1, len(ctx) // n)
        chunks = []
        for i in range(0, len(ctx), chunk_size):
            chunks.append(ctx[i : i + chunk_size])

        # Merge overflow into last chunk
        while len(chunks) > n:
            chunks[-2].extend(chunks[-1])
            chunks.pop()

        return chunks

    return [ctx]


def chunk_text(text, size=4000, overlap=200):
    """Split text into chunks of given size with overlap. Returns list of strings."""
    if not isinstance(text, str):
        text = str(text)

    if len(text) <= size:
        return [text]

    chunks = []
    start = 0
    while start < len(text):
        end = start + size
        chunks.append(text[start:end])
        start = end - overlap
        if start >= len(text):
            break

    return chunks


def map_query(items, template, batch_size=10):
    """Apply LLM query to each item using a template with {item} placeholder.

    Uses llm_query_batched for efficiency. Returns list of responses.
    """
    if not items:
        return []

    all_results = []
    for i in range(0, len(items), batch_size):
        batch = items[i : i + batch_size]
        prompts = []
        for item in batch:
            if isinstance(item, dict):
                item_text = item.get("content", str(item))
            else:
                item_text = str(item)
            prompts.append(template.replace("{item}", item_text))

        results = llm_query_batched(prompts)  # noqa: F821 — REPL namespace
        all_results.extend(results)

    return all_results


def reduce_query(results, prompt):
    """Aggregate results into a single answer via LLM query.

    The prompt should contain {results} placeholder for the combined results.
    """
    if isinstance(results, list):
        combined = "\n\n".join(str(r) for r in results)
    else:
        combined = str(results)

    full_prompt = prompt.replace("{results}", combined)
    return llm_query(full_prompt)  # noqa: F821 — REPL namespace


def run_cli(cmd, *args, timeout=10, check=False, input=None):
    """Run a CLI command directly with captured text output.

    Returns a dict: {returncode, stdout, stderr}.

    Timeouts and missing commands map to returncode=-1 with error text in
    stderr. With check=True, a nonzero exit raises CalledProcessError.
    """
    import subprocess

    full_cmd = [cmd, *args]

    try:
        r = subprocess.run(
            full_cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            input=input,
        )
        result = {
            "returncode": r.returncode,
            "stdout": r.stdout,
            "stderr": r.stderr,
        }
        if check and r.returncode != 0:
            raise subprocess.CalledProcessError(
                r.returncode, full_cmd, r.stdout, r.stderr
            )
        return result
    except subprocess.TimeoutExpired as e:
        return {
            "returncode": -1,
            "stdout": "",
            "stderr": f"timeout: {e}",
        }
    except FileNotFoundError as e:
        return {
            "returncode": -1,
            "stdout": "",
            "stderr": f"command not found: {e}",
        }
