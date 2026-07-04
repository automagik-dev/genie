"""Contract tests for the Hermes Genie plugin manifest and registration surface."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[3]
PLUGIN = ROOT / "plugins" / "hermes-genie"

TOOL_NAMES = [
    "genie_status",
    "genie_board",
    "genie_wish_status",
    "genie_task_list",
    "genie_task_status",
    "genie_work_plan",
    "genie_review_plan",
]


def load_plugin_module():
    spec = importlib.util.spec_from_file_location("hermes_genie_plugin", PLUGIN / "__init__.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
    data = yaml.safe_load((PLUGIN / "plugin.yaml").read_text(encoding="utf-8"))
    assert data["name"] == "genie"
    assert data["version"] == "0.1.0"
    for name in TOOL_NAMES:
        assert name in data["provides_tools"], f"manifest missing tool {name}"
    assert len(data["provides_tools"]) == 7
    assert "genie" in data["provides_commands"]
    assert "genie" in data["provides_skills"]
    assert "genie" in data["provides_cli_commands"]
    for hook in ["on_session_start", "pre_tool_call", "post_tool_call"]:
        assert hook in data["provides_hooks"]


def test_plugin_module_exports_register():
    module = load_plugin_module()
    assert callable(module.register)


def test_register_adds_read_only_tools():
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    for name in TOOL_NAMES:
        assert name in ctx.tools, f"tool {name} not registered"
        entry = ctx.tools[name]
        assert callable(entry["handler"])
        assert entry["toolset"] == "genie"
        assert entry["description"]
        assert entry["emoji"]
        schema = entry["schema"]
        assert schema["name"] == name
        assert schema["parameters"]["type"] == "object"
        assert isinstance(schema["parameters"]["properties"], dict)


def test_register_completes_with_tool_only_ctx():
    module = load_plugin_module()
    ctx = ToolOnlyCtx()
    module.register(ctx)  # must not touch register_command/hook/skill/cli
    assert sorted(ctx.tools) == sorted(TOOL_NAMES)


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


def test_wish_status_handler_payload_shape(tmp_path):
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    data = _invoke(ctx, "genie_wish_status", {"cwd": str(tmp_path), "slug": "no-such-wish"})
    assert "success" in data
    assert data["mutation"] == "none"
    assert data["cwd"] == str(Path(str(tmp_path)).resolve())
    assert "command" in data
    assert "board" in data["data"]
    assert "tasks" in data["data"]


def test_wish_status_requires_slug(tmp_path):
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
    data = _invoke(ctx, "genie_wish_status", {"cwd": str(tmp_path)})
    assert data["success"] is False
    assert data["mutation"] == "none"
    assert "slug" in data["error"]


def test_task_status_requires_id(tmp_path):
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
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


def test_remaining_tools_reject_invalid_refs(tmp_path):
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
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


def test_validation_error_payloads_carry_source(tmp_path):
    """Every input-validation early return must satisfy the command|source invariant."""
    module = load_plugin_module()
    ctx = FakeCtx()
    module.register(ctx)
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
