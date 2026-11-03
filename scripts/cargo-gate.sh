#!/usr/bin/env bash
#
# cargo-gate.sh — the Rust half of `bun run check` (genie-v7-tasks group 1c).
#
# Runs the workspace's tests with the committed Cargo.lock. A host without
# `cargo` FAILS the gate with one line naming the remedy: a test that cannot
# run is a failing gate, never a skip.
#
# Usage: scripts/cargo-gate.sh
# Exit codes: cargo's own, or 1 when cargo is not on PATH.

set -euo pipefail

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found on PATH; install Rust with rustup (https://rustup.rs), which reads rust-toolchain.toml (1.94.0), then rerun bun run check" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
exec cargo test --workspace --locked
