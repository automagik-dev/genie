"""Slash-command and CLI dispatch surface for the Hermes Genie plugin.

Pure formatting and dispatch: parses operator argument strings, calls the
read-only tool handlers defined in the plugin module, and renders their JSON
payloads as short, outcome-first human-readable text (outcome line first,
then key facts, then the evidence command argv on one line). No subprocess
or filesystem work happens here.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable

try:  # package import (Hermes loads plugins as packages)
    from . import (  # type: ignore[attr-defined]
        _genie_board,
        _genie_review_plan,
        _genie_status,
        _genie_wish_status,
        _genie_work_plan,
    )
except ImportError:  # flat import (module loaded from a file location)
    _HERE = str(Path(__file__).resolve().parent)
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    from __init__ import (  # type: ignore[no-redef] # the plugin module doubles as a flat __init__ module
        _genie_board,
        _genie_review_plan,
        _genie_status,
        _genie_wish_status,
        _genie_work_plan,
    )

_Runner = Callable[[list[str], dict[str, Any]], str]

_HELP = """\
Genie — read-only Hermes surface for the Genie CLI (mutation: none).

Subcommands:
  /genie status                     Genie doctor summary plus .genie presence
  /genie board [wish]               Task board, optionally scoped to one wish
  /genie wish <slug>                Wish status: board plus task list
  /genie work-plan <slug> [groups]  Dry-run launch plan; never executes work
  /genie review-plan <slug>         Wish status plus acceptance criteria
  /genie help                       This help

Aliases: /genie-board, /genie-wish, /genie-work-plan, /genie-review-plan.
Mutations (spawn, launch, task done) stay human-gated outside this surface."""


def _payload_of(raw: str) -> dict[str, Any]:
    """Parse a tool handler's JSON payload, degrading to an error payload."""
    try:
        data = json.loads(raw)
    except ValueError:
        return {"success": False, "error": f"unparseable tool payload: {raw[:120]!r}"}
    if not isinstance(data, dict):
        return {"success": False, "error": "unexpected tool payload shape (expected an object)"}
    return data


def _command_line(command: Any) -> str:
    """Flatten a payload's command argv (or list of argvs) onto one line."""
    if command is None:
        return "n/a"
    if isinstance(command, (list, tuple)):
        items = [item for item in command if item is not None]
        if not items:
            return "n/a"
        if all(isinstance(item, (list, tuple)) for item in items):
            return " && ".join(" ".join(str(part) for part in item) for item in items)
        return " ".join(str(part) for part in items)
    return str(command)


def _data_summary(payload: dict[str, Any]) -> str | None:
    """One short fact line describing the payload's data, if any."""
    data = payload.get("data")
    if isinstance(data, list):
        return f"items: {len(data)}"
    if isinstance(data, dict):
        if "stdout" in data and "returncode" in data:
            text = str(data.get("stdout") or "").strip()
            if not text:
                return "output: (empty)"
            first, *rest = text.splitlines()
            suffix = f" (+{len(rest)} more lines)" if rest else ""
            return f"output: {first.strip()}{suffix}"
        return f"fields: {', '.join(sorted(data)[:6])}"
    return None


def _leg_fact(name: str, leg: Any) -> str:
    """Summarize one leg (board/tasks) of a composite payload."""
    if not isinstance(leg, dict):
        return f"{name}: unavailable"
    if not leg.get("success"):
        return f"{name}: error — {leg.get('error') or 'unknown'}"
    inner = leg.get("data")
    if isinstance(inner, list):
        return f"{name}: {len(inner)} item(s)"
    return f"{name}: ok"


def _render(title: str, payload: dict[str, Any], facts: list[str | None]) -> str:
    """Outcome-first rendering: outcome line, key facts, evidence argv line."""
    error = str(payload.get("error") or "").strip()
    if payload.get("success") and not error:
        head = f"OK — {title}"
    elif payload.get("success"):
        head = f"OK (with warning) — {title}: {error}"
    else:
        head = f"Error — {title}: {error or 'unknown error'}"
    lines = [head]
    lines.extend(fact for fact in facts if fact)
    cwd = payload.get("cwd")
    if cwd:
        lines.append(f"cwd: {cwd}")
    lines.append(f"evidence: {_command_line(payload.get('command'))}")
    return "\n".join(lines)


def _usage(usage: str) -> str:
    return f"Error — missing required argument. Usage: {usage}. See /genie help."


def _run_status(rest: list[str], base: dict[str, Any]) -> str:
    payload = _payload_of(_genie_status(dict(base)))
    data = payload.get("data")
    fact: str | None = None
    if isinstance(data, dict) and "genie_dir_present" in data:
        state = "present" if data.get("genie_dir_present") else "absent"
        fact = f".genie directory: {state} ({data.get('genie_dir')})"
    return _render("genie status", payload, [fact])


def _run_board(rest: list[str], base: dict[str, Any]) -> str:
    args = dict(base)
    title = "genie board"
    if rest:
        args["wish"] = rest[0]
        title = f"genie board (wish {rest[0]})"
    payload = _payload_of(_genie_board(args))
    return _render(title, payload, [_data_summary(payload)])


def _run_wish(rest: list[str], base: dict[str, Any]) -> str:
    if not rest:
        return _usage("/genie wish <slug>")
    slug = rest[0]
    args = dict(base)
    args["slug"] = slug
    payload = _payload_of(_genie_wish_status(args))
    data = payload.get("data")
    facts: list[str | None] = []
    if isinstance(data, dict):
        facts = [_leg_fact("board", data.get("board")), _leg_fact("tasks", data.get("tasks"))]
    return _render(f"genie wish {slug}", payload, facts)


def _run_work_plan(rest: list[str], base: dict[str, Any]) -> str:
    if not rest:
        return _usage("/genie work-plan <slug> [groups]")
    slug = rest[0]
    args = dict(base)
    args["slug"] = slug
    tail = rest[1:]
    if tail and tail[0] == "--groups":
        tail = tail[1:]
    if tail:
        groups = [group for group in tail[0].split(",") if group]
        if groups:
            args["groups"] = groups
    payload = _payload_of(_genie_work_plan(args))
    return _render(f"genie work-plan {slug}", payload, ["mode: dry-run (nothing executed)", _data_summary(payload)])


def _run_review_plan(rest: list[str], base: dict[str, Any]) -> str:
    if not rest:
        return _usage("/genie review-plan <slug>")
    slug = rest[0]
    args = dict(base)
    args["slug"] = slug
    payload = _payload_of(_genie_review_plan(args))
    data = payload.get("data")
    facts: list[str | None] = []
    if isinstance(data, dict):
        criteria = data.get("criteria") if isinstance(data.get("criteria"), dict) else {}
        success = "found" if criteria.get("success_criteria") else "missing"
        qa = "found" if criteria.get("qa_criteria") else "missing"
        facts = [
            f"success criteria: {success}; qa criteria: {qa}",
            _leg_fact("board", data.get("board")),
            _leg_fact("tasks", data.get("tasks")),
        ]
    return _render(f"genie review-plan {slug}", payload, facts)


_RUNNERS: dict[str, _Runner] = {
    "status": _run_status,
    "board": _run_board,
    "wish": _run_wish,
    "work-plan": _run_work_plan,
    "review-plan": _run_review_plan,
}


def _base_args(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Pass a Hermes-provided cwd through to the tool handlers when present."""
    cwd = kwargs.get("cwd")
    return {"cwd": str(cwd)} if cwd else {}


def slash_genie(args_text: str = "", **kwargs: Any) -> str:
    """Dispatch /genie <subcommand> to the matching read-only tool handler."""
    tokens = str(args_text or "").split()
    if not tokens or tokens[0].lower() in {"help", "--help", "-h"}:
        return _HELP
    sub = tokens[0].lower()
    runner = _RUNNERS.get(sub)
    if runner is None:
        return f"Unknown /genie subcommand: {sub!r}. See /genie help for the available subcommands."
    return runner(tokens[1:], _base_args(kwargs))


def slash_genie_board(args_text: str = "", **kwargs: Any) -> str:
    """Thin wrapper: /genie-board [wish]."""
    return slash_genie(f"board {args_text or ''}".strip(), **kwargs)


def slash_genie_wish(args_text: str = "", **kwargs: Any) -> str:
    """Thin wrapper: /genie-wish <slug>."""
    return slash_genie(f"wish {args_text or ''}".strip(), **kwargs)


def slash_genie_work_plan(args_text: str = "", **kwargs: Any) -> str:
    """Thin wrapper: /genie-work-plan <slug> [groups]."""
    return slash_genie(f"work-plan {args_text or ''}".strip(), **kwargs)


def slash_genie_review_plan(args_text: str = "", **kwargs: Any) -> str:
    """Thin wrapper: /genie-review-plan <slug>."""
    return slash_genie(f"review-plan {args_text or ''}".strip(), **kwargs)


def cli_handler(args: argparse.Namespace) -> None:
    """Route a parsed ``hermes genie ...`` invocation through the dispatcher."""
    sub = getattr(args, "genie_command", None) or "help"
    parts: list[str] = [str(sub)]
    for attr in ("slug", "wish", "groups"):
        value = getattr(args, attr, None)
        if value:
            parts.append(str(value))
    sys.stdout.write(slash_genie(" ".join(parts)) + "\n")


def setup_cli(subparser: argparse.ArgumentParser) -> None:
    """Attach the ``genie`` subcommand tree to the Hermes CLI parser."""
    sub = subparser.add_subparsers(dest="genie_command")
    sub.add_parser("status", help="Show Genie doctor summary and .genie presence")
    board = sub.add_parser("board", help="Show the Genie task board")
    board.add_argument("wish", nargs="?", default="", help="Optional wish slug filter")
    wish = sub.add_parser("wish", help="Show wish status (board plus tasks)")
    wish.add_argument("slug", help="Wish slug")
    work = sub.add_parser("work-plan", help="Show a dry-run launch plan (no execution)")
    work.add_argument("slug", help="Wish slug")
    work.add_argument("groups", nargs="?", default="", help="Optional comma-separated group filter")
    review = sub.add_parser("review-plan", help="Show wish status plus acceptance criteria")
    review.add_argument("slug", help="Wish slug")
    subparser.set_defaults(func=cli_handler)
