#!/usr/bin/env bash

# Genie Quick Run Script
# Run Genie without installing (uses pnpm dlx)

set -e

echo "🧞 Genie Quick Run"
echo "=================="
echo ""
echo "Running Genie via pnpm dlx (no installation)..."
echo ""

# Run Genie using pnpm dlx (no install)
pnpm dlx automagik-genie@next
