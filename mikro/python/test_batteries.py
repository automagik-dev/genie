"""Tests for batteries.run_cli; run with python3 -m unittest python/test_batteries.py."""

import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from batteries import run_cli  # noqa: E402


class RunCliTest(unittest.TestCase):
    def test_runs_directly_with_literal_arguments(self) -> None:
        args = ["hello world", "; echo injected", "$(echo injected)"]
        result = run_cli(
            sys.executable, "-c", "import json, sys; print(json.dumps(sys.argv[1:]))", *args
        )
        self.assertEqual(result, {
            "returncode": 0,
            "stdout": json.dumps(args) + "\n",
            "stderr": "",
        })

    def test_legacy_environment_does_not_rewrite_command(self) -> None:
        with patch.dict("os.environ", {"_MIKRO_RTK_MODE": "on"}):
            result = run_cli(sys.executable, "-c", "print('direct')")
        self.assertEqual(result, {"returncode": 0, "stdout": "direct\n", "stderr": ""})

    def test_preserves_stdin_stdout_stderr_and_exit_code(self) -> None:
        result = run_cli(
            sys.executable, "-c",
            "import sys; print(sys.stdin.read(), end=''); print('failure', file=sys.stderr); sys.exit(7)",
            input="input text\n",
        )
        self.assertEqual(result, {
            "returncode": 7, "stdout": "input text\n", "stderr": "failure\n",
        })

    def test_check_raises_with_captured_output(self) -> None:
        with self.assertRaises(subprocess.CalledProcessError) as caught:
            run_cli(
                sys.executable, "-c",
                "import sys; print('out'); print('err', file=sys.stderr); sys.exit(3)",
                check=True,
            )
        self.assertEqual(caught.exception.returncode, 3)
        self.assertEqual(caught.exception.stdout, "out\n")
        self.assertEqual(caught.exception.stderr, "err\n")
        self.assertEqual(caught.exception.cmd[0], sys.executable)

    def test_timeout_returns_safe_dict(self) -> None:
        result = run_cli(sys.executable, "-c", "import time; time.sleep(2)", timeout=0.1)
        self.assertEqual(set(result), {"returncode", "stdout", "stderr"})
        self.assertEqual(result["returncode"], -1)
        self.assertEqual(result["stdout"], "")
        self.assertIn("timeout", result["stderr"].lower())

    def test_missing_command_returns_safe_dict(self) -> None:
        result = run_cli("definitely-not-a-real-binary-xyz")
        self.assertEqual(set(result), {"returncode", "stdout", "stderr"})
        self.assertEqual(result["returncode"], -1)
        self.assertEqual(result["stdout"], "")
        self.assertIn("not found", result["stderr"].lower())


if __name__ == "__main__":
    unittest.main()
