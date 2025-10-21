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

# Offer to install permanently
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "💡 Want to install Genie permanently?"
echo "   Run: pnpm install -g automagik-genie@next"
echo ""
echo "   Then use 'genie' command from anywhere!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
