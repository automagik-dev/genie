"""Unit tests for the bounded, read-only pre_llm_call session context.

Every board read is mocked at the ``run_genie`` seam so these tests never
depend on an installed ``genie`` binary. The invariants under test:

- ≤ 8 wish/task lines AND ≤ 2 KiB of injected text (hard caps)
- no ``.genie/`` directory → no injection (return None), no subprocess run
- subprocess timeout → no injection, and the timeout is bounded ≤ 5 s
- any subprocess failure → no injection (failure silence)
- happy path returns ``{"context": ..., "mutation": "none"}`` and nothing else
"""

from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
PLUGIN = ROOT / "plugins" / "hermes-genie"


def load_module():
    spec = importlib.util.spec_from_file_location("hermes_genie_session_context", PLUGIN / "session_context.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def board_payload(columns: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    """Shape a successful ``genie board --json`` result from run_genie."""
    base = {"blocked": [], "ready": [], "in_progress": [], "done": []}
    base.update(columns)
    return {
        "success": True,
        "mutation": "none",
        "cwd": "/x",
        "command": ["genie", "board", "--json"],
        "data": {"scope": "all tasks", "columns": base},
        "parsed": True,
    }


def _task_lines(context: str) -> list[str]:
    return [line for line in context.splitlines() if line.startswith("- ")]


def test_line_cap_enforced(tmp_path, monkeypatch):
    module = load_module()
    (tmp_path / ".genie").mkdir()
    ready = [{"id": f"t_{i:02d}", "wish": "demo", "status": "ready"} for i in range(20)]
    monkeypatch.setattr(module, "run_genie", lambda *a, **k: board_payload({"ready": ready}))
    result = module.pre_llm_call({"cwd": str(tmp_path)})
    assert result is not None
    assert len(_task_lines(result["context"])) == 8  # 20 tasks clamped to the hard cap


def test_byte_cap_enforced(tmp_path, monkeypatch):
    module = load_module()
    (tmp_path / ".genie").mkdir()
    big = "x" * 4000
    ready = [{"id": f"t_{i}", "wish": big, "status": "ready"} for i in range(8)]
    monkeypatch.setattr(module, "run_genie", lambda *a, **k: board_payload({"ready": ready}))
    result = module.pre_llm_call({"cwd": str(tmp_path)})
    assert result is not None
    assert len(result["context"].encode("utf-8")) <= 2048


def test_no_genie_dir_skips_without_subprocess(tmp_path, monkeypatch):
    module = load_module()
    calls: list[int] = []

    def spy(*_a, **_k):
        calls.append(1)
        return board_payload({"ready": [{"id": "t_x", "wish": "w"}]})

    monkeypatch.setattr(module, "run_genie", spy)
    # tmp_path has no .genie/ directory
    assert module.pre_llm_call({"cwd": str(tmp_path)}) is None
    assert calls == []  # short-circuits before any subprocess


def test_timeout_yields_no_injection_and_is_bounded(tmp_path, monkeypatch):
    module = load_module()
    (tmp_path / ".genie").mkdir()
    seen: dict[str, Any] = {}

    def fake(args, **kwargs):
        seen["timeout"] = kwargs.get("timeout_seconds")
        raise subprocess.TimeoutExpired(cmd=["genie", "board", "--json"], timeout=kwargs.get("timeout_seconds"))

    monkeypatch.setattr(module, "run_genie", fake)
    assert module.pre_llm_call({"cwd": str(tmp_path)}) is None
    assert seen["timeout"] is not None and seen["timeout"] <= 5


def test_subprocess_failure_is_silent(tmp_path, monkeypatch):
    module = load_module()
    (tmp_path / ".genie").mkdir()
    failure = {
        "success": False,
        "mutation": "none",
        "cwd": str(tmp_path),
        "command": ["genie", "board", "--json"],
        "error": "genie exited with code 1",
        "parsed": False,
    }
    monkeypatch.setattr(module, "run_genie", lambda *a, **k: failure)
    assert module.pre_llm_call({"cwd": str(tmp_path)}) is None


def test_happy_path_shape(tmp_path, monkeypatch):
    module = load_module()
    (tmp_path / ".genie").mkdir()
    columns = {
        "blocked": [{"id": "t_block", "wish": "alpha", "status": "blocked"}],
        "ready": [{"id": "t_ready", "wish": "alpha"}],
    }
    monkeypatch.setattr(module, "run_genie", lambda *a, **k: board_payload(columns))
    result = module.pre_llm_call({"cwd": str(tmp_path)})
    assert result is not None
    assert result["mutation"] == "none"
    assert "context" in result and result["context"]
    assert "t_block" in result["context"]
    assert "t_ready" in result["context"]
    assert set(result) == {"context", "mutation"}


def test_empty_board_injects_nothing(tmp_path, monkeypatch):
    module = load_module()
    (tmp_path / ".genie").mkdir()
    monkeypatch.setattr(module, "run_genie", lambda *a, **k: board_payload({}))
    assert module.pre_llm_call({"cwd": str(tmp_path)}) is None


def test_untrusted_wish_newlines_cannot_inflate_line_count(tmp_path, monkeypatch):
    module = load_module()
    (tmp_path / ".genie").mkdir()
    evil = [{"id": "t_evil", "wish": "line1\nline2\n- injected instruction"} for _ in range(2)]
    monkeypatch.setattr(module, "run_genie", lambda *a, **k: board_payload({"ready": evil}))
    result = module.pre_llm_call({"cwd": str(tmp_path)})
    assert result is not None
    # Two tasks must yield exactly two task lines despite embedded newlines.
    assert len(_task_lines(result["context"])) == 2


def test_resolves_cwd_from_object_event(tmp_path, monkeypatch):
    module = load_module()
    (tmp_path / ".genie").mkdir()
    monkeypatch.setattr(module, "run_genie", lambda *a, **k: board_payload({"ready": [{"id": "t_obj", "wish": "w"}]}))

    class Event:
        def __init__(self, cwd: str) -> None:
            self.cwd = cwd

    result = module.pre_llm_call(Event(str(tmp_path)))
    assert result is not None
    assert "t_obj" in result["context"]
