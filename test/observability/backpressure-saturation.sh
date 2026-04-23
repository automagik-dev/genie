#!/usr/bin/env bash
# Back-pressure saturation driver (WISH §Group 6 validation).
#
# Runs the bun test suite that saturates the emit queue at 20K ev/s-equivalent
# bursts for 10 seconds' worth of work. The tests themselves enforce the
# accept criteria — this script is the CI entry point.

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
cd "${HERE}/../.."

echo "==> bun test test/observability/backpressure.test.ts"
bun test test/observability/backpressure.test.ts

echo "==> watchdog isolation + config tests"
bun test packages/watchdog/test/

echo "Back-pressure saturation suite: PASS"
