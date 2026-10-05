#!/bin/sh
# Gate wrapper (wish rlmx-v2-prime-backend, Group 3): observe every
# prime-agent invocation's argv, then exec the real binary. The rlmx prime
# backend resolves its binary via RLMX_PRIME_BINARY_PATH (src/mcp/backends/
# prime.ts), so pointing it at this wrapper records the exact spawn argv the
# gate leg ran — including `--version` pin probes — while the real
# prime-agent 0.7.2 does the work. PRIME_ARGV_LOG must name the log file;
# PRIME_REAL_BINARY overrides the PATH lookup for the real binary.
: "${PRIME_ARGV_LOG:?PRIME_ARGV_LOG must name the argv log file}"
printf '%s\n' "$*" >> "$PRIME_ARGV_LOG"
exec "${PRIME_REAL_BINARY:-$(command -v prime-agent)}" "$@"
