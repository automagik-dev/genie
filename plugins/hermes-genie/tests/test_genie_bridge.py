"""Tests for the safe Genie CLI subprocess bridge."""

from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PLUGIN = ROOT / "plugins" / "hermes-genie"


def load_bridge():
    spec = importlib.util.spec_from_file_location("genie_bridge", PLUGIN / "genie_bridge.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_build_argv_rejects_shell_metacharacters():
    bridge = load_bridge()
    for bad in [
        "board; rm -rf /",
        "a && b",
        "a || b",
        "`whoami`",
        "$(whoami)",
        "line\nbreak",
        "line\rbreak",
    ]:
        try:
            bridge.build_genie_argv([bad])
        except ValueError as exc:
            assert "unsafe" in str(exc).lower()
        else:
            raise AssertionError(f"expected unsafe argv to fail: {bad!r}")


def test_build_argv_returns_argument_array():
    bridge = load_bridge()
    assert bridge.build_genie_argv(["board", "--json"]) == ["genie", "board", "--json"]


def test_payload_has_required_fields():
    bridge = load_bridge()
    p = bridge.payload(
        success=True,
        mutation="none",
        cwd="/tmp/repo",
        command=["genie", "board"],
        data={"ok": True},
    )
    assert p["success"] is True
    assert p["mutation"] == "none"
    assert p["cwd"] == "/tmp/repo"
    assert p["command"] == ["genie", "board"]
    assert p["data"] == {"ok": True}
    assert "error" not in p
    assert "source" not in p


def test_payload_optional_error_and_source():
    bridge = load_bridge()
    p = bridge.payload(success=False, mutation="none", cwd="/tmp", error="boom", source="/tmp/WISH.md")
    assert p["error"] == "boom"
    assert p["source"] == "/tmp/WISH.md"


def test_run_genie_nonexistent_cwd_returns_error_payload():
    bridge = load_bridge()
    result = bridge.run_genie(["board", "--json"], cwd="/nonexistent/genie-bridge-test-dir")
    assert result["success"] is False
    assert result["mutation"] == "none"
    assert result["command"][0] == "genie"
    assert result["error"]
    assert result["parsed"] is False


def test_run_genie_bogus_subcommand_returns_failure(tmp_path):
    bridge = load_bridge()
    result = bridge.run_genie(["definitely-not-a-real-subcommand-xyz"], cwd=str(tmp_path))
    assert result["success"] is False
    assert result["mutation"] == "none"
    assert result["error"]


def test_run_genie_parses_json_stdout(tmp_path, monkeypatch):
    bridge = load_bridge()
    stub = tmp_path / "genie"
    stub.write_text('#!/bin/sh\necho \'{"ok": true, "items": [1, 2]}\'\n', encoding="utf-8")
    stub.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ.get('PATH', '')}")
    result = bridge.run_genie(["board", "--json"], cwd=str(tmp_path))
    assert result["success"] is True
    assert result["parsed"] is True
    assert result["data"] == {"ok": True, "items": [1, 2]}
    assert result["command"] == ["genie", "board", "--json"]


def test_run_genie_raw_capture_when_stdout_not_json(tmp_path, monkeypatch):
    bridge = load_bridge()
    stub = tmp_path / "genie"
    stub.write_text("#!/bin/sh\necho 'plain text plan output'\n", encoding="utf-8")
    stub.chmod(0o755)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ.get('PATH', '')}")
    result = bridge.run_genie(["launch", "some-wish", "--dry-run"], cwd=str(tmp_path))
    assert result["success"] is True
    assert result["parsed"] is False
    assert result["data"]["stdout"].strip() == "plain text plan output"
    assert result["data"]["returncode"] == 0
    assert "stderr" in result["data"]


def test_run_genie_rejects_unsafe_args_without_executing(tmp_path):
    bridge = load_bridge()
    result = bridge.run_genie(["board; rm -rf /"], cwd=str(tmp_path))
    assert result["success"] is False
    assert "unsafe" in result["error"].lower()


def test_validate_ref_accepts_valid_refs():
    bridge = load_bridge()
    for ok in ["hermes-khaw-native-surface", "t_mr6uarn6e8063de8", "a.b-c_d", "0plugin", "group-1", "in_progress"]:
        assert bridge.validate_ref(ok, "slug") == ok


def test_validate_ref_rejects_traversal_and_option_injection():
    bridge = load_bridge()
    for bad in ["../../x", "a/b", "a\\b", "--help", "-x", "a..b", "", "   ", "a;b", "a b", ".hidden"]:
        try:
            bridge.validate_ref(bad, "slug")
        except ValueError as exc:
            message = str(exc)
            assert "invalid" in message.lower()
            assert "slug" in message
        else:
            raise AssertionError(f"expected invalid ref to fail: {bad!r}")


def test_run_genie_passes_argv_list_and_no_shell_kwarg(tmp_path, monkeypatch):
    """The grep gate cannot catch a runtime regression: spy on subprocess.run kwargs."""
    bridge = load_bridge()
    calls: list[tuple] = []

    def spy(argv, **kwargs):
        calls.append((argv, kwargs))
        return subprocess.CompletedProcess(argv, 0, stdout='{"ok": true}', stderr="")

    monkeypatch.setattr(bridge.subprocess, "run", spy)
    result = bridge.run_genie(["board", "--json"], cwd=str(tmp_path))
    assert result["success"] is True
    assert len(calls) == 1
    argv, kwargs = calls[0]
    assert isinstance(argv, list)
    assert argv == ["genie", "board", "--json"]
    assert not kwargs.get("shell")  # shell kwarg must be absent or falsy
    assert kwargs.get("capture_output") is True
    assert kwargs.get("text") is True
    assert kwargs.get("check") is False
