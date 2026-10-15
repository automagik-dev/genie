#!/usr/bin/env python3
"""Load Oolong Synth dataset from HuggingFace and output as JSON."""
import json
import sys
from datasets import load_dataset


def main():
    samples = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    idx = int(sys.argv[2]) if len(sys.argv) > 2 else -1

    ds = load_dataset("oolongbench/oolong-synth", split="test")

    if idx >= 0:
        items = [ds[idx]]
    else:
        items = list(ds.select(range(min(samples, len(ds)))))

    output = []
    for item in items:
        # Oolong Synth uses "context_window_text" for the context field
        context = item.get("context_window_text") or item.get("context", "")
        answer = item.get("answer", "")
        # answer can be a list — join if so
        if isinstance(answer, list):
            answer = ", ".join(str(a) for a in answer)
        output.append({
            "id": f"oolong-{item.get('id', 'unknown')}",
            "name": item.get("question", "")[:50],
            "question": item["question"],
            "context": context,
            "expected": answer,
            "category": item.get("task_group", "oolong"),
        })

    json.dump(output, sys.stdout)


if __name__ == "__main__":
    main()
