#!/usr/bin/env python3
"""
verify-recipe-blocks.py — execute a recipe's own ```repl blocks and measure them.

    python3 optimizer/verify-recipe-blocks.py [--recipe optimizer/gens/gen-4/recipe]

Every generation of this loop has claimed a "verification done before shipping the
mutation" section, and `EVOLUTION.md`'s *Corrections* records that none of those
measurements could be recomputed from the tree: the replay harness was never
committed and `runs/task-*.json` stores no REPL stdout. This script is the fix,
and it is deliberately small. It does three things and nothing else:

  1. **Syntax-checks every ```repl block** in the recipe's `SYSTEM.md`. A block
     that does not compile is a block the agent copies out and loses a turn on.
     Template blocks contain placeholders like `"<path>"` and are *not* executed;
     they must still parse.
  2. **Executes the phase-1 starter block** at each live training root, and
     asserts every helper name the later phases call is bound.
  3. **Runs the declaration sweep** over a named file set at each root and prints
     the candidate count and the printed size in characters — the numbers the
     gen-4 entry of `EVOLUTION.md` quotes, against the 20,000-char REPL
     truncation the recipe warns about.

It reads the recipe and the checkouts. It writes nothing, spawns no model, costs
nothing, and touches no scorer.
"""
import argparse
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROUND2 = os.path.dirname(HERE)

# The files the six fitness tasks + two holdout tasks actually anchor facts in,
# per each task's `- [ ] **F<n>** (exact|re-anchored) \`path:line\`` rows. This is
# the set a run of those tasks has open, so it is the set the sweep is sized on.
TARGETS = {
    "/home/namastex/prod/xdna-top": [
        "src/xdna_top/record.py",
        "src/xdna_top/npu_power.py",
        "src/xdna_top/discover_sysfs.py",
        "src/xdna_top/gauge.py",
        "src/xdna_top/snapshot.py",
    ],
    "/home/namastex/prod/genie-desktop": [
        "src/main/services/ptyManager.ts",
        "src/main/services/RtkService.ts",
    ],
    "/home/namastex/prod/fde-station": [
        "channel/enroll.sh",
    ],
    "/home/namastex/prod/rlmx": [
        "src/khal-provider.ts",
        "src/llm.ts",
        "src/rlm.ts",
        "src/cli.ts",
    ],
}

# Anchors of the declaration-class misses this recipe line has been losing, as
# recorded in EVOLUTION.md and holdout/README.md. Checked, not assumed.
DECLARATION_MISSES = [
    ("/home/namastex/prod/xdna-top/src/xdna_top/record.py", 22, "RECORD_SCHEMA_VERSION"),
    ("/home/namastex/prod/xdna-top/src/xdna_top/record.py", 23, "RECORD_KIND"),
    ("/home/namastex/prod/genie-desktop/src/main/services/ptyManager.ts", 38, "new Map"),
    ("/home/namastex/prod/genie-desktop/src/main/services/ptyManager.ts", 127, "RESERVED_ENV_KEYS"),
    ("/home/namastex/prod/fde-station/channel/enroll.sh", 23, "SUITE"),
    ("/home/namastex/prod/rlmx/src/khal-provider.ts", 103, "NON_CHAT_MODES"),
]

# Misses that are NOT declaration-class and are therefore out of this change's
# scope. Listed so the boundary is stated rather than discovered later.
OUT_OF_CLASS = [
    ("/home/namastex/prod/xdna-top/src/xdna_top/npu_power.py", 84, "a predicate inside a parser"),
    ("/home/namastex/prod/xdna-top/src/xdna_top/discover_sysfs.py", 18, "a key in a function-local literal"),
]

BLOCK_RE = re.compile(r"```repl\n(.*?)\n```", re.S)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--recipe", default=os.path.join(HERE, "gens", "gen-4", "recipe"))
    ap.add_argument("--limit", type=int, default=25, help="decls() per-file cap, as shipped")
    args = ap.parse_args()

    system_md = os.path.join(os.path.abspath(args.recipe), "SYSTEM.md")
    src = open(system_md, encoding="utf-8").read()
    blocks = BLOCK_RE.findall(src)
    print(f"# recipe {system_md}")
    print(f"# {len(blocks)} ```repl blocks\n")

    # ── 1. every block must at least compile ────────────────────────────────
    bad = 0
    for i, b in enumerate(blocks, 1):
        try:
            compile(b, f"<repl block {i}>", "exec")
            print(f"BLOCK {i} parses  ({len(b)} chars)")
        except SyntaxError as e:
            bad += 1
            print(f"BLOCK {i} SYNTAX ERROR line {e.lineno}: {e.msg}")
    if bad:
        print(f"\n{bad} block(s) do not parse")
        return 1

    # ── 2. the starter block, executed for real ─────────────────────────────
    starter = next((b for b in blocks if "def decls(" in b), None)
    if starter is None:
        print("\nno starter block defining decls() — nothing to measure")
        return 1
    ns: dict = {}
    exec(starter.rsplit("look()", 1)[0], ns)  # `look()` prints a tree; skip it
    want = ["walk", "look", "search", "read", "defs", "decls", "decl_name", "usable"]
    missing = [n for n in want if n not in ns]
    print(f"\nSTARTER binds {', '.join(n for n in want if n in ns)}")
    if missing:
        print(f"STARTER MISSING {', '.join(missing)}")
        return 1
    decls, decl_name = ns["decls"], ns["decl_name"]

    # ── 3. the sweep, measured at every live root ───────────────────────────
    print()
    grand_n = grand_chars = 0
    for root, files in TARGETS.items():
        if not os.path.isdir(root):
            print(f"ROOT {root} absent — skipped")
            continue
        n = chars = 0
        for f in files:
            p = os.path.join(root, f)
            if not os.path.exists(p):
                print(f"  {f}: MISSING")
                continue
            cand = decls(p, limit=args.limit)
            printed = "".join(f"[{i}] {a}:{b}: {c}\n" for i, (a, b, c) in enumerate(cand, 1))
            n += len(cand)
            chars += len(printed)
            print(f"  {f:46s} {len(cand):3d} candidates  {len(printed):5d} chars")
        print(f"ROOT {root}: {n} candidates, {chars} chars")
        grand_n += n
        grand_chars += chars
    print(f"\nSWEEP TOTAL {grand_n} candidates, {grand_chars} chars over all roots")
    print(f"  worst single root: see above; REPL truncation is 20,000 chars per block")

    # ── 4. does the sweep surface the declaration-class misses? ─────────────
    print("\nDECLARATION-CLASS MISSES (the residual this change targets)")
    hits = 0
    for path, line, term in DECLARATION_MISSES:
        if not os.path.exists(path):
            print(f"  {os.path.basename(path)}:{line} {term}: FILE MISSING")
            continue
        got = {ln for _, ln, _ in decls(path, limit=200)}
        ok = line in got
        hits += ok
        text = next((t for _, ln, t in decls(path, limit=200) if ln == line), "")
        name = decl_name(text) if text else ""
        print(f"  {'SURFACED' if ok else 'not seen':9s} {os.path.basename(path)}:{line}"
              f"  term={term!r}  decl_name={name!r}")
    print(f"  {hits}/{len(DECLARATION_MISSES)} surfaced by the sweep")

    print("\nOUT OF CLASS (stated, not targeted — a module-level sweep cannot see these)")
    for path, line, why in OUT_OF_CLASS:
        got = {ln for _, ln, _ in decls(path, limit=200)} if os.path.exists(path) else set()
        print(f"  {'SURFACED' if line in got else 'not seen':9s} {os.path.basename(path)}:{line} — {why}")

    # ── 5. the verify loop, with a seeded OK / TERM / DROP ──────────────────
    print("\nVERIFY LOOP on a seeded EXTRA (one OK, one drifted TERM, one missing DROP)")
    seeded = [
        ("a real declaration", "/home/namastex/prod/xdna-top/src/xdna_top/record.py", 22, "RECORD_SCHEMA_VERSION"),
        ("a drifted line", "/home/namastex/prod/xdna-top/src/xdna_top/record.py", 40, "RECORD_SCHEMA_VERSION"),
        ("a missing file", "/home/namastex/prod/xdna-top/does/not/exist.py", 1, "ANY"),
    ]
    keep = []
    for c, p, n_, t in seeded:
        try:
            line = open(p, errors="replace").read().split("\n")[n_ - 1]
        except Exception as e:
            print(f"  DROP {os.path.basename(p)}:{n_}: {type(e).__name__}")
            continue
        if t and t in line:
            print(f"  OK   {os.path.basename(p)}:{n_}: {line.strip()[:60]}")
            keep.append((c, p, n_, t))
        else:
            print(f"  TERM {os.path.basename(p)}:{n_}: {line.strip()[:60]}  ⟵ {t!r} not on this line")
    print(f"  KEEP holds {len(keep)} of {len(seeded)} — expected 1")
    return 0 if len(keep) == 1 and hits == len(DECLARATION_MISSES) else 1


if __name__ == "__main__":
    sys.exit(main())
