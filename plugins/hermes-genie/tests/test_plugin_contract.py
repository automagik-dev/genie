"""Contract tests for the Hermes Genie plugin manifest and registration surface."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[3]
PLUGIN = ROOT / "plugins" / "hermes-genie"

# Default surface: exactly the three MCP gap tools.
GAP_TOOL_NAMES = [
    "genie_status",
    "genie_work_plan",
    "genie_review_plan",
]
# Legacy board/task tools — register only behind GENIE_HERMES_LEGACY_TOOLS=1.
LEGACY_TOOL_NAMES = [
    "genie_board",
    "genie_wish_status",
    "genie_task_list",
    "genie_task_status",
]
ALL_TOOL_NAMES = GAP_TOOL_NAMES + LEGACY_TOOL_NAMES


def _release_version() -> str:
    """The release version source of truth (root package.json)."""
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]


def load_plugin_module():
    spec = importlib.util.spec_from_file_location("hermes_genie_plugin", PLUGIN / "__init__.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _register_with_legacy(module, ctx, monkeypatch):
    """Register with the legacy board/task tools enabled (transition flag on)."""
    monkeypatch.setenv("GENIE_HERMES_LEGACY_TOOLS", "1")
    module.register(ctx)
    return ctx


class FakeCtx:
    """Recorder mirroring the Hermes v0.18 plugin context registration API."""

    def __init__(self) -> None:
        self.tools: dict[str, dict[str, Any]] = {}
        self.commands: dict[str, dict[str, Any]] = {}
        self.hooks: list[tuple[str, Any, dict[str, Any]]] = []
        self.skills: dict[str, tuple[tuple, dict[str, Any]]] = {}
        self.cli_commands: dict[str, dict[str, Any]] = {}

    def register_tool(self, **kwargs: Any) -> None:
        self.tools[kwargs["name"]] = kwargs

    def register_command(self, name: str, **kwargs: Any) -> None:
        self.commands[name] = kwargs

    def register_hook(self, event: str, handler: Any, **kwargs: Any) -> None:
        self.hooks.append((event, handler, kwargs))

    def register_skill(self, name: str, *args: Any, **kwargs: Any) -> None:
        self.skills[name] = (args, kwargs)

    def register_cli_command(self, **kwargs: Any) -> None:
        self.cli_commands[kwargs["name"]] = kwargs


class ToolOnlyCtx:
    """Minimal context exposing ONLY register_tool (no command/hook/skill/cli attrs)."""

    def __init__(self) -> None:
        self.tools: dict[str, dict[str, Any]] = {}

    def register_tool(self, **kwargs: Any) -> None:
        self.tools[kwargs["name"]] = kwargs


def test_plugin_manifest_declares_native_surface():
    raw = (PLUGIN / "plugin.yaml").read_text(encoding="utf-8")
    data = yaml.safe_load(raw)
    assert data["name"] == "genie"
    # Version pins to the release source of truth, never the placeholder 0.1.0.
    assert data["version"] != "0.1.0"
    assert data["version"] == _release_version()
    # Default surface declares exactly the three gap tools.
    assert data["provides_tools"] == GAP_TOOL_NAMES
    for legacy in LEGACY_TOOL_NAMES:
        assert legacy not in data["provides_tools"], f"legacy tool {legacy} must not be in default provides_tools"
    assert "genie" in data["provides_commands"]
    # Exactly one thin cockpit skill; the duplicates and the khaw bridge are gone.
    assert data["provides_skills"] == ["genie"]
    assert "genie-work" not in data["provides_skills"]
    assert "genie-review" not in data["provides_skills"]
    assert "genie-khaw-bridge" not in data["provides_skills"]
    assert "genie-khaw-bridge" not in raw
    assert "genie" in data["provides_cli_commands"]
    for hook in ["on_session_start", "pre_tool_call", "pre_llm_call"]:
        assert hook in data["provides_hooks"]
    assert "post_tool_call" not in data["provides_hooks"]


def test_plugin_module_exports_register():
    module = load_plugin_module()
    assert callable(module.register)


def test_register_adds_only_gap_tools_by_default(monkeypatch):
    monkeypatch.delenv("GENIE_HERMES_LEGACY_TOOLS", raising=False)
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    assert sorted(ctx.tools) == sorted(GAP_TOOL_NAMES)
    for legacy in LEGACY_TOOL_NAMES:
        assert legacy not in ctx.tools, f"legacy tool {legacy} must not register by default"
    for name in GAP_TOOL_NAMES:
        entry = ctx.tools[name]
        assert callable(entry["handler"])
        assert entry["toolset"] == "genie"
        assert entry["description"]
        assert entry["emoji"]
        schema = entry["schema"]
        assert schema["name"] == name
        assert schema["parameters"]["type"] == "object"
        assert isinstance(schema["parameters"]["properties"], dict)


def test_legacy_flag_restores_the_four_legacy_tools(monkeypatch):
    module = load_plugin_module()
    ctx = _register_with_legacy(module, FakeCtx(), monkeypatch)
    assert sorted(ctx.tools) == sorted(ALL_TOOL_NAMES)
    for name in ALL_TOOL_NAMES:
        entry = ctx.tools[name]
        assert callable(entry["handler"])
        assert entry["schema"]["name"] == name


def test_register_completes_with_tool_only_ctx(monkeypatch):
    monkeypatch.delenv("GENIE_HERMES_LEGACY_TOOLS", raising=False)
    module = load_plugin_module()
    ctx = ToolOnlyCtx()
    module.register(ctx)  # must not touch register_command/hook/skill/cli
    assert sorted(ctx.tools) == sorted(GAP_TOOL_NAMES)


def _invoke(ctx: FakeCtx, name: str, args: dict) -> dict[str, Any]:
    raw = ctx.tools[name]["handler"](args)
    assert isinstance(raw, str)
    return json.loads(raw)


def test_status_handler_payload_shape(tmp_path):
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    data = _invoke(ctx, "genie_status", {"cwd": str(tmp_path)})
    assert "success" in data
    assert data["mutation"] == "none"
    assert data["cwd"] == str(Path(str(tmp_path)).resolve())
    assert "command" in data
    assert data["data"]["genie_dir_present"] is False


def test_wish_status_handler_payload_shape(tmp_path, monkeypatch):
    module = load_plugin_module()
    ctx = _register_with_legacy(module, FakeCtx(), monkeypatch)
    data = _invoke(ctx, "genie_wish_status", {"cwd": str(tmp_path), "slug": "no-such-wish"})
    assert "success" in data
    assert data["mutation"] == "none"
    assert data["cwd"] == str(Path(str(tmp_path)).resolve())
    assert "command" in data
    assert "board" in data["data"]
    assert "tasks" in data["data"]


def test_wish_status_requires_slug(tmp_path, monkeypatch):
    module = load_plugin_module()
    ctx = _register_with_legacy(module, FakeCtx(), monkeypatch)
    data = _invoke(ctx, "genie_wish_status", {"cwd": str(tmp_path)})
    assert data["success"] is False
    assert data["mutation"] == "none"
    assert "slug" in data["error"]


def test_task_status_requires_id(tmp_path, monkeypatch):
    module = load_plugin_module()
    ctx = _register_with_legacy(module, FakeCtx(), monkeypatch)
    data = _invoke(ctx, "genie_task_status", {"cwd": str(tmp_path)})
    assert data["success"] is False
    assert "id" in data["error"]


def test_work_plan_rejects_unsafe_group_items(tmp_path):
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    data = _invoke(ctx, "genie_work_plan", {"cwd": str(tmp_path), "slug": "some-wish", "groups": ["ok", "bad;rm"]})
    assert data["success"] is False
    assert "invalid" in data["error"].lower()
    assert "bad;rm" in data["error"]
    assert data["source"] == "input-validation"


BAD_SLUGS = ["../../x", "a/b", "--help"]


def test_review_plan_rejects_traversal_and_dash_slugs(tmp_path):
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    for bad in BAD_SLUGS:
        data = _invoke(ctx, "genie_review_plan", {"cwd": str(tmp_path), "slug": bad})
        assert data["success"] is False, f"slug {bad!r} must be rejected"
        assert "invalid" in data["error"].lower()
        assert bad in data["error"]
        assert data["source"] == "input-validation"
        assert "data" not in data  # nothing executed, nothing read


def test_work_plan_rejects_traversal_and_dash_slugs(tmp_path):
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    for bad in BAD_SLUGS:
        data = _invoke(ctx, "genie_work_plan", {"cwd": str(tmp_path), "slug": bad})
        assert data["success"] is False, f"slug {bad!r} must be rejected"
        assert "invalid" in data["error"].lower()
        assert bad in data["error"]
        assert data["source"] == "input-validation"
        assert "data" not in data


def test_remaining_tools_reject_invalid_refs(tmp_path, monkeypatch):
    module = load_plugin_module()
    ctx = _register_with_legacy(module, FakeCtx(), monkeypatch)
    cases = [
        ("genie_wish_status", {"slug": "--help"}),
        ("genie_task_status", {"id": "../../x"}),
        ("genie_board", {"wish": "../../x"}),
        ("genie_task_list", {"wish": "a/b"}),
        ("genie_task_list", {"status": "--help"}),
        ("genie_work_plan", {"slug": "ok-wish", "groups": ["--help"]}),
    ]
    for name, extra in cases:
        data = _invoke(ctx, name, {"cwd": str(tmp_path), **extra})
        assert data["success"] is False, f"{name} with {extra} must be rejected"
        assert "invalid" in data["error"].lower()
        assert data["source"] == "input-validation"


def test_validation_error_payloads_carry_source(tmp_path, monkeypatch):
    """Every input-validation early return must satisfy the command|source invariant."""
    module = load_plugin_module()
    ctx = _register_with_legacy(module, FakeCtx(), monkeypatch)
    for name in ["genie_wish_status", "genie_task_status", "genie_work_plan", "genie_review_plan"]:
        data = _invoke(ctx, name, {"cwd": str(tmp_path)})  # missing required ref
        assert data["success"] is False
        assert data["mutation"] == "none"
        assert data["source"] == "input-validation"


def test_review_plan_blocks_symlink_escape(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "WISH.md").write_text(
        "# Secret\n\n## Success Criteria\n- secret leak marker\n",
        encoding="utf-8",
    )
    repo = tmp_path / "repo"
    wishes = repo / ".genie" / "wishes"
    wishes.mkdir(parents=True)
    (wishes / "evil").symlink_to(outside, target_is_directory=True)
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    data = _invoke(ctx, "genie_review_plan", {"cwd": str(repo), "slug": "evil"})
    assert data["data"]["criteria"]["success_criteria"] is None
    assert data["data"]["criteria"]["qa_criteria"] is None
    assert "escapes" in data["error"]
    assert "secret leak marker" not in json.dumps(data)


def test_review_plan_tolerates_missing_wish_file(tmp_path):
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    data = _invoke(ctx, "genie_review_plan", {"cwd": str(tmp_path), "slug": "no-such-wish"})
    assert data["mutation"] == "none"
    assert data["source"].endswith("WISH.md")
    assert "error" in data
    assert "not found" in data["error"]


def test_review_plan_extracts_criteria_sections(tmp_path):
    wish_dir = tmp_path / ".genie" / "wishes" / "demo-wish"
    wish_dir.mkdir(parents=True)
    (wish_dir / "WISH.md").write_text(
        "# Demo Wish\n\n"
        "## Scope\nstuff\n\n"
        "## Success Criteria\n- [ ] alpha works\n- [ ] beta works\n\n"
        "## QA Criteria\n- [ ] gamma verified\n\n"
        "## Notes\nignored\n",
        encoding="utf-8",
    )
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    data = _invoke(ctx, "genie_review_plan", {"cwd": str(tmp_path), "slug": "demo-wish"})
    criteria = data["data"]["criteria"]
    assert "alpha works" in criteria["success_criteria"]
    assert "beta works" in criteria["success_criteria"]
    assert "gamma verified" in criteria["qa_criteria"]
    assert "ignored" not in criteria["qa_criteria"]
    assert data["source"].endswith("WISH.md")


# --- Group 2: slash commands, advisory hooks, skills, CLI surface -----------

SLASH_COMMANDS = ["genie", "genie-board", "genie-wish", "genie-work-plan", "genie-review-plan"]
HOOK_EVENTS = ["on_session_start", "pre_tool_call", "pre_llm_call"]
# One thin cockpit skill only; the genie-work/genie-review duplicates and the
# genie-khaw-bridge skill left the payload.
SKILL_NAMES = ["genie"]
RETIRED_SKILL_NAMES = ["genie-work", "genie-review", "genie-khaw-bridge"]
BLOCKING_KEYS = {"block", "blocked", "deny", "denied", "decision", "stop", "abort", "error"}


def _hook_handlers(ctx: FakeCtx) -> dict[str, Any]:
    return {event: handler for event, handler, _kwargs in ctx.hooks}


def test_register_adds_slash_commands():
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    for name in SLASH_COMMANDS:
        assert name in ctx.commands, f"slash command {name} not registered"
        entry = ctx.commands[name]
        assert callable(entry["handler"])
        assert entry["description"]


def test_register_adds_advisory_hooks():
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    events = {event for event, _handler, _kwargs in ctx.hooks}
    for event in HOOK_EVENTS:
        assert event in events, f"hook {event} not registered"
    for _event, handler, _kwargs in ctx.hooks:
        assert callable(handler)


def test_register_adds_skills():
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    assert sorted(ctx.skills) == sorted(SKILL_NAMES)
    for name in SKILL_NAMES:
        assert name in ctx.skills, f"skill {name} not registered"
        args, kwargs = ctx.skills[name]
        skill_path = Path(str(args[0]))
        assert skill_path.name == "SKILL.md"
        assert skill_path.is_file()
        assert kwargs.get("description")
    for retired in RETIRED_SKILL_NAMES:
        assert retired not in ctx.skills, f"retired skill {retired} must not register"
        assert not (PLUGIN / "skills" / retired).exists(), f"retired skill dir {retired} must be deleted"


def test_register_adds_cli_command_when_supported():
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    assert "genie" in ctx.cli_commands
    entry = ctx.cli_commands["genie"]
    assert callable(entry["setup_fn"])
    assert callable(entry["handler_fn"])


def test_hooks_are_advisory_and_never_blocking(tmp_path):
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    handlers = _hook_handlers(ctx)

    genie_repo = tmp_path / "repo"
    (genie_repo / ".genie").mkdir(parents=True)
    started = handlers["on_session_start"]({"cwd": str(genie_repo)})
    assert started["mutation"] == "none"
    assert "genie_status" in started["message"]

    plain = tmp_path / "plain"
    plain.mkdir()
    bare = handlers["on_session_start"]({"cwd": str(plain)})
    assert bare == {"mutation": "none"}

    scrape = handlers["pre_tool_call"]({"command": "tmux capture-pane -t genie-worker -p"})
    assert scrape["mutation"] == "none"
    assert scrape["advice"]
    poll = handlers["pre_tool_call"]({"command": "sleep 5 && genie ls --json"})
    assert poll["mutation"] == "none"
    assert poll["advice"]
    normal = handlers["pre_tool_call"]({"command": "ls -la"})
    assert normal == {"mutation": "none"}

    # pre_llm_call injects nothing outside a .genie/ repo — None, never a block.
    injected = handlers["pre_llm_call"]({"cwd": str(plain)})
    assert injected is None

    for result in [started, bare, scrape, poll, normal]:
        assert result["mutation"] == "none"
        assert not (set(result) & BLOCKING_KEYS), f"blocking directive in {result}"
        assert set(result) <= {"message", "advice", "mutation", "context"}


def test_hooks_tolerate_missing_and_object_events(tmp_path):
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    handlers = _hook_handlers(ctx)
    for event in HOOK_EVENTS:
        result = handlers[event]()  # no event at all
        # pre_llm_call may return None (no injection); advisory hooks report "none".
        assert result is None or result["mutation"] == "none"

    class Event:
        def __init__(self, **fields: Any) -> None:
            for key, value in fields.items():
                setattr(self, key, value)

    genie_repo = tmp_path / "repo"
    (genie_repo / ".genie").mkdir(parents=True)
    started = handlers["on_session_start"](Event(cwd=str(genie_repo)))
    assert started["mutation"] == "none"
    assert "genie_board" in started["message"]
    scrape = handlers["pre_tool_call"](Event(command="tmux capture-pane -t w"))
    assert scrape["mutation"] == "none"
    assert scrape["advice"]


def test_skill_files_have_frontmatter_and_body():
    for name in SKILL_NAMES:
        path = PLUGIN / "skills" / name / "SKILL.md"
        assert path.is_file(), path
        text = path.read_text(encoding="utf-8")
        assert text.startswith("---"), f"{path} must start with --- at byte zero"
        head, body = text[3:].split("\n---\n", 1)
        assert "name:" in head and "description:" in head, path
        assert f"name: {name}" in head, path
        assert body.strip(), f"{path} has an empty body"
