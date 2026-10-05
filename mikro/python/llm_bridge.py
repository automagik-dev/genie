"""
LLM call bridge for the Python REPL subprocess.

Provides llm_query(), llm_query_batched(), rlm_query(), rlm_query_batched()
functions that communicate with the Node.js parent process via IPC.

During code execution, sys.stdout is captured for print() output.
LLM bridge functions use _ipc_out (the real stdout) to send requests
and _ipc_in (the real stdin) to receive responses.
"""

import json
import sys
import threading

# IPC channels — set by repl_server.py before code execution
_ipc_out = None  # real stdout for sending JSON to Node.js
_ipc_in = None   # real stdin for receiving JSON from Node.js
_ipc_lock = threading.Lock()


def call_tool(name, kwargs):
    """Call a Node-owned tool and return its JSON-round-tripped result."""
    if _ipc_out is None or _ipc_in is None:
        raise RuntimeError("IPC not initialized")

    msg = {
        "type": "tool_request",
        "tool": name,
        "args": kwargs,
    }

    with _ipc_lock:
        try:
            _ipc_out.write(json.dumps(msg) + "\n")
            _ipc_out.flush()
            line = _ipc_in.readline()
        except Exception as error:
            raise RuntimeError(f"Tool IPC failed: {error}") from error

        if not line:
            raise RuntimeError("Tool IPC connection closed")

        try:
            response = json.loads(line.strip())
        except json.JSONDecodeError as error:
            raise RuntimeError(f"Invalid tool response JSON: {error}") from error

        if response.get("type") != "tool_response":
            raise RuntimeError(
                f"Unexpected tool response type: {response.get('type')}"
            )
        if not response.get("ok"):
            raise RuntimeError(str(response.get("error", "Tool call failed")))
        return response.get("result")


def _send_request(request_type: str, prompts: list, model=None) -> list:
    """Send an LLM request to the parent Node.js process and block for response."""
    if _ipc_out is None or _ipc_in is None:
        return ["Error: IPC not initialized"] * len(prompts)

    msg = {
        "type": "llm_request",
        "request_type": request_type,
        "prompts": prompts,
    }
    if model is not None:
        msg["model"] = model

    with _ipc_lock:
        _ipc_out.write(json.dumps(msg) + "\n")
        _ipc_out.flush()

        # Block until we get an llm_response
        line = _ipc_in.readline()
        if not line:
            return ["Error: IPC connection closed"] * len(prompts)

        try:
            response = json.loads(line.strip())
            if response.get("type") == "llm_response":
                return response.get("results", [])
            return [f"Error: unexpected response type: {response.get('type')}"] * len(prompts)
        except json.JSONDecodeError as e:
            return [f"Error: invalid JSON response: {e}"] * len(prompts)


def send_request(request_type: str, prompts: list, model=None) -> list:
    """Public interface for sending IPC requests to Node.js parent process."""
    return _send_request(request_type, prompts, model)


def llm_query(prompt: str, model=None) -> str:
    """Query the LLM with a single prompt. Returns the response string."""
    results = _send_request("llm_query", [prompt], model)
    return results[0] if results else "Error: no response"


def llm_query_batched(prompts: list, model=None) -> list:
    """Query the LLM with multiple prompts concurrently. Returns list of responses."""
    if not prompts:
        return []
    return _send_request("llm_query_batched", prompts, model)


def rlm_query(prompt: str, model=None) -> str:
    """Spawn a recursive RLM sub-call for deeper thinking. Returns the response string."""
    results = _send_request("rlm_query", [prompt], model)
    return results[0] if results else "Error: no response"


def rlm_query_batched(prompts: list, model=None) -> list:
    """Spawn multiple recursive RLM sub-calls. Returns list of responses."""
    if not prompts:
        return []
    return _send_request("rlm_query_batched", prompts, model)
