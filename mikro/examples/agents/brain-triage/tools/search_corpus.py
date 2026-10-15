#!/usr/bin/env python3
"""
tools/search_corpus.py — example Python tool plugin.

Demonstrates the SDK's stdio-JSON protocol:

    stdin:  args JSON
    stdout: result JSON
    stderr: diagnostic (captured, never parsed)

The fake corpus is embedded below so this example is completely
self-contained — no external downloads, no vault to mount. Replace
CORPUS with a real BM25 / pg_search hit list when you adapt this
pattern for a real agent.
"""
from __future__ import annotations

import json
import re
import sys
from typing import Any


CORPUS: list[dict[str, Any]] = [
    {
        "id": "case-001",
        "title": "Divórcio Carol",
        "text": "audiência 14h Carol divórcio consensual 2026",
    },
    {
        "id": "case-002",
        "title": "ITCMD Reginaldo",
        "text": "ITCMD valor mínimo doação Reginaldo inventário",
    },
    {
        "id": "client-042",
        "title": "Jhenifer — contrato",
        "text": "contrato de prestação Jhenifer 2026-04 assinatura",
    },
]


def _score(query: str, doc: dict[str, Any]) -> int:
    """Naive token-overlap score — one point per query token that
    appears in the title or text. Deterministic, no dependencies."""
    q_tokens = {t for t in re.split(r"\W+", query.lower()) if t}
    doc_tokens = set(
        re.split(r"\W+", (doc.get("title", "") + " " + doc.get("text", "")).lower())
    )
    return len(q_tokens & doc_tokens)


def search(query: str, limit: int = 3) -> list[dict[str, Any]]:
    scored = sorted(
        ((doc, _score(query, doc)) for doc in CORPUS),
        key=lambda pair: pair[1],
        reverse=True,
    )
    return [
        {
            "id": doc["id"],
            "title": doc["title"],
            "score": score,
            "snippet": doc["text"][:160],
        }
        for doc, score in scored
        if score > 0
    ][:limit]


def main() -> None:
    args = json.load(sys.stdin)
    query = args.get("query", "")
    limit = args.get("limit", 3)

    if not isinstance(query, str) or not query.strip():
        # Surface a diagnostic to stderr — the SDK captures it for
        # the ToolCallAfter event, so the agent sees the reason
        # without the run aborting.
        sys.stderr.write("search_corpus: empty query\n")
        json.dump({"hits": [], "reason": "empty query"}, sys.stdout)
        return

    hits = search(query.strip(), int(limit))
    json.dump({"query": query, "hits": hits}, sys.stdout)


if __name__ == "__main__":
    main()
