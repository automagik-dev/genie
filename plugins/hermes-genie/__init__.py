"""Genie native surface for Hermes.

Registers seven read-only tools that bridge Hermes to the Genie CLI through a
safe subprocess layer (argv lists only, mutation always "none"). Hooks, slash
commands, CLI commands, and skills are declared in plugin.yaml and are
implemented by a later group; ``register()`` therefore only requires
``ctx.register_tool``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

try:  # package import (Hermes loads plugins as packages)
    from . import schemas
    from .genie_bridge import payload, resolve_cwd, run_genie, validate_ref
except ImportError:  # flat import (module loaded from a file location)
    import sys

    _HERE = str(Path(__file__).resolve().parent)
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    import schemas  # type: ignore[no-redef]
    from genie_bridge import payload, resolve_cwd, run_genie, validate_ref  # type: ignore[no-redef]


def _json(data: dict[str, Any]) -> str:
    return json.dumps(data, indent=2)


def _validation_error(cwd: str, error: str) -> str:
    """Input-validation early return; source keeps the command|source invariant."""
    return _json(payload(success=False, mutation="none", cwd=cwd, error=error, source="input-validation"))


def _required_ref(args: dict, key: str, kind: str) -> tuple[str | None, str | None]:
    """Return (validated_ref, error) for a required reference — exactly one is non-None."""
    raw = args.get(key)
    if raw is None or not str(raw).strip():
        return None, f"{kind} is required"
    try:
        return validate_ref(raw, kind), None
    except ValueError as exc:
        return None, str(exc)


def _optional_ref(args: dict, key: str, kind: str) -> tuple[str | None, str | None]:
    """Return (validated_ref, error) for an optional reference; absent/empty is (None, None)."""
    raw = args.get(key)
    if raw is None or not str(raw).strip():
        return None, None
    try:
        return validate_ref(raw, kind), None
    except ValueError as exc:
        return None, str(exc)


def _genie_status(args: dict, **kwargs: Any) -> str:
    """genie doctor --json plus a .genie/ presence check for the resolved cwd."""
    cwd = resolve_cwd(args.get("cwd"))
    result = run_genie(["doctor", "--json"], cwd=cwd)
    genie_dir = Path(cwd) / ".genie"
    result["data"] = {
        "doctor": result.get("data"),
        "genie_dir": str(genie_dir),
        "genie_dir_present": genie_dir.is_dir(),
    }
    return _json(result)


def _genie_board(args: dict, **kwargs: Any) -> str:
    """genie board --json, optionally scoped with --wish <slug>."""
    cwd = resolve_cwd(args.get("cwd"))
    wish, err = _optional_ref(args, "wish", "wish")
    if err:
        return _validation_error(cwd, err)
    cmd = ["board", "--json"]
    if wish:
        cmd.extend(["--wish", wish])
    return _json(run_genie(cmd, cwd=cwd))


def _genie_wish_status(args: dict, **kwargs: Any) -> str:
    """Composite: genie board --wish <slug> --json + genie task list --wish <slug> --json."""
    cwd = resolve_cwd(args.get("cwd"))
    slug, err = _required_ref(args, "slug", "slug")
    if err:
        return _validation_error(cwd, err)
    board = run_genie(["board", "--wish", slug, "--json"], cwd=cwd)
    tasks = run_genie(["task", "list", "--wish", slug, "--json"], cwd=cwd)
    return _json(
        payload(
            success=bool(board["success"]) and bool(tasks["success"]),
            mutation="none",
            cwd=cwd,
            command=[board.get("command"), tasks.get("command")],
            data={"board": board, "tasks": tasks},
        )
    )


def _genie_task_list(args: dict, **kwargs: Any) -> str:
    """genie task list --json with optional --wish and --status filters."""
    cwd = resolve_cwd(args.get("cwd"))
    wish, err = _optional_ref(args, "wish", "wish")
    if err:
        return _validation_error(cwd, err)
    status, err = _optional_ref(args, "status", "status")
    if err:
        return _validation_error(cwd, err)
    cmd = ["task", "list", "--json"]
    if wish:
        cmd.extend(["--wish", wish])
    if status:
        cmd.extend(["--status", status])
    return _json(run_genie(cmd, cwd=cwd))


def _genie_task_status(args: dict, **kwargs: Any) -> str:
    """genie task status <id> — raw text capture."""
    cwd = resolve_cwd(args.get("cwd"))
    task_id, err = _required_ref(args, "id", "id")
    if err:
        return _validation_error(cwd, err)
    return _json(run_genie(["task", "status", task_id], cwd=cwd))


def _genie_work_plan(args: dict, **kwargs: Any) -> str:
    """genie launch <slug> --dry-run, optionally with --groups <csv>. Raw YAML-ish capture."""
    cwd = resolve_cwd(args.get("cwd"))
    slug, err = _required_ref(args, "slug", "slug")
    if err:
        return _validation_error(cwd, err)
    cmd = ["launch", slug, "--dry-run"]
    groups = args.get("groups")
    if groups:
        raw_items = [groups] if isinstance(groups, str) else list(groups)
        try:
            items = [validate_ref(g, "groups") for g in raw_items]  # per-item safety before the comma join
        except ValueError as exc:
            return _validation_error(cwd, str(exc))
        cmd.extend(["--groups", ",".join(items)])
    return _json(run_genie(cmd, cwd=cwd))


def _extract_section(text: str, heading: str) -> str | None:
    """Extract the body of a ``## <heading>`` section, up to the next h1/h2 heading."""
    body: list[str] = []
    capturing = False
    found = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            title = stripped.lstrip("#").strip()
            if capturing and level <= 2:
                break
            if not capturing and level == 2 and title.lower() == heading.lower():
                capturing = True
                found = True
                continue
        if capturing:
            body.append(line)
    if not found:
        return None
    return "\n".join(body).strip()


def _genie_review_plan(args: dict, **kwargs: Any) -> str:
    """Composite wish status plus Success/QA criteria read from .genie/wishes/<slug>/WISH.md."""
    cwd = resolve_cwd(args.get("cwd"))
    slug, err = _required_ref(args, "slug", "slug")
    if err:
        return _validation_error(cwd, err)
    board = run_genie(["board", "--wish", slug, "--json"], cwd=cwd)
    tasks = run_genie(["task", "list", "--wish", slug, "--json"], cwd=cwd)
    wishes_root = (Path(cwd) / ".genie" / "wishes").resolve()
    wish_file = wishes_root / slug / "WISH.md"
    resolved_wish = wish_file.resolve()
    criteria: dict[str, Any] = {"success_criteria": None, "qa_criteria": None}
    file_error: str | None = None
    if not resolved_wish.is_relative_to(wishes_root):
        # Defense in depth: validate_ref blocks traversal slugs, so only a
        # symlink under .genie/wishes could point outside — refuse to follow it.
        file_error = f"wish file path escapes {wishes_root}; refusing to read {resolved_wish}"
    elif resolved_wish.is_file():
        try:
            text = resolved_wish.read_text(encoding="utf-8")
        except OSError as exc:
            file_error = f"failed to read {wish_file}: {exc}"
        else:
            criteria["success_criteria"] = _extract_section(text, "Success Criteria")
            criteria["qa_criteria"] = _extract_section(text, "QA Criteria")
            if criteria["success_criteria"] is None and criteria["qa_criteria"] is None:
                file_error = f"no '## Success Criteria' or '## QA Criteria' section in {wish_file}"
    else:
        file_error = f"wish file not found: {wish_file}"
    return _json(
        payload(
            success=bool(board["success"]) and bool(tasks["success"]),
            mutation="none",
            cwd=cwd,
            command=[board.get("command"), tasks.get("command")],
            data={"board": board, "tasks": tasks, "criteria": criteria},
            error=file_error,
            source=str(wish_file),
        )
    )


def register(ctx) -> None:
    """Register Genie's native Hermes tool surface.

    Only ``ctx.register_tool`` is required here — commands, hooks, and skills
    are declared in plugin.yaml and registered by a later execution group.
    """
    tool_defs: list[tuple[dict[str, Any], Any, str]] = [
        (schemas.GENIE_STATUS_SCHEMA, _genie_status, "🧞"),
        (schemas.GENIE_BOARD_SCHEMA, _genie_board, "📋"),
        (schemas.GENIE_WISH_STATUS_SCHEMA, _genie_wish_status, "🌠"),
        (schemas.GENIE_TASK_LIST_SCHEMA, _genie_task_list, "🧩"),
        (schemas.GENIE_TASK_STATUS_SCHEMA, _genie_task_status, "📌"),
        (schemas.GENIE_WORK_PLAN_SCHEMA, _genie_work_plan, "🛠️"),
        (schemas.GENIE_REVIEW_PLAN_SCHEMA, _genie_review_plan, "🔎"),
    ]
    for schema, handler, emoji in tool_defs:
        ctx.register_tool(
            name=schema["name"],
            toolset="genie",
            schema=schema,
            handler=handler,
            description=schema["description"],
            emoji=emoji,
        )
