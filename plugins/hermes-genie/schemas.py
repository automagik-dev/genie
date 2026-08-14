"""JSON schemas for the Hermes Genie tool surface (all tools are read-only)."""

from __future__ import annotations

from typing import Any

CWD_PROP: dict[str, Any] = {
    "type": "string",
    "description": "Repository/workspace path. Defaults to the current working directory.",
}
SLUG_PROP: dict[str, Any] = {"type": "string", "description": "Genie wish slug."}
WISH_PROP: dict[str, Any] = {"type": "string", "description": "Wish slug filter."}
STATUS_PROP: dict[str, Any] = {
    "type": "string",
    "enum": ["blocked", "ready", "in_progress", "done"],
    "description": "Task status filter.",
}
GROUP_PROP: dict[str, Any] = {
    "type": "string",
    "description": "Execution group name to include in the plan.",
}
ID_PROP: dict[str, Any] = {"type": "string", "description": "Genie task id (e.g. t_abc123)."}

GENIE_STATUS_SCHEMA: dict[str, Any] = {
    "name": "genie_status",
    "description": (
        "Return Genie installation health (genie doctor --json) plus a .genie/ presence check "
        "for the workspace. Read-only."
    ),
    "parameters": {"type": "object", "properties": {"cwd": CWD_PROP}},
}

GENIE_BOARD_SCHEMA: dict[str, Any] = {
    "name": "genie_board",
    "description": "Return the Genie planning board (genie board --json), optionally scoped to one wish. Read-only.",
    "parameters": {"type": "object", "properties": {"cwd": CWD_PROP, "wish": WISH_PROP}},
}

GENIE_WISH_STATUS_SCHEMA: dict[str, Any] = {
    "name": "genie_wish_status",
    "description": "Return composite wish status: board slice plus task list for one wish slug. Read-only.",
    "parameters": {
        "type": "object",
        "properties": {"cwd": CWD_PROP, "slug": SLUG_PROP},
        "required": ["slug"],
    },
}

GENIE_TASK_LIST_SCHEMA: dict[str, Any] = {
    "name": "genie_task_list",
    "description": (
        "List Genie tasks (genie task list --json), optionally filtered by wish slug and/or "
        "status (blocked|ready|in_progress|done). Read-only."
    ),
    "parameters": {
        "type": "object",
        "properties": {"cwd": CWD_PROP, "wish": WISH_PROP, "status": STATUS_PROP},
    },
}

GENIE_TASK_STATUS_SCHEMA: dict[str, Any] = {
    "name": "genie_task_status",
    "description": (
        "Show one Genie task's detail, dependencies, and stage log (genie task status <id>, "
        "raw text capture). Read-only."
    ),
    "parameters": {
        "type": "object",
        "properties": {"cwd": CWD_PROP, "id": ID_PROP},
        "required": ["id"],
    },
}

GENIE_WORK_PLAN_SCHEMA: dict[str, Any] = {
    "name": "genie_work_plan",
    "description": (
        "Preview the spawn plan for a wish (genie context --wish <slug> --plan), optionally "
        "limited to one group. Output is versioned JSON captured raw. Read-only plan."
    ),
    "parameters": {
        "type": "object",
        "properties": {"cwd": CWD_PROP, "slug": SLUG_PROP, "group": GROUP_PROP},
        "required": ["slug"],
    },
}

GENIE_REVIEW_PLAN_SCHEMA: dict[str, Any] = {
    "name": "genie_review_plan",
    "description": (
        "Return review inputs for a wish: composite board/task status plus the Success Criteria "
        "and QA Criteria sections extracted from .genie/wishes/<slug>/WISH.md. Read-only."
    ),
    "parameters": {
        "type": "object",
        "properties": {"cwd": CWD_PROP, "slug": SLUG_PROP},
        "required": ["slug"],
    },
}
