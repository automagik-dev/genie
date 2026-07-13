"""Advisory hooks nudging Hermes sessions toward structured Genie state.

Every handler is advisory-only: it may attach a message, advice, or bounded
read-only context, never a blocking directive, and always reports mutation
"none" (or ``None`` for no injection). Events are accepted as mappings or
attribute objects; a missing event degrades to a no-op.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

try:  # package import (Hermes loads plugins as packages)
    from .session_context import pre_llm_call
except ImportError:  # flat import (module loaded from a file location)
    import sys

    _HERE = str(Path(__file__).resolve().parent)
    if _HERE not in sys.path:
        sys.path.insert(0, _HERE)
    from session_context import pre_llm_call  # type: ignore[no-redef]

__all__ = ["on_session_start", "pre_tool_call", "pre_llm_call"]

_SESSION_REMINDER = (
    "Genie state detected in this workspace. Prefer the structured Genie tools "
    "(genie_status, genie_board, genie_task_list) over terminal scraping."
)
_STRUCTURED_ADVICE = (
    "This command looks like terminal scraping or sleep-polling of Genie workers. "
    "Prefer the structured Genie tools (genie_status, genie_board, genie_task_list, "
    "genie_wish_status) — they return the same truth with provenance."
)


def _event_value(event: Any, key: str) -> Any:
    """Read one field from a hook event that may be a mapping or an object."""
    if event is None:
        return None
    if isinstance(event, dict):
        return event.get(key)
    return getattr(event, key, None)


def on_session_start(event: Any = None, **kwargs: Any) -> dict[str, Any]:
    """Remind sessions that start inside a Genie workspace to use structured tools."""
    try:
        cwd = Path(str(_event_value(event, "cwd") or ".")).expanduser()
        if (cwd / ".genie").is_dir():
            return {"message": _SESSION_REMINDER, "mutation": "none"}
    except (RuntimeError, OSError, ValueError):
        pass  # unresolvable cwd (e.g. bad ~user) degrades to the no-op contract
    return {"mutation": "none"}


def pre_tool_call(event: Any = None, **kwargs: Any) -> dict[str, Any]:
    """Advise (never block) when a tool call looks like scraping or polling Genie."""
    raw = _event_value(event, "command") or _event_value(event, "args") or ""
    if isinstance(raw, (list, tuple)):
        text = " ".join(str(part) for part in raw)
    else:
        text = str(raw)
    if "tmux capture-pane" in text or ("sleep " in text and "genie" in text):
        return {"advice": _STRUCTURED_ADVICE, "mutation": "none"}
    return {"mutation": "none"}
