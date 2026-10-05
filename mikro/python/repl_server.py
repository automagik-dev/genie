#!/usr/bin/env python3
"""
Python REPL server for mikro.

Reads JSON commands from stdin, executes code in a persistent namespace
with safe builtins, and writes JSON results to stdout.

IPC protocol:
  Node -> Python (stdin):
    {"type": "execute", "code": "..."}
    {"type": "llm_response", "results": ["..."]}  (during execution)
    {"type": "tool_response", "ok": true, "result": ...}  (during execution)
    {"type": "inject", "name": "...", "value": "...", "value_type": "str|list|dict"}
    {"type": "reset"}
    {"type": "shutdown"}

  Python -> Node (stdout):
    {"type": "execute_result", "stdout": "...", "stderr": "...", "variables": [...], ...}
    {"type": "llm_request", "request_type": "...", "prompts": [...], "model": "..."}
    {"type": "tool_request", "tool": "...", "args": {...}}
    {"type": "ready"}
"""

import io
import json
import os
import sys
import traceback

# Import the LLM bridge — lives alongside this file
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import llm_bridge

# Maximum stdout capture length (faithful to RLM paper)
MAX_STDOUT_CHARS = 20_000

# Reserved names that cannot be overwritten by user code
RESERVED_NAMES = frozenset({
    "context", "llm_query", "rlm_query", "llm_query_batched",
    "rlm_query_batched", "FINAL_VAR", "FINAL", "SHOW_VARS", "call_tool",
})

# Blocked builtins
_BLOCKED_BUILTINS = {"eval", "exec", "input", "compile", "globals", "locals"}


def _make_blocked(name):
    """Create a function that raises an error when called."""
    def blocked(*args, **kwargs):
        raise RuntimeError(f"'{name}' is blocked in the REPL sandbox for safety")
    blocked.__name__ = name
    return blocked


def _build_safe_builtins():
    """Build safe builtins dict: all standard builtins minus blocked ones."""
    import builtins
    safe = {}
    for name in dir(builtins):
        if name.startswith("_"):
            # Keep __import__, __name__, etc.
            safe[name] = getattr(builtins, name)
        elif name in _BLOCKED_BUILTINS:
            safe[name] = _make_blocked(name)
        else:
            safe[name] = getattr(builtins, name)
    return safe


class REPLServer:
    """Persistent Python REPL with safe builtins and IPC."""

    def __init__(self):
        self._real_stdin = sys.stdin
        self._real_stdout = sys.stdout
        self._real_stderr = sys.stderr

        self._safe_builtins = _build_safe_builtins()
        self._last_final = None  # stores {"type": "var"|"inline", "value": "..."}

        # Persistent namespace
        self._globals = {
            "__builtins__": self._safe_builtins,
            "__name__": "__main__",
        }
        self._locals = {}

        # Inject REPL helper functions into globals
        self._globals["FINAL_VAR"] = self._final_var
        self._globals["FINAL"] = self._final_inline
        self._globals["SHOW_VARS"] = self._show_vars
        self._globals["llm_query"] = llm_bridge.llm_query
        self._globals["llm_query_batched"] = llm_bridge.llm_query_batched
        self._globals["rlm_query"] = llm_bridge.rlm_query
        self._globals["rlm_query_batched"] = llm_bridge.rlm_query_batched
        self._globals["call_tool"] = llm_bridge.call_tool

    def _final_var(self, variable_name):
        """Signal completion by returning the value of a named variable."""
        if not isinstance(variable_name, str):
            # Direct value passed
            answer = str(variable_name)
            self._last_final = {"type": "var", "value": answer}
            return answer

        variable_name = variable_name.strip().strip("\"'")
        if variable_name in self._locals:
            answer = str(self._locals[variable_name])
            self._last_final = {"type": "var", "value": answer}
            return answer

        available = [k for k in self._locals if not k.startswith("_")]
        if available:
            return (
                f"Error: Variable '{variable_name}' not found. "
                f"Available variables: {available}. "
                f"Create and assign the variable in a repl block BEFORE calling FINAL_VAR."
            )
        return (
            f"Error: Variable '{variable_name}' not found. "
            f"No variables created yet. Create a variable in a repl block first."
        )

    def _final_inline(self, answer):
        """Signal completion with an inline answer."""
        answer_str = str(answer)
        self._last_final = {"type": "inline", "value": answer_str}
        return answer_str

    def _show_vars(self):
        """Return list of user-created variables."""
        available = {
            k: type(v).__name__
            for k, v in self._locals.items()
            if not k.startswith("_")
        }
        if not available:
            return "No variables created yet."
        return f"Available variables: {available}"

    def _get_user_variables(self):
        """Get list of user-created variable names."""
        return [k for k in self._locals if not k.startswith("_")]

    def _restore_reserved(self):
        """Restore reserved names after execution to prevent namespace corruption."""
        self._globals["FINAL_VAR"] = self._final_var
        self._globals["FINAL"] = self._final_inline
        self._globals["SHOW_VARS"] = self._show_vars
        self._globals["llm_query"] = llm_bridge.llm_query
        self._globals["llm_query_batched"] = llm_bridge.llm_query_batched
        self._globals["rlm_query"] = llm_bridge.rlm_query
        self._globals["rlm_query_batched"] = llm_bridge.rlm_query_batched
        self._globals["call_tool"] = llm_bridge.call_tool

        # Restore context if it was overwritten
        if "context" in self._locals and "context_0" in self._locals:
            self._locals["context"] = self._locals["context_0"]

    def _execute(self, code):
        """Execute code in the persistent namespace, capturing output."""
        self._last_final = None

        # Set up IPC channels for llm_bridge
        llm_bridge._ipc_out = self._real_stdout
        llm_bridge._ipc_in = self._real_stdin

        # Capture stdout/stderr during execution
        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        sys.stdout = stdout_buf
        sys.stderr = stderr_buf

        error = None
        try:
            combined = {**self._globals, **self._locals}
            exec(code, combined, combined)  # noqa: S102 — sandboxed exec

            # Extract new/updated local variables
            for key, value in combined.items():
                if key not in self._globals and not key.startswith("_"):
                    self._locals[key] = value

            # Restore reserved names
            self._restore_reserved()
        except Exception:
            error = traceback.format_exc()
        finally:
            sys.stdout = self._real_stdout
            sys.stderr = self._real_stderr

        stdout_text = stdout_buf.getvalue()
        stderr_text = stderr_buf.getvalue()
        if error:
            stderr_text = (stderr_text + "\n" + error).strip()

        # Truncate stdout to MAX_STDOUT_CHARS
        if len(stdout_text) > MAX_STDOUT_CHARS:
            stdout_text = stdout_text[:MAX_STDOUT_CHARS] + f"\n... [truncated to {MAX_STDOUT_CHARS} chars]"

        result = {
            "type": "execute_result",
            "stdout": stdout_text,
            "stderr": stderr_text,
            "variables": self._get_user_variables(),
        }

        if self._last_final is not None:
            result["final"] = self._last_final

        if error:
            result["error"] = error

        return result

    def _inject(self, name, value, value_type):
        """Inject a variable into the REPL namespace."""
        if value_type == "list":
            parsed = json.loads(value)
        elif value_type == "dict":
            parsed = json.loads(value)
        else:
            parsed = value

        self._locals[name] = parsed

        # Alias context_0 as context
        if name == "context_0":
            self._locals["context"] = parsed

    def _reset(self):
        """Reset the namespace to initial state."""
        self._locals.clear()
        self._last_final = None

    def _send(self, msg):
        """Send a JSON message to stdout (Node.js parent)."""
        self._real_stdout.write(json.dumps(msg) + "\n")
        self._real_stdout.flush()

    def run(self):
        """Main event loop: read commands from stdin, dispatch, respond."""
        self._send({"type": "ready"})

        for line in self._real_stdin:
            line = line.strip()
            if not line:
                continue

            try:
                cmd = json.loads(line)
            except json.JSONDecodeError:
                self._send({
                    "type": "execute_result",
                    "stdout": "",
                    "stderr": f"Invalid JSON command: {line}",
                    "variables": self._get_user_variables(),
                    "error": f"Invalid JSON: {line}",
                })
                continue

            cmd_type = cmd.get("type")

            if cmd_type == "execute":
                result = self._execute(cmd.get("code", ""))
                self._send(result)

            elif cmd_type == "inject":
                self._inject(
                    cmd.get("name", ""),
                    cmd.get("value", ""),
                    cmd.get("value_type", "str"),
                )
                self._send({
                    "type": "execute_result",
                    "stdout": "",
                    "stderr": "",
                    "variables": self._get_user_variables(),
                })

            elif cmd_type == "reset":
                self._reset()
                self._send({
                    "type": "execute_result",
                    "stdout": "",
                    "stderr": "",
                    "variables": [],
                })

            elif cmd_type == "shutdown":
                break

            # llm_response and tool_response are handled inline by llm_bridge
            # during execution, so we don't process them here in the main loop


if __name__ == "__main__":
    server = REPLServer()
    server.run()
