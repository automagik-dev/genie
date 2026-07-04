"""Safe subprocess bridge between Hermes tools and the Genie CLI.

Read-only by contract: every helper defaults to mutation="none" and executes
argv lists only — never a shell string, never a shell interpreter.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

_UNSAFE_TOKENS = (";", "&&", "||", "`", "$(", "\n", "\r")
_REF_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def build_genie_argv(args: list[str]) -> list[str]:
    """Build a ``genie`` argv list, rejecting shell metacharacters per argument."""
    clean: list[str] = []
    for arg in args:
        text = str(arg)
        if any(token in text for token in _UNSAFE_TOKENS):
            raise ValueError(f"unsafe genie argument: {text!r}")
        clean.append(text)
    return ["genie", *clean]


def validate_ref(value: Any, kind: str) -> str:
    """Validate a slug/wish/id-style reference before argv or path construction.

    Accepts only ``[A-Za-z0-9][A-Za-z0-9._-]*`` — no leading dash (option
    injection), no path separators, no ``..`` (traversal). Raises ValueError
    with a clear message naming the invalid reference.
    """
    text = str(value).strip() if value is not None else ""
    if not text or ".." in text or not _REF_PATTERN.fullmatch(text):
        raise ValueError(f"invalid {kind} reference: {text!r} (allowed: [A-Za-z0-9][A-Za-z0-9._-]*, no '..')")
    return text


def resolve_cwd(cwd: str | None) -> str:
    """Resolve a working directory, defaulting to the current one."""
    return str(Path(cwd or os.getcwd()).expanduser().resolve())


def payload(
    *,
    success: bool,
    mutation: str,
    cwd: str,
    command: list[Any] | None = None,
    data: Any = None,
    error: str | None = None,
    source: str | None = None,
) -> dict[str, Any]:
    """Uniform tool payload envelope shared by every Hermes Genie tool."""
    result: dict[str, Any] = {"success": success, "mutation": mutation, "cwd": cwd}
    if command is not None:
        result["command"] = command
    if data is not None:
        result["data"] = data
    if error:
        result["error"] = error
    if source:
        result["source"] = source
    return result


def run_genie(
    args: list[str],
    *,
    cwd: str | None = None,
    timeout_seconds: float = 30,
    mutation: str = "none",
) -> dict[str, Any]:
    """Run one ``genie`` subcommand safely and capture its output.

    stdout that starts with ``{`` or ``[`` is json.loads-ed (``"parsed": True``);
    anything else falls back to raw ``{"stdout", "stderr", "returncode"}`` capture
    (``"parsed": False``).
    """
    workdir = resolve_cwd(cwd)
    try:
        argv = build_genie_argv(args)
        proc = subprocess.run(
            argv,
            cwd=workdir,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except Exception as exc:  # noqa: BLE001 — every failure becomes an error payload
        result = payload(
            success=False,
            mutation=mutation,
            cwd=workdir,
            command=["genie", *[str(a) for a in args]],
            error=str(exc) or exc.__class__.__name__,
        )
        result["parsed"] = False
        return result

    parsed = False
    data: Any = None
    stripped = proc.stdout.strip()
    if stripped.startswith(("{", "[")):
        try:
            data = json.loads(stripped)
            parsed = True
        except ValueError:
            parsed = False
    if not parsed:
        data = {"stdout": proc.stdout, "stderr": proc.stderr, "returncode": proc.returncode}
    error: str | None = None
    if proc.returncode != 0:
        error = proc.stderr.strip() or f"genie exited with code {proc.returncode}"
    result = payload(
        success=proc.returncode == 0,
        mutation=mutation,
        cwd=workdir,
        command=argv,
        data=data,
        error=error,
    )
    result["parsed"] = parsed
    return result
