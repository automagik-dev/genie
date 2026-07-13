"""Tests for the Hermes Genie slash-command and CLI dispatch surface."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
PLUGIN = ROOT / "plugins" / "hermes-genie"


def load_commands():
    spec = importlib.util.spec_from_file_location("genie_commands", PLUGIN / "commands.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _stub(payload: dict[str, Any]):
    def handler(args: dict, **kwargs: Any) -> str:
        return json.dumps(payload)

    return handler


def test_genie_help_lists_subcommands():
    commands = load_commands()
    text = commands.slash_genie("help")
    assert "/genie status" in text
    assert "/genie board" in text
    assert "/genie wish" in text
    assert "/genie work-plan" in text
    assert "/genie review-plan" in text
    assert "/genie help" in text


def test_genie_empty_args_shows_help():
    commands = load_commands()
    assert commands.slash_genie("") == commands.slash_genie("help")
    assert commands.slash_genie() == commands.slash_genie("help")


def test_genie_unknown_subcommand_is_clear():
    commands = load_commands()
    text = commands.slash_genie("wat")
    assert "Unknown" in text
    assert "/genie help" in text


def test_genie_status_output_is_outcome_first(monkeypatch):
    commands = load_commands()
    payload = {
        "success": True,
        "mutation": "none",
        "cwd": "/repo",
        "command": ["genie", "doctor", "--json"],
        "data": {"doctor": {"ok": True}, "genie_dir": "/repo/.genie", "genie_dir_present": True},
    }
    monkeypatch.setattr(commands, "_genie_status", _stub(payload))
    text = commands.slash_genie("status")
    lines = text.splitlines()
    assert lines[0].startswith("OK")  # outcome first
    assert ".genie directory: present" in text
    assert any(line.startswith("evidence:") and "genie doctor --json" in line for line in lines)


def test_genie_error_output_leads_with_error(monkeypatch):
    commands = load_commands()
    payload = {
        "success": False,
        "mutation": "none",
        "cwd": "/repo",
        "command": ["genie", "doctor", "--json"],
        "error": "genie exited with code 7",
    }
    monkeypatch.setattr(commands, "_genie_status", _stub(payload))
    lines = commands.slash_genie("status").splitlines()
    assert lines[0].startswith("Error")
    assert "genie exited with code 7" in lines[0]  # error leads
    assert any(line.startswith("evidence:") and "genie doctor --json" in line for line in lines)


def test_genie_board_passes_wish_scope(monkeypatch):
    commands = load_commands()
    captured: dict[str, Any] = {}

    def fake_board(args: dict, **kwargs: Any) -> str:
        captured.update(args)
        return json.dumps(
            {
                "success": True,
                "mutation": "none",
                "cwd": "/repo",
                "command": ["genie", "board", "--json", "--wish", "demo"],
                "data": [{"id": 1}, {"id": 2}],
            }
        )

    monkeypatch.setattr(commands, "_genie_board", fake_board)
    text = commands.slash_genie("board demo")
    assert captured["wish"] == "demo"
    assert text.splitlines()[0].startswith("OK")
    assert "items: 2" in text


def test_board_prefers_mcp_tool_when_context_available(monkeypatch):
    commands = load_commands()

    def legacy_bridge(args: dict, **kwargs: Any) -> str:
        raise AssertionError("legacy bridge used despite an MCP-capable context")

    monkeypatch.setattr(commands, "_genie_board", legacy_bridge)
    calls: list[tuple[str, dict[str, Any]]] = []

    class Ctx:
        def call_tool(self, name: str, args: dict[str, Any]) -> str:
            calls.append((name, dict(args)))
            return json.dumps(
                {
                    "success": True,
                    "mutation": "none",
                    "cwd": "/repo",
                    "command": ["genie", "board", "--json", "--wish", "demo"],
                    "data": [{"id": 1}],
                }
            )

    text = commands.slash_genie("board demo", context=Ctx())
    assert calls and calls[0][0] == "genie_board"
    assert calls[0][1].get("wish") == "demo"
    assert text.splitlines()[0].startswith("OK")


def test_board_falls_back_to_legacy_bridge_when_mcp_call_fails(monkeypatch):
    commands = load_commands()
    used_bridge: list[bool] = []

    def legacy_bridge(args: dict, **kwargs: Any) -> str:
        used_bridge.append(True)
        return json.dumps(
            {
                "success": True,
                "mutation": "none",
                "cwd": "/repo",
                "command": ["genie", "board", "--json"],
                "data": [],
            }
        )

    monkeypatch.setattr(commands, "_genie_board", legacy_bridge)

    class Ctx:
        def call_tool(self, name: str, args: dict[str, Any]) -> str:
            raise RuntimeError("mcp unavailable")

    text = commands.slash_genie("board", context=Ctx())
    assert used_bridge == [True]  # degraded to the legacy bridge
    assert text.splitlines()[0].startswith("OK")


def test_genie_wish_requires_slug():
    commands = load_commands()
    text = commands.slash_genie("wish")
    assert text.startswith("Error")
    assert "/genie wish <slug>" in text
    assert "/genie help" in text


def test_genie_work_plan_parses_groups(monkeypatch):
    commands = load_commands()
    captured: dict[str, Any] = {}

    def fake_work_plan(args: dict, **kwargs: Any) -> str:
        captured.update(args)
        return json.dumps(
            {
                "success": True,
                "mutation": "none",
                "cwd": "/repo",
                "command": ["genie", "launch", "demo", "--dry-run", "--groups", "a,b"],
                "data": {"stdout": "plan line 1\nplan line 2\n", "stderr": "", "returncode": 0},
            }
        )

    monkeypatch.setattr(commands, "_genie_work_plan", fake_work_plan)
    text = commands.slash_genie("work-plan demo a,b")
    assert captured["slug"] == "demo"
    assert captured["groups"] == ["a", "b"]
    assert text.splitlines()[0].startswith("OK")
    assert "dry-run" in text
    assert "genie launch demo --dry-run --groups a,b" in text


def test_wrappers_delegate_to_dispatcher(monkeypatch):
    commands = load_commands()
    seen: list[str] = []

    def fake_dispatch(args_text: str = "", **kwargs: Any) -> str:
        seen.append(args_text)
        return "ok"

    monkeypatch.setattr(commands, "slash_genie", fake_dispatch)
    assert commands.slash_genie_board("demo") == "ok"
    assert commands.slash_genie_wish("demo") == "ok"
    assert commands.slash_genie_work_plan("demo a,b") == "ok"
    assert commands.slash_genie_review_plan("demo") == "ok"
    assert seen == ["board demo", "wish demo", "work-plan demo a,b", "review-plan demo"]


def test_setup_cli_builds_subcommand_tree():
    commands = load_commands()
    parser = argparse.ArgumentParser(prog="hermes genie")
    commands.setup_cli(parser)
    args = parser.parse_args(["wish", "demo-slug"])
    assert args.genie_command == "wish"
    assert args.slug == "demo-slug"
    assert callable(args.func)
    for argv in [
        ["status"],
        ["board"],
        ["board", "demo"],
        ["work-plan", "demo"],
        ["work-plan", "demo", "a,b"],
        ["review-plan", "demo"],
    ]:
        parsed = parser.parse_args(argv)
        assert parsed.genie_command == argv[0]


def test_cli_handler_routes_through_dispatcher(monkeypatch, capsys):
    commands = load_commands()
    payload = {
        "success": True,
        "mutation": "none",
        "cwd": "/repo",
        "command": ["genie", "doctor", "--json"],
        "data": {"doctor": None, "genie_dir": "/repo/.genie", "genie_dir_present": False},
    }
    monkeypatch.setattr(commands, "_genie_status", _stub(payload))
    parser = argparse.ArgumentParser(prog="hermes genie")
    commands.setup_cli(parser)
    args = parser.parse_args(["status"])
    args.func(args)
    out = capsys.readouterr().out
    assert out.splitlines()[0].startswith("OK")
    assert "genie doctor --json" in out
